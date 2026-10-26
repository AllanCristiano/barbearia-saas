import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { INBOUND_QUEUE } from '../whatsapp/queues';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { ConversationService } from './conversation.service';
import { InboundProcessor } from './inbound.processor';
import { MenuBotService } from './menu-bot.service';

@Module({
  imports: [BullModule.registerQueue({ name: INBOUND_QUEUE }), WhatsappModule, SchedulingModule, CustomersModule],
  providers: [MenuBotService, ConversationService, InboundProcessor],
})
export class BotModule {}
