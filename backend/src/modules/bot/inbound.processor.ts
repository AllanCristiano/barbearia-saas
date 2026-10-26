import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { INBOUND_QUEUE, InboundJob } from '../whatsapp/queues';
import { ConversationService } from './conversation.service';

@Processor(INBOUND_QUEUE, { concurrency: 10 })
export class InboundProcessor extends WorkerHost {
  constructor(private readonly conversation: ConversationService) {
    super();
  }

  async process(job: Job<InboundJob>): Promise<void> {
    await this.conversation.handleInbound(job.data);
  }
}
