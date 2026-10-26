import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EvolutionClient } from './evolution.client';
import { MessagingService } from './messaging.service';
import { OutboundProcessor } from './outbound.processor';
import { INBOUND_QUEUE, OUTBOUND_QUEUE } from './queues';
import { WhatsappInstanceService } from './whatsapp-instance.service';
import { WhatsappMaintenanceCron } from './whatsapp-maintenance.cron';
import { WhatsappWebhookController } from './whatsapp-webhook.controller';
import { WhatsappController } from './whatsapp.controller';

@Module({
  imports: [BullModule.registerQueue({ name: OUTBOUND_QUEUE }, { name: INBOUND_QUEUE })],
  controllers: [WhatsappController, WhatsappWebhookController],
  providers: [EvolutionClient, WhatsappInstanceService, MessagingService, OutboundProcessor, WhatsappMaintenanceCron],
  exports: [EvolutionClient, WhatsappInstanceService, MessagingService],
})
export class WhatsappModule {}
