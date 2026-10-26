import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { MessageDirection, MessageStatus } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OUTBOUND_QUEUE, OutboundJob } from './queues';

export interface SendOptions {
  customerId?: string;
  campaignId?: string;
  /** Atraso antes do envio (campanhas espaçam as mensagens para evitar bloqueio). */
  delayMs?: number;
}

/**
 * Porta de saída de mensagens. Grava o log e enfileira; o envio real acontece no
 * OutboundProcessor com retentativas e limite de taxa.
 */
@Injectable()
export class MessagingService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(OUTBOUND_QUEUE) private readonly queue: Queue<OutboundJob>,
  ) {}

  async send(tenantId: string, phone: string, body: string, opts: SendOptions = {}): Promise<string> {
    const log = await this.prisma.messageLog.create({
      data: {
        tenantId,
        phone,
        body,
        customerId: opts.customerId,
        campaignId: opts.campaignId,
        direction: MessageDirection.OUT,
        status: MessageStatus.QUEUED,
      },
    });
    await this.queue.add(
      'send',
      { messageLogId: log.id },
      {
        jobId: log.id,
        delay: opts.delayMs,
        attempts: 4,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    return log.id;
  }

  async logInbound(tenantId: string, phone: string, body: string, customerId: string, externalId?: string) {
    await this.prisma.messageLog.create({
      data: {
        tenantId,
        phone,
        body,
        customerId,
        externalId,
        direction: MessageDirection.IN,
        status: MessageStatus.RECEIVED,
      },
    });
  }
}
