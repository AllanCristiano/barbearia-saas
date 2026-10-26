import { InjectQueue } from '@nestjs/bullmq';
import { Body, Controller, HttpCode, Logger, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import { Public } from '../../common/auth/decorators';
import { safeEqual } from '../../common/utils/crypto.util';
import { normalizePhone } from '../../common/utils/phone.util';
import { parseEvolutionWebhook } from './evolution-webhook.parser';
import { INBOUND_QUEUE, InboundJob } from './queues';
import { WhatsappInstanceService } from './whatsapp-instance.service';

/**
 * Recebe eventos do Evolution Go. Responde rápido (200) e delega o processamento
 * das mensagens à fila de entrada — o Evolution não deve ficar esperando a IA.
 */
@ApiExcludeController()
@SkipThrottle()
@Public()
@Controller('webhooks/whatsapp')
export class WhatsappWebhookController {
  private readonly logger = new Logger(WhatsappWebhookController.name);

  constructor(
    private readonly instances: WhatsappInstanceService,
    @InjectQueue(INBOUND_QUEUE) private readonly inbound: Queue<InboundJob>,
  ) {}

  @Post(':instanceId')
  @HttpCode(200)
  async receive(
    @Param('instanceId') instanceId: string,
    @Query('secret') secret: string,
    @Body() body: Record<string, any>,
  ): Promise<{ ok: true; handled: string }> {
    const instance = await this.instances.findByWebhook(instanceId);
    if (!instance || !secret || !safeEqual(secret, instance.webhookSecret)) {
      throw new UnauthorizedException();
    }

    const event = parseEvolutionWebhook(body);
    switch (event.type) {
      case 'message': {
        let phone: string;
        try {
          phone = normalizePhone(event.phone);
        } catch {
          return { ok: true, handled: 'invalid-phone' };
        }
        await this.inbound.add(
          'inbound',
          { tenantId: instance.tenantId, phone, text: event.text, pushName: event.pushName, messageId: event.messageId },
          {
            // Evolution pode reenviar o mesmo evento: o jobId deduplica.
            jobId: event.messageId ? `${instance.id}-${event.messageId}` : undefined,
            attempts: 2,
            backoff: { type: 'fixed', delay: 3_000 },
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        );
        return { ok: true, handled: 'message' };
      }
      case 'connection':
        await this.instances.handleConnectionEvent(instance, event.connected);
        return { ok: true, handled: 'connection' };
      case 'logout':
        await this.instances.handleLogout(instance);
        return { ok: true, handled: 'logout' };
      default:
        return { ok: true, handled: event.type };
    }
  }
}
