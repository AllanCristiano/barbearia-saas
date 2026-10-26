import { Injectable, Logger, Module } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

@Injectable()
export class BillingCron {
  private readonly logger = new Logger(BillingCron.name);

  constructor(private readonly billing: BillingService) {}

  /** Todo dia às 08:00 (horário de Brasília). */
  @Cron('0 8 * * *', { timeZone: 'America/Sao_Paulo' })
  async daily(): Promise<void> {
    const stats = await this.billing.runDailyBilling();
    this.logger.log(`Cobrança diária: ${JSON.stringify(stats)}`);
  }
}

@Module({
  controllers: [BillingController],
  providers: [BillingService, BillingCron],
  exports: [BillingService],
})
export class BillingModule {}
