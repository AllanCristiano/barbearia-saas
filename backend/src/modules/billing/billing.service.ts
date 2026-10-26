import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentMethod, Subscription, SubscriptionStatus, TenantStatus } from '@prisma/client';
import { addMonths } from 'date-fns';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Push } from '../notifications/push-messages';
import { PushService } from '../notifications/push.service';

/** Dias antes do vencimento em que o dono recebe o lembrete de pagamento. */
export const REMINDER_DAYS_BEFORE = 3;

/**
 * Cobrança da plataforma (barbearia → você) em modo MANUAL, sem gateway:
 *  - o dono vê no app o valor, o vencimento e a sua chave PIX/instruções;
 *  - você confirma o recebimento no painel de admin (POST /admin/tenants/:id/payments),
 *    o que estende a assinatura e reativa a barbearia;
 *  - a rotina diária marca inadimplência e suspende após a carência.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly priceCents: number;
  private readonly graceDays: number;
  private readonly pixKey: string | null;
  private readonly instructions: string | null;
  private readonly contact: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    config: ConfigService,
  ) {
    this.priceCents = Number(config.get('PLATFORM_PRICE_CENTS', 20000));
    this.graceDays = Number(config.get('GRACE_DAYS', 3));
    this.pixKey = config.get<string>('PLATFORM_PIX_KEY') || null;
    this.instructions = config.get<string>('PLATFORM_PAYMENT_INSTRUCTIONS') || null;
    this.contact = config.get<string>('PLATFORM_CONTACT') || null;
  }

  /** Tela de assinatura do dono. */
  async getStatus(tenantId: string) {
    const subscription = await this.getSubscription(tenantId);
    const [tenant, payments] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { status: true, trialEndsAt: true } }),
      this.prisma.payment.findMany({ where: { tenantId }, orderBy: { paidAt: 'desc' }, take: 12 }),
    ]);
    return {
      tenantStatus: tenant.status,
      trialEndsAt: tenant.trialEndsAt,
      subscription: {
        status: subscription.status,
        amountCents: subscription.amountCents,
        currentPeriodEnd: subscription.currentPeriodEnd,
      },
      howToPay: { pixKey: this.pixKey, instructions: this.instructions, contact: this.contact },
      payments,
    };
  }

  /**
   * Registra um pagamento recebido (SUPER_ADMIN) e estende a assinatura em `months` meses
   * a partir do vencimento atual (ou de hoje, se já venceu). Reativa a barbearia.
   */
  async recordPayment(
    tenantId: string,
    input: { method: PaymentMethod; months?: number; amountCents?: number; notes?: string },
    now = new Date(),
  ) {
    const months = input.months ?? 1;
    const subscription = await this.getSubscription(tenantId);
    const base = subscription.currentPeriodEnd && subscription.currentPeriodEnd > now ? subscription.currentPeriodEnd : now;
    const currentPeriodEnd = addMonths(base, months);

    const [payment] = await this.prisma.$transaction([
      this.prisma.payment.create({
        data: {
          tenantId,
          subscriptionId: subscription.id,
          method: input.method,
          months,
          amountCents: input.amountCents ?? subscription.amountCents * months,
          notes: input.notes,
          paidAt: now,
        },
      }),
      this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: SubscriptionStatus.ACTIVE, currentPeriodEnd },
      }),
      this.prisma.tenant.update({ where: { id: tenantId }, data: { status: TenantStatus.ACTIVE } }),
    ]);

    await this.push.notifyOwners(tenantId, Push.billing('💳 PAGAMENTO CONFIRMADO', `Obrigado! Sua assinatura está ativa até ${currentPeriodEnd.toLocaleDateString('pt-BR')}.`));
    return { payment, currentPeriodEnd };
  }

  /**
   * Rotina diária: lembra o vencimento próximo, marca inadimplência quando o período
   * (ou teste) acaba e suspende após a carência.
   */
  async runDailyBilling(now = new Date()): Promise<Record<string, number>> {
    const stats = { reminded: 0, pastDue: 0, suspended: 0 };

    const dueSoon = await this.prisma.subscription.findMany({
      where: {
        currentPeriodEnd: { gte: now, lte: new Date(now.getTime() + REMINDER_DAYS_BEFORE * 86_400_000) },
        tenant: { status: { in: [TenantStatus.TRIAL, TenantStatus.ACTIVE] } },
      },
    });
    for (const sub of dueSoon) {
      stats.reminded++;
      await this.push.notifyOwners(sub.tenantId, Push.billing('⏰ MENSALIDADE VENCENDO', `Sua assinatura vence em ${sub.currentPeriodEnd!.toLocaleDateString('pt-BR')}. Veja como pagar no app.`));
    }

    const due = await this.prisma.subscription.findMany({
      where: { currentPeriodEnd: { lt: now }, tenant: { status: { in: [TenantStatus.TRIAL, TenantStatus.ACTIVE] } } },
    });
    for (const sub of due) {
      await this.setStatus(sub, SubscriptionStatus.PAST_DUE, TenantStatus.PAST_DUE);
      stats.pastDue++;
      await this.push.notifyOwners(sub.tenantId, Push.billing('⚠️ MENSALIDADE EM ABERTO', `Regularize em até ${this.graceDays} dias para não ter o atendimento suspenso.`));
    }

    const graceLimit = new Date(now.getTime() - this.graceDays * 86_400_000);
    const overdue = await this.prisma.subscription.findMany({
      where: { currentPeriodEnd: { lt: graceLimit }, tenant: { status: TenantStatus.PAST_DUE } },
    });
    for (const sub of overdue) {
      await this.setStatus(sub, SubscriptionStatus.PAST_DUE, TenantStatus.SUSPENDED);
      stats.suspended++;
      await this.push.notifyOwners(sub.tenantId, Push.billing('🚫 ATENDIMENTO SUSPENSO', 'Sua assinatura venceu. Pague a mensalidade para reativar o atendimento automático.'));
    }
    return stats;
  }

  private async setStatus(sub: Subscription, subStatus: SubscriptionStatus, tenantStatus: TenantStatus) {
    await this.prisma.$transaction([
      this.prisma.subscription.update({ where: { id: sub.id }, data: { status: subStatus } }),
      this.prisma.tenant.update({ where: { id: sub.tenantId }, data: { status: tenantStatus } }),
    ]);
  }

  private async getSubscription(tenantId: string): Promise<Subscription> {
    const sub = await this.prisma.subscription.findUnique({ where: { tenantId } });
    if (sub) return sub;
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Barbearia não encontrada');
    return this.prisma.subscription.create({
      data: { tenantId, amountCents: this.priceCents, currentPeriodEnd: tenant.trialEndsAt ?? new Date() },
    });
  }
}
