import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { MessageStatus } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EvolutionClient } from './evolution.client';
import { OUTBOUND_QUEUE, OutboundJob } from './queues';
import { WhatsappInstanceService } from './whatsapp-instance.service';

/** Envia as mensagens enfileiradas. Limite global: 5 mensagens/segundo. */
@Processor(OUTBOUND_QUEUE, { concurrency: 3, limiter: { max: 5, duration: 1000 } })
export class OutboundProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboundProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly instances: WhatsappInstanceService,
    private readonly evolution: EvolutionClient,
  ) {
    super();
  }

  async process(job: Job<OutboundJob>): Promise<void> {
    const log = await this.prisma.messageLog.findUnique({ where: { id: job.data.messageLogId } });
    if (!log || log.status === MessageStatus.SENT) return;

    const token = await this.instances.getSendToken(log.tenantId);
    const { messageId } = await this.evolution.sendText(token, log.phone, log.body);

    await this.prisma.messageLog.update({
      where: { id: log.id },
      data: { status: MessageStatus.SENT, externalId: messageId ?? null, error: null },
    });
    if (log.campaignId) {
      await this.prisma.campaign.update({ where: { id: log.campaignId }, data: { sentCount: { increment: 1 } } });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<OutboundJob> | undefined, err: Error): Promise<void> {
    if (!job) return;
    const finalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!finalAttempt) return;
    this.logger.warn(`Mensagem ${job.data.messageLogId} falhou definitivamente: ${err.message}`);
    const log = await this.prisma.messageLog.update({
      where: { id: job.data.messageLogId },
      data: { status: MessageStatus.FAILED, error: err.message.slice(0, 500) },
    });
    if (log.campaignId) {
      await this.prisma.campaign.update({ where: { id: log.campaignId }, data: { failedCount: { increment: 1 } } });
    }
  }
}
