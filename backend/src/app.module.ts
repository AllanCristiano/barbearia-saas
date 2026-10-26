import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { SubscriptionGuard } from './common/auth/subscription.guard';
import { PrismaModule } from './common/prisma/prisma.module';
import { validateEnv } from './config/env.validation';
import { AdminModule } from './modules/admin/admin.controller';
import { AuthModule } from './modules/auth/auth.module';
import { BotModule } from './modules/bot/bot.module';
import { BillingModule } from './modules/billing/billing.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { CatalogModule } from './modules/catalog/catalog.controller';
import { CustomersModule } from './modules/customers/customers.module';
import { HealthModule } from './modules/health/health.controller';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { StaffModule } from './modules/staff/staff.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { WhatsappModule } from './modules/whatsapp/whatsapp.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST'),
          port: Number(config.get('REDIS_PORT')),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
        },
      }),
    }),
    PrismaModule,
    NotificationsModule,
    AuthModule,
    WhatsappModule,
    TenantsModule,
    StaffModule,
    CatalogModule,
    CustomersModule,
    SchedulingModule,
    BotModule,
    CampaignsModule,
    BillingModule,
    AdminModule,
    HealthModule,
  ],
  providers: [
    // Ordem importa: rate limit → autenticação → papel → assinatura em dia.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: SubscriptionGuard },
  ],
})
export class AppModule {}
