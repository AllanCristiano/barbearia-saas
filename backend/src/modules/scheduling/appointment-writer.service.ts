import { Injectable, NotFoundException } from '@nestjs/common';
import { Appointment, AppointmentSource, AppointmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AvailabilityService, slotTakenError } from './availability.service';

export const APPOINTMENT_INCLUDE = {
  customer: { select: { id: true, name: true, phone: true } },
  service: { select: { id: true, name: true, durationMinutes: true } },
  barber: { select: { id: true, name: true } },
} satisfies Prisma.AppointmentInclude;

export type AppointmentFull = Prisma.AppointmentGetPayload<{ include: typeof APPOINTMENT_INCLUDE }>;

export interface BookInput {
  customerId: string;
  serviceId: string;
  barberId: string;
  startsAt: Date;
  source: AppointmentSource;
  notes?: string;
}

/**
 * Escrita de agendamentos sob lock por barbeiro (pg_advisory_xact_lock), evitando
 * que duas pessoas reservem o mesmo horário ao mesmo tempo.
 */
@Injectable()
export class AppointmentWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
  ) {}

  async book(tenantId: string, input: BookInput, now = new Date()): Promise<AppointmentFull> {
    const [service, barber, customer] = await Promise.all([
      this.prisma.service.findFirst({ where: { id: input.serviceId, tenantId, active: true } }),
      this.prisma.user.findFirst({ where: { id: input.barberId, tenantId, active: true } }),
      this.prisma.customer.findFirst({ where: { id: input.customerId, tenantId } }),
    ]);
    if (!service) throw new NotFoundException('Serviço não encontrado');
    if (!barber) throw new NotFoundException('Barbeiro não encontrado');
    if (!customer) throw new NotFoundException('Cliente não encontrado');

    return this.withBarberLock(input.barberId, async (tx) => {
      await this.availability.assertSlotAvailable(
        tx,
        tenantId,
        { barberId: input.barberId, startsAt: input.startsAt, durationMinutes: service.durationMinutes },
        now,
      );
      return tx.appointment.create({
        data: {
          tenantId,
          customerId: customer.id,
          serviceId: service.id,
          barberId: barber.id,
          startsAt: input.startsAt,
          endsAt: new Date(input.startsAt.getTime() + service.durationMinutes * 60_000),
          priceCents: service.priceCents,
          source: input.source,
          notes: input.notes,
        },
        include: APPOINTMENT_INCLUDE,
      });
    });
  }

  /** Move um agendamento para outro horário/barbeiro, validando a disponibilidade. */
  async move(
    tenantId: string,
    appointment: Pick<Appointment, 'id' | 'serviceId'>,
    target: { startsAt: Date; barberId: string },
    now = new Date(),
  ): Promise<AppointmentFull> {
    const service = await this.prisma.service.findFirst({ where: { id: appointment.serviceId, tenantId } });
    if (!service) throw new NotFoundException('Serviço não encontrado');
    const barber = await this.prisma.user.findFirst({ where: { id: target.barberId, tenantId, active: true } });
    if (!barber) throw new NotFoundException('Barbeiro não encontrado');

    return this.withBarberLock(target.barberId, async (tx) => {
      await this.availability.assertSlotAvailable(
        tx,
        tenantId,
        {
          barberId: target.barberId,
          startsAt: target.startsAt,
          durationMinutes: service.durationMinutes,
          excludeAppointmentId: appointment.id,
        },
        now,
      );
      return tx.appointment.update({
        where: { id: appointment.id },
        data: {
          startsAt: target.startsAt,
          endsAt: new Date(target.startsAt.getTime() + service.durationMinutes * 60_000),
          barberId: target.barberId,
          status: AppointmentStatus.SCHEDULED,
          reminderAt: null,
        },
        include: APPOINTMENT_INCLUDE,
      });
    });
  }

  /**
   * Duas camadas contra horário duplicado quando duas pessoas agendam ao mesmo tempo:
   *  1. trava por barbeiro (pg_advisory_xact_lock): os pedidos daquele barbeiro entram
   *     em fila e cada um revalida a agenda já vendo o que o anterior gravou;
   *  2. constraint "Appointment_no_overlap" no banco: se algo escapar da trava, o
   *     PostgreSQL recusa a gravação — e convertemos em "horário ocupado".
   */
  private async withBarberLock<T>(barberId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${barberId}))`;
        return fn(tx);
      });
    } catch (err) {
      if (isOverlapViolation(err)) throw slotTakenError();
      throw err;
    }
  }
}

/** Violação da exclusion constraint (SQLSTATE 23P01) que impede sobreposição. */
export function isOverlapViolation(err: unknown): boolean {
  const text = `${(err as Error)?.message ?? ''} ${JSON.stringify((err as { meta?: unknown })?.meta ?? {})}`;
  return text.includes('Appointment_no_overlap') || text.includes('23P01');
}
