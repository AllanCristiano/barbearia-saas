import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AppointmentStatus, Prisma, Tenant } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  addDaysToDate,
  dateToMinutes,
  localDate,
  minutesToDate,
  startOfDayInTz,
  weekdayOf,
} from '../../common/utils/time.util';
import { checkRange, computeSlots, formatHHMM, MinuteRange } from './availability';

/** Status que ocupam a agenda do barbeiro. */
export const BLOCKING_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.SCHEDULED,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.IN_PROGRESS,
];

export const SLOT_TAKEN_CODE = 'SLOT_TAKEN';
export const SLOT_TAKEN_MESSAGE = 'Esse horário acabou de ser ocupado por outro cliente. Escolha outro horário.';

/** Erro padrão quando duas pessoas disputam o mesmo horário e esta perdeu. */
export function slotTakenError(): BadRequestException {
  return new BadRequestException({ statusCode: 400, error: 'Bad Request', code: SLOT_TAKEN_CODE, message: SLOT_TAKEN_MESSAGE });
}

/** Antecedência mínima para agendar um horário de hoje. */
export const MIN_LEAD_MINUTES = 10;

export interface Slot {
  barberId: string;
  barberName: string;
  startsAt: string;
  time: string;
  date: string;
}

type Db = Prisma.TransactionClient;

@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  /** Horários livres de um serviço em uma data, para um barbeiro ou todos. */
  async getSlots(
    tenantId: string,
    params: { serviceId: string; date: string; barberId?: string; excludeAppointmentId?: string },
    now = new Date(),
  ): Promise<Slot[]> {
    const tenant = await this.getTenant(tenantId);
    const service = await this.prisma.service.findFirst({
      where: { id: params.serviceId, tenantId, active: true },
    });
    if (!service) throw new NotFoundException('Serviço não encontrado');

    const today = localDate(now, tenant.timezone);
    const lastDay = addDaysToDate(today, tenant.bookingWindowDays);
    if (params.date < today || params.date > lastDay) return [];

    const barbers = await this.prisma.user.findMany({
      where: { tenantId, active: true, workingHours: { some: {} }, ...(params.barberId ? { id: params.barberId } : {}) },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    const notBefore = params.date === today ? dateToMinutes(now, tenant.timezone) + MIN_LEAD_MINUTES : undefined;
    const result: Slot[] = [];
    for (const barber of barbers) {
      const { windows, busy } = await this.dayContext(this.prisma, tenant, barber.id, params.date, params.excludeAppointmentId);
      const slots = computeSlots({
        windows,
        busy,
        durationMinutes: service.durationMinutes,
        stepMinutes: tenant.slotStepMinutes,
        notBefore,
      });
      for (const m of slots) {
        result.push({
          barberId: barber.id,
          barberName: barber.name,
          startsAt: minutesToDate(params.date, m, tenant.timezone).toISOString(),
          time: formatHHMM(m),
          date: params.date,
        });
      }
    }
    return result.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  /** Próximos N horários livres a partir de uma data (usado em remarcações). */
  async nextSlots(
    tenantId: string,
    params: { serviceId: string; fromDate: string; limit: number; barberId?: string; excludeBarberIds?: string[]; excludeAppointmentId?: string },
    now = new Date(),
  ): Promise<Slot[]> {
    const tenant = await this.getTenant(tenantId);
    const found: Slot[] = [];
    for (let i = 0; i <= tenant.bookingWindowDays && found.length < params.limit; i++) {
      const date = addDaysToDate(params.fromDate, i);
      const slots = await this.getSlots(
        tenantId,
        { serviceId: params.serviceId, date, barberId: params.barberId, excludeAppointmentId: params.excludeAppointmentId },
        now,
      );
      for (const s of slots) {
        if (params.excludeBarberIds?.includes(s.barberId)) continue;
        // Espalha as sugestões: no máximo 1 por barbeiro por hora cheia.
        if (found.some((f) => f.barberId === s.barberId && f.startsAt.slice(0, 13) === s.startsAt.slice(0, 13))) continue;
        found.push(s);
        if (found.length >= params.limit) break;
      }
    }
    return found;
  }

  /**
   * Valida que o barbeiro pode atender [startsAt, startsAt+duração). Recebe o client
   * da transação para rodar sob o lock de agendamento.
   */
  async assertSlotAvailable(
    db: Db,
    tenantId: string,
    params: { barberId: string; startsAt: Date; durationMinutes: number; excludeAppointmentId?: string },
    now = new Date(),
  ): Promise<void> {
    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Barbearia não encontrada');

    if (params.startsAt.getTime() < now.getTime() + MIN_LEAD_MINUTES * 60_000) {
      throw new BadRequestException('Horário já passou ou está muito próximo');
    }
    const date = localDate(params.startsAt, tenant.timezone);
    if (date > addDaysToDate(localDate(now, tenant.timezone), tenant.bookingWindowDays)) {
      throw new BadRequestException(`Agendamentos só podem ser feitos com até ${tenant.bookingWindowDays} dias de antecedência`);
    }
    const start = dateToMinutes(params.startsAt, tenant.timezone);
    const range = { start, end: start + params.durationMinutes };
    const { windows, busy } = await this.dayContext(db, tenant, params.barberId, date, params.excludeAppointmentId);
    const result = checkRange(range, windows, busy);
    if (result === 'outside') throw new BadRequestException('Esse horário está fora do expediente do barbeiro');
    if (result === 'taken') throw slotTakenError();
  }

  private async dayContext(
    db: Db,
    tenant: Tenant,
    barberId: string,
    date: string,
    excludeAppointmentId?: string,
  ): Promise<{ windows: MinuteRange[]; busy: MinuteRange[] }> {
    const dayStart = startOfDayInTz(date, tenant.timezone);
    const dayEnd = startOfDayInTz(addDaysToDate(date, 1), tenant.timezone);

    const [hours, appointments, timeOffs] = await Promise.all([
      db.workingHour.findMany({ where: { tenantId: tenant.id, barberId, weekday: weekdayOf(date) } }),
      db.appointment.findMany({
        where: {
          tenantId: tenant.id,
          barberId,
          status: { in: BLOCKING_STATUSES },
          startsAt: { lt: dayEnd },
          endsAt: { gt: dayStart },
          ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
        },
        select: { startsAt: true, endsAt: true },
      }),
      db.timeOff.findMany({
        where: { tenantId: tenant.id, barberId, startsAt: { lt: dayEnd }, endsAt: { gt: dayStart } },
        select: { startsAt: true, endsAt: true },
      }),
    ]);

    const toRange = (s: Date, e: Date): MinuteRange => ({
      start: s <= dayStart ? 0 : dateToMinutes(s, tenant.timezone),
      end: e >= dayEnd ? 24 * 60 : dateToMinutes(e, tenant.timezone),
    });

    return {
      windows: hours.map((h) => ({ start: h.startMinute, end: h.endMinute })),
      busy: [...appointments, ...timeOffs].map((b) => toRange(b.startsAt, b.endsAt)),
    };
  }

  private async getTenant(tenantId: string): Promise<Tenant> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException('Barbearia não encontrada');
    return tenant;
  }
}
