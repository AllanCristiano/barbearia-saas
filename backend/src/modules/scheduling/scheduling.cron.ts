import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppointmentStatus, TenantStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MessagingService } from '../whatsapp/messaging.service';
import { APPOINTMENT_INCLUDE } from './appointment-writer.service';
import { Messages } from './messages';
import { OffersService } from './offers.service';

@Injectable()
export class SchedulingCron {
  private readonly logger = new Logger(SchedulingCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly offers: OffersService,
    private readonly messaging: MessagingService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async expireOffers(): Promise<void> {
    const n = await this.offers.expireOffers();
    if (n) this.logger.log(`${n} proposta(s) expirada(s)`);
  }

  /** Lembretes X horas antes (configurável por barbearia). */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async sendReminders(now = new Date()): Promise<number> {
    const candidates = await this.prisma.appointment.findMany({
      where: {
        status: { in: [AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED] },
        reminderAt: null,
        startsAt: { gt: now, lte: new Date(now.getTime() + 24 * 3600_000) },
        tenant: { status: { in: [TenantStatus.TRIAL, TenantStatus.ACTIVE, TenantStatus.PAST_DUE] } },
      },
      include: { ...APPOINTMENT_INCLUDE, tenant: true },
      take: 500,
    });

    let sent = 0;
    for (const a of candidates) {
      const hoursBefore = a.tenant.reminderHoursBefore;
      if (hoursBefore <= 0) continue;
      if (a.startsAt.getTime() - now.getTime() > hoursBefore * 3600_000) continue;
      // Agendado há poucos minutos para daqui a pouco: lembrete seria redundante.
      if (now.getTime() - a.createdAt.getTime() < 30 * 60_000) {
        await this.prisma.appointment.update({ where: { id: a.id }, data: { reminderAt: now } });
        continue;
      }
      await this.messaging.send(
        a.tenantId,
        a.customer.phone,
        Messages.reminder(
          a.tenant.name,
          { customerName: a.customer.name, serviceName: a.service.name, barberName: a.barber.name, startsAt: a.startsAt },
          a.tenant.timezone,
        ),
        { customerId: a.customerId },
      );
      await this.prisma.appointment.update({ where: { id: a.id }, data: { reminderAt: now } });
      sent++;
    }
    return sent;
  }
}
