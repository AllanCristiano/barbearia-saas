import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AppointmentSource, AppointmentStatus, Role } from '@prisma/client';
import { TenantUser } from '../../common/auth/auth-user';
import { PrismaService } from '../../common/prisma/prisma.service';
import { addDaysToDate, humanDateTime, minutesToDate, startOfDayInTz } from '../../common/utils/time.util';
import { Push } from '../notifications/push-messages';
import { PushService } from '../notifications/push.service';
import { MessagingService } from '../whatsapp/messaging.service';
import { APPOINTMENT_INCLUDE, AppointmentFull, AppointmentWriter } from './appointment-writer.service';
import { BLOCKING_STATUSES } from './availability.service';
import { parseHHMM } from './availability';
import { Messages } from './messages';
import { OffersService } from './offers.service';

/** Quem está executando a ação. Clientes agem pelo WhatsApp; equipe pelo app. */
export type Actor = { kind: 'customer'; customerId: string } | { kind: 'staff'; user: TenantUser };

/** Transições de status permitidas pela equipe. */
const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  SCHEDULED: [AppointmentStatus.CONFIRMED, AppointmentStatus.IN_PROGRESS, AppointmentStatus.NO_SHOW],
  CONFIRMED: [AppointmentStatus.IN_PROGRESS, AppointmentStatus.NO_SHOW, AppointmentStatus.SCHEDULED],
  IN_PROGRESS: [AppointmentStatus.COMPLETED],
  RESCHEDULE_PENDING: [],
  COMPLETED: [],
  CANCELED: [],
  NO_SHOW: [AppointmentStatus.COMPLETED],
};

export interface DaySummary {
  date: string;
  total: number;
  byStatus: Partial<Record<AppointmentStatus, number>>;
  expectedRevenueCents: number;
  completedRevenueCents: number;
  next: AppointmentFull | null;
  appointments: AppointmentFull[];
}

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: AppointmentWriter,
    private readonly offers: OffersService,
    private readonly messaging: MessagingService,
    private readonly push: PushService,
  ) {}

  async create(
    tenantId: string,
    input: { customerId: string; serviceId: string; barberId: string; startsAt: Date; notes?: string },
    actor: Actor,
    now = new Date(),
  ): Promise<AppointmentFull> {
    if (actor.kind === 'customer' && actor.customerId !== input.customerId) throw new ForbiddenException();
    if (actor.kind === 'staff' && actor.user.role === Role.BARBER && input.barberId !== actor.user.sub) {
      throw new ForbiddenException('Barbeiros só podem agendar na própria agenda');
    }
    const appointment = await this.writer.book(
      tenantId,
      { ...input, source: actor.kind === 'customer' ? AppointmentSource.WHATSAPP : AppointmentSource.APP },
      now,
    );
    const tenant = await this.tenant(tenantId);

    if (actor.kind === 'staff') {
      await this.messaging.send(
        tenantId,
        appointment.customer.phone,
        Messages.confirmation(tenant.name, { ...this.view(appointment), priceCents: appointment.priceCents }, tenant.timezone),
        { customerId: appointment.customerId },
      );
    }
    // Barbeiro do horário + donos; quem agendou pelo app não recebe o próprio aviso.
    await this.push.notifyStaff(
      tenantId,
      appointment.barberId,
      Push.newAppointment({ id: appointment.id, customerName: appointment.customer.name, serviceName: appointment.service.name, barberName: appointment.barber.name, startsAt: appointment.startsAt, priceCents: appointment.priceCents }, tenant.timezone, actor.kind === 'customer'),
      actor.kind === 'staff' ? actor.user.sub : undefined,
    );
    return appointment;
  }

  /** Lista da agenda do dia. Barbeiro vê só a própria; dono vê todas ou filtra. */
  async listDay(tenantId: string, user: TenantUser, date: string, barberId?: string): Promise<AppointmentFull[]> {
    const tenant = await this.tenant(tenantId);
    const effectiveBarber = user.role === Role.BARBER ? user.sub : barberId;
    return this.prisma.appointment.findMany({
      where: {
        tenantId,
        ...(effectiveBarber ? { barberId: effectiveBarber } : {}),
        startsAt: { gte: startOfDayInTz(date, tenant.timezone), lt: startOfDayInTz(addDaysToDate(date, 1), tenant.timezone) },
      },
      include: APPOINTMENT_INCLUDE,
      orderBy: { startsAt: 'asc' },
    });
  }

  /** "Fluxo do dia": contagens, faturamento e próximo cliente. */
  async daySummary(tenantId: string, user: TenantUser, date: string, barberId?: string, now = new Date()): Promise<DaySummary> {
    const appointments = await this.listDay(tenantId, user, date, barberId);
    const byStatus: DaySummary['byStatus'] = {};
    let expected = 0;
    let completed = 0;
    for (const a of appointments) {
      byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
      if (a.status === AppointmentStatus.COMPLETED) completed += a.priceCents;
      if (([...BLOCKING_STATUSES, AppointmentStatus.COMPLETED] as AppointmentStatus[]).includes(a.status)) expected += a.priceCents;
    }
    const next =
      appointments.find(
        (a) => ([AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED] as AppointmentStatus[]).includes(a.status) && a.endsAt > now,
      ) ?? null;
    return {
      date,
      total: appointments.filter((a) => a.status !== AppointmentStatus.CANCELED).length,
      byStatus,
      expectedRevenueCents: expected,
      completedRevenueCents: completed,
      next,
      appointments,
    };
  }

  async getForStaff(tenantId: string, user: TenantUser, id: string): Promise<AppointmentFull> {
    const appointment = await this.prisma.appointment.findFirst({ where: { id, tenantId }, include: APPOINTMENT_INCLUDE });
    if (!appointment) throw new NotFoundException('Agendamento não encontrado');
    if (user.role === Role.BARBER && appointment.barberId !== user.sub) throw new ForbiddenException();
    return appointment;
  }

  async upcomingForCustomer(tenantId: string, customerId: string, now = new Date()): Promise<AppointmentFull[]> {
    return this.prisma.appointment.findMany({
      where: {
        tenantId,
        customerId,
        startsAt: { gte: now },
        status: { in: [...BLOCKING_STATUSES, AppointmentStatus.RESCHEDULE_PENDING] },
      },
      include: APPOINTMENT_INCLUDE,
      orderBy: { startsAt: 'asc' },
      take: 5,
    });
  }

  async updateStatus(tenantId: string, user: TenantUser, id: string, status: AppointmentStatus): Promise<AppointmentFull> {
    const appointment = await this.getForStaff(tenantId, user, id);
    if (!TRANSITIONS[appointment.status].includes(status)) {
      throw new BadRequestException(`Não é possível mudar de ${appointment.status} para ${status}`);
    }
    const updated = await this.prisma.appointment.update({
      where: { id },
      data: { status },
      include: APPOINTMENT_INCLUDE,
    });
    if (status === AppointmentStatus.COMPLETED) {
      await this.prisma.customer.update({ where: { id: appointment.customerId }, data: { lastVisitAt: new Date() } });
    }
    return updated;
  }

  async cancel(tenantId: string, id: string, actor: Actor, reason?: string, now = new Date()): Promise<AppointmentFull> {
    const appointment = await this.loadForActor(tenantId, id, actor);
    if (!([...BLOCKING_STATUSES, AppointmentStatus.RESCHEDULE_PENDING] as AppointmentStatus[]).includes(appointment.status)) {
      throw new BadRequestException('Este agendamento não pode mais ser cancelado');
    }
    const tenant = await this.tenant(tenantId);
    if (actor.kind === 'customer') {
      const hoursLeft = (appointment.startsAt.getTime() - now.getTime()) / 3600_000;
      if (hoursLeft < tenant.minCancelHours) {
        throw new BadRequestException(
          `Cancelamentos com menos de ${tenant.minCancelHours}h de antecedência precisam ser combinados direto com a barbearia.`,
        );
      }
    }

    const canceled = await this.prisma.appointment.update({
      where: { id },
      data: { status: AppointmentStatus.CANCELED, canceledAt: now, cancelReason: reason ?? null },
      include: APPOINTMENT_INCLUDE,
    });
    await this.offers.cancelPendingFor(id);

    if (actor.kind === 'staff') {
      await this.messaging.send(
        tenantId,
        canceled.customer.phone,
        Messages.canceledByShop(tenant.name, this.view(canceled), tenant.timezone, reason),
        { customerId: canceled.customerId },
      );
    } else {
      await this.push.notifyStaff(tenantId, canceled.barberId, Push.canceledByCustomer({ id: canceled.id, customerName: canceled.customer.name, serviceName: canceled.service.name, barberName: canceled.barber.name, startsAt: canceled.startsAt, priceCents: canceled.priceCents }, tenant.timezone));
    }

    // O horário vagou: oferece ao próximo cliente do dia (só se o barbeiro segue atendendo).
    if (appointment.status !== AppointmentStatus.RESCHEDULE_PENDING) {
      await this.offers.offerFreedSlot(tenantId, { barberId: canceled.barberId, startsAt: canceled.startsAt }, now);
    }
    return canceled;
  }

  async reschedule(
    tenantId: string,
    id: string,
    target: { startsAt: Date; barberId?: string },
    actor: Actor,
    now = new Date(),
  ): Promise<AppointmentFull> {
    const appointment = await this.loadForActor(tenantId, id, actor);
    if (!([...BLOCKING_STATUSES, AppointmentStatus.RESCHEDULE_PENDING] as AppointmentStatus[]).includes(appointment.status)) {
      throw new BadRequestException('Este agendamento não pode ser remarcado');
    }
    const barberId = target.barberId ?? appointment.barberId;
    if (actor.kind === 'staff' && actor.user.role === Role.BARBER && barberId !== actor.user.sub && barberId !== appointment.barberId) {
      throw new ForbiddenException('Barbeiros só podem remarcar para a própria agenda');
    }
    const moved = await this.writer.move(tenantId, appointment, { startsAt: target.startsAt, barberId }, now);
    await this.offers.cancelPendingFor(id);

    const tenant = await this.tenant(tenantId);
    if (actor.kind === 'staff') {
      await this.messaging.send(
        tenantId,
        moved.customer.phone,
        Messages.rescheduledByShop(tenant.name, this.view(moved), tenant.timezone),
        { customerId: moved.customerId },
      );
    } else {
      await this.push.notifyStaff(tenantId, moved.barberId, Push.rescheduledByCustomer({ id: moved.id, customerName: moved.customer.name, serviceName: moved.service.name, barberName: moved.barber.name, startsAt: moved.startsAt, priceCents: moved.priceCents }, tenant.timezone));
    }
    if (appointment.status !== AppointmentStatus.RESCHEDULE_PENDING) {
      await this.offers.offerFreedSlot(tenantId, { barberId: appointment.barberId, startsAt: appointment.startsAt }, now);
    }
    return moved;
  }

  /**
   * Barbeiro não poderá atender (dia todo ou um período): bloqueia a agenda e envia
   * a cada cliente afetado opções de novos horários pelo WhatsApp.
   */
  async markUnavailable(
    tenantId: string,
    user: TenantUser,
    input: { barberId?: string; date: string; startTime?: string; endTime?: string; reason?: string },
    now = new Date(),
  ): Promise<{ timeOffId: string; affected: number }> {
    const barberId = user.role === Role.BARBER ? user.sub : (input.barberId ?? user.sub);
    const barber = await this.prisma.user.findFirst({ where: { id: barberId, tenantId } });
    if (!barber) throw new NotFoundException('Barbeiro não encontrado');
    const tenant = await this.tenant(tenantId);

    const startsAt = input.startTime
      ? minutesToDate(input.date, parseHHMM(input.startTime), tenant.timezone)
      : startOfDayInTz(input.date, tenant.timezone);
    const endsAt = input.endTime
      ? minutesToDate(input.date, parseHHMM(input.endTime), tenant.timezone)
      : startOfDayInTz(addDaysToDate(input.date, 1), tenant.timezone);
    if (endsAt <= startsAt) throw new BadRequestException('Período inválido');

    const timeOff = await this.prisma.timeOff.create({
      data: { tenantId, barberId, startsAt, endsAt, reason: input.reason },
    });

    const affected = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        barberId,
        status: { in: [AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED] },
        startsAt: { lt: endsAt, gte: now },
        endsAt: { gt: startsAt },
      },
      include: APPOINTMENT_INCLUDE,
    });
    for (const a of affected) {
      await this.prisma.appointment.update({ where: { id: a.id }, data: { status: AppointmentStatus.RESCHEDULE_PENDING } });
      await this.offers.createRescheduleOffer(tenantId, { ...a, status: AppointmentStatus.RESCHEDULE_PENDING }, now);
    }
    return { timeOffId: timeOff.id, affected: affected.length };
  }

  /** Cliente respondeu CONFIRMAR ao lembrete. */
  async confirmByCustomer(tenantId: string, customerId: string, now = new Date()): Promise<AppointmentFull | null> {
    const next = await this.prisma.appointment.findFirst({
      where: {
        tenantId,
        customerId,
        status: AppointmentStatus.SCHEDULED,
        startsAt: { gte: now, lte: new Date(now.getTime() + 36 * 3600_000) },
      },
      orderBy: { startsAt: 'asc' },
    });
    if (!next) return null;
    return this.prisma.appointment.update({
      where: { id: next.id },
      data: { status: AppointmentStatus.CONFIRMED },
      include: APPOINTMENT_INCLUDE,
    });
  }

  private async loadForActor(tenantId: string, id: string, actor: Actor): Promise<AppointmentFull> {
    if (actor.kind === 'staff') return this.getForStaff(tenantId, actor.user, id);
    const appointment = await this.prisma.appointment.findFirst({
      where: { id, tenantId, customerId: actor.customerId },
      include: APPOINTMENT_INCLUDE,
    });
    if (!appointment) throw new NotFoundException('Agendamento não encontrado');
    return appointment;
  }

  private async tenant(tenantId: string) {
    return this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  }

  private view(a: AppointmentFull) {
    return { customerName: a.customer.name, serviceName: a.service.name, barberName: a.barber.name, startsAt: a.startsAt };
  }
}
