import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Campaign, CampaignStatus, InstanceStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MessagingService } from '../whatsapp/messaging.service';
import { CreateCampaignDto, UpdateCampaignDto } from './campaigns.dto';

export const OPT_OUT_FOOTER = '\n\n_Não quer mais receber as promoções? Responde SAIR._';

/** Substitui variáveis: {nome} → primeiro nome do cliente. */
export function renderCampaignMessage(template: string, customer: { name: string | null }): string {
  const first = customer.name?.trim().split(/\s+/)[0] ?? '';
  return template.replace(/\{nome\}/gi, first).replace(/\s+([,!.?])/g, '$1').trim() + OPT_OUT_FOOTER;
}

/** Promoções e avisos em massa pelo WhatsApp, apenas para clientes com opt-in. */
@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);
  private readonly intervalMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    config: ConfigService,
  ) {
    this.intervalMs = Number(config.get('WHATSAPP_SEND_INTERVAL_MS', 1500));
  }

  list(tenantId: string) {
    return this.prisma.campaign.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  async get(tenantId: string, id: string): Promise<Campaign> {
    const c = await this.prisma.campaign.findFirst({ where: { id, tenantId } });
    if (!c) throw new NotFoundException('Campanha não encontrada');
    return c;
  }

  create(tenantId: string, dto: CreateCampaignDto) {
    return this.prisma.campaign.create({
      data: {
        tenantId,
        title: dto.title,
        message: dto.message,
        tags: dto.tags ?? [],
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        status: dto.scheduledAt ? CampaignStatus.SCHEDULED : CampaignStatus.DRAFT,
      },
    });
  }

  async update(tenantId: string, id: string, dto: UpdateCampaignDto) {
    const c = await this.get(tenantId, id);
    if (!([CampaignStatus.DRAFT, CampaignStatus.SCHEDULED] as CampaignStatus[]).includes(c.status)) {
      throw new BadRequestException('Campanha já enviada não pode ser alterada');
    }
    return this.prisma.campaign.update({
      where: { id },
      data: {
        title: dto.title,
        message: dto.message,
        tags: dto.tags,
        scheduledAt: dto.scheduledAt === undefined ? undefined : dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        status: dto.scheduledAt ? CampaignStatus.SCHEDULED : dto.scheduledAt === null ? CampaignStatus.DRAFT : undefined,
      },
    });
  }

  async cancel(tenantId: string, id: string) {
    const c = await this.get(tenantId, id);
    if (c.status === CampaignStatus.SENT) throw new BadRequestException('Campanha já enviada');
    return this.prisma.campaign.update({ where: { id }, data: { status: CampaignStatus.CANCELED } });
  }

  /** Quantos clientes receberiam a campanha. */
  async audienceSize(tenantId: string, tags: string[]): Promise<number> {
    return this.prisma.customer.count({ where: this.audienceWhere(tenantId, tags) });
  }

  /** Dispara a campanha agora: enfileira uma mensagem por cliente, espaçadas no tempo. */
  async send(tenantId: string, id: string): Promise<Campaign> {
    const campaign = await this.get(tenantId, id);
    if (!([CampaignStatus.DRAFT, CampaignStatus.SCHEDULED] as CampaignStatus[]).includes(campaign.status)) {
      throw new BadRequestException('Campanha já enviada ou cancelada');
    }
    const instance = await this.prisma.whatsappInstance.findUnique({ where: { tenantId } });
    if (instance?.status !== InstanceStatus.CONNECTED) {
      throw new BadRequestException('Conecte o WhatsApp antes de enviar campanhas');
    }

    const recipients = await this.prisma.customer.findMany({
      where: this.audienceWhere(tenantId, campaign.tags),
      select: { id: true, name: true, phone: true },
    });
    await this.prisma.campaign.update({
      where: { id },
      data: { status: CampaignStatus.SENDING, startedAt: new Date(), totalRecipients: recipients.length },
    });

    for (const [i, c] of recipients.entries()) {
      // Espaçamento + variação aleatória: reduz o risco de bloqueio do número pelo WhatsApp.
      const delayMs = i * this.intervalMs + Math.floor(Math.random() * 1000);
      await this.messaging.send(tenantId, c.phone, renderCampaignMessage(campaign.message, c), {
        customerId: c.id,
        campaignId: id,
        delayMs,
      });
    }
    if (!recipients.length) {
      return this.prisma.campaign.update({ where: { id }, data: { status: CampaignStatus.SENT, finishedAt: new Date() } });
    }
    return this.get(tenantId, id);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async processScheduled(now = new Date()): Promise<void> {
    const due = await this.prisma.campaign.findMany({
      where: { status: CampaignStatus.SCHEDULED, scheduledAt: { lte: now } },
      take: 20,
    });
    for (const c of due) {
      await this.send(c.tenantId, c.id).catch((err) => {
        this.logger.warn(`Campanha ${c.id} não enviada: ${err.message}`);
      });
    }

    const sending = await this.prisma.campaign.findMany({ where: { status: CampaignStatus.SENDING } });
    for (const c of sending) {
      if (c.sentCount + c.failedCount >= c.totalRecipients) {
        await this.prisma.campaign.update({ where: { id: c.id }, data: { status: CampaignStatus.SENT, finishedAt: now } });
      }
    }
  }

  private audienceWhere(tenantId: string, tags: string[]) {
    return {
      tenantId,
      marketingOptIn: true,
      blocked: false,
      ...(tags.length ? { tags: { hasSome: tags } } : {}),
    };
  }
}
