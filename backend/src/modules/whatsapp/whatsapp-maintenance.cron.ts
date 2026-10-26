import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WhatsappInstanceService } from './whatsapp-instance.service';

@Injectable()
export class WhatsappMaintenanceCron {
  private readonly logger = new Logger(WhatsappMaintenanceCron.name);
  private running = false;

  constructor(private readonly instances: WhatsappInstanceService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.instances.runMaintenance();
      if (r.reconnected || r.recreated || r.alerts) this.logger.log(`Manutenção WhatsApp: ${JSON.stringify(r)}`);
    } finally {
      this.running = false;
    }
  }
}
