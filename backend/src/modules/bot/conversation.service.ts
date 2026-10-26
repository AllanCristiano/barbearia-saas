import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TenantStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BLOCKED_STATUSES } from '../../common/auth/subscription.guard';
import { CustomersService } from '../customers/customers.service';
import { AppointmentsService } from '../scheduling/appointments.service';
import { Messages } from '../scheduling/messages';
import { normalizeText } from '../scheduling/offer-reply';
import { OffersService } from '../scheduling/offers.service';
import { MessagingService } from '../whatsapp/messaging.service';
import { InboundJob } from '../whatsapp/queues';
import { BotState, MenuBotService } from './menu-bot.service';

const OPT_OUT = ['sair', 'parar', 'stop', 'descadastrar', 'cancelar promocoes'];
const OPT_IN = ['receber promocoes', 'quero receber promocoes'];
const CONFIRM = ['confirmar', 'confirmo', 'confirmado', 'vou sim', 'estarei la'];

/** Depois deste tempo sem interação o atendimento humano é encerrado e a IA volta. */
export const HUMAN_TAKEOVER_HOURS = 6;

/**
 * Orquestra cada mensagem recebida no WhatsApp:
 *   1. cadastra o cliente automaticamente
 *   2. comandos fixos (SAIR / VOLTAR / CONFIRMAR)
 *   3. respostas a propostas pendentes (adiantar / remarcar)
 *   4. demais mensagens → bot de menu numerado
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  /** Serializa mensagens do mesmo cliente (evita respostas fora de ordem). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly offers: OffersService,
    private readonly appointments: AppointmentsService,
    private readonly messaging: MessagingService,
    private readonly bot: MenuBotService,
  ) {}

  handleInbound(job: InboundJob): Promise<void> {
    const key = `${job.tenantId}:${job.phone}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.process(job));
    this.locks.set(key, current);
    return current.finally(() => {
      if (this.locks.get(key) === current) this.locks.delete(key);
    });
  }

  private async process(job: InboundJob, now = new Date()): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: job.tenantId } });
    if (!tenant) return;

    const customer = await this.customers.findOrCreateByPhone(tenant.id, job.phone, job.pushName);
    await this.messaging.logInbound(tenant.id, job.phone, job.text, customer.id, job.messageId);
    if (customer.blocked) return;

    const send = (body: string) => this.messaging.send(tenant.id, customer.phone, body, { customerId: customer.id });

    if (BLOCKED_STATUSES.includes(tenant.status as TenantStatus)) {
      await send(Messages.shopUnavailable());
      return;
    }

    const text = normalizeText(job.text);
    if (OPT_OUT.includes(text)) {
      await this.customers.setMarketingOptIn(customer.id, false);
      await send(Messages.optOut());
      return;
    }
    if (OPT_IN.includes(text)) {
      await this.customers.setMarketingOptIn(customer.id, true);
      await send(Messages.optIn());
      return;
    }

    if (await this.offers.handleReply(tenant.id, customer.id, job.text, now)) return;

    if (CONFIRM.includes(text)) {
      const confirmed = await this.appointments.confirmByCustomer(tenant.id, customer.id, now);
      if (confirmed) {
        await send(
          Messages.confirmedByCustomer(
            { customerName: customer.name, serviceName: confirmed.service.name, barberName: confirmed.barber.name, startsAt: confirmed.startsAt },
            tenant.timezone,
          ),
        );
        return;
      }
    }

    const conversation = await this.prisma.conversation.upsert({
      where: { customerId: customer.id },
      create: { tenantId: tenant.id, customerId: customer.id },
      update: {},
    });
    if (conversation.humanTakeover) {
      const idleHours = (now.getTime() - conversation.updatedAt.getTime()) / 3600_000;
      if (idleHours < HUMAN_TAKEOVER_HOURS) return; // um humano está atendendo
      await this.prisma.conversation.update({ where: { id: conversation.id }, data: { humanTakeover: false } });
    }
    if (!tenant.botEnabled) return;

    try {
      const state = (conversation.state as unknown as BotState) ?? {};
      const result = await this.bot.handle({ tenant, customer }, job.text, state, now);
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { state: result.state as unknown as Prisma.InputJsonValue },
      });
      await send(result.reply);
    } catch (err) {
      this.logger.error(`Bot falhou para ${tenant.slug}/${customer.id}: ${(err as Error).message}`);
      await send(Messages.botFallback());
    }
  }
}
