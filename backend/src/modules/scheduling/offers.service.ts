import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AppointmentOffer, AppointmentStatus, OfferStatus, OfferType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { addDaysToDate, humanDateTime, localDate, startOfDayInTz } from '../../common/utils/time.util';
import { Push } from '../notifications/push-messages';
import { PushService } from '../notifications/push.service';
import { MessagingService } from '../whatsapp/messaging.service';
import { APPOINTMENT_INCLUDE, AppointmentFull, AppointmentWriter } from './appointment-writer.service';
import { AvailabilityService } from './availability.service';
import { Messages } from './messages';
import { parseOfferReply } from './offer-reply';

export interface OfferOption {
  startsAt: string;
  barberId: string;
  barberName: string;
}

/** Validade das propostas de remarcação (barbeiro indisponível). */
export const RESCHEDULE_OFFER_HOURS = 12;
/** Não oferecemos horários que começam em menos de X minutos. */
export const ADVANCE_MIN_NOTICE_MINUTES = 15;

/**
 * Propostas automáticas pelo WhatsApp:
 *
 * ADVANCE — quando um horário vaga, oferece ao próximo cliente do mesmo barbeiro
 *   no mesmo dia. Se ele recusar/não responder, oferece ao seguinte. Se aceitar,
 *   o horário dele vaga e a cadeia continua.
 *
 * RESCHEDULE — quando o barbeiro não pode atender, cada cliente afetado recebe
 *   até 3 opções de novo horário e responde com o número.
 */
@Injectable()
export class OffersService {
  private readonly logger = new Logger(OffersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly writer: AppointmentWriter,
    private readonly messaging: MessagingService,
    private readonly push: PushService,
  ) {}

  async offerFreedSlot(
    tenantId: string,
    freed: { barberId: string; startsAt: Date },
    now = new Date(),
  ): Promise<AppointmentOffer | null> {
    if (freed.startsAt.getTime() < now.getTime() + ADVANCE_MIN_NOTICE_MINUTES * 60_000) return null;
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return null;

    const slotIso = freed.startsAt.toISOString();
    const previous = (
      await this.prisma.appointmentOffer.findMany({
        where: { tenantId, type: OfferType.ADVANCE, createdAt: { gte: new Date(now.getTime() - 24 * 3600_000) } },
      })
    ).filter((o) => {
      const opt = (o.options as unknown as OfferOption[])[0];
      return opt?.startsAt === slotIso && opt.barberId === freed.barberId;
    });
    if (previous.some((o) => o.status === OfferStatus.PENDING || o.status === OfferStatus.ACCEPTED)) return null;
    const alreadyTried = new Set(previous.map((o) => o.appointmentId));

    const day = localDate(freed.startsAt, tenant.timezone);
    const candidates = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        barberId: freed.barberId,
        status: { in: [AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED] },
        startsAt: { gt: freed.startsAt, lt: startOfDayInTz(addDaysToDate(day, 1), tenant.timezone) },
      },
      include: APPOINTMENT_INCLUDE,
      orderBy: { startsAt: 'asc' },
    });

    for (const candidate of candidates) {
      if (alreadyTried.has(candidate.id)) continue;
      const busyCustomer = await this.prisma.appointmentOffer.findFirst({
        where: { tenantId, status: OfferStatus.PENDING, appointment: { customerId: candidate.customerId } },
      });
      if (busyCustomer) continue;
      try {
        await this.availability.assertSlotAvailable(
          this.prisma,
          tenantId,
          {
            barberId: freed.barberId,
            startsAt: freed.startsAt,
            durationMinutes: candidate.service.durationMinutes,
            excludeAppointmentId: candidate.id,
          },
          now,
        );
      } catch {
        continue; // o serviço deste cliente não cabe no buraco
      }

      const expiresAt = new Date(
        Math.min(now.getTime() + tenant.offerTimeoutMinutes * 60_000, freed.startsAt.getTime() - 5 * 60_000),
      );
      const option: OfferOption = { startsAt: slotIso, barberId: freed.barberId, barberName: candidate.barber.name };
      const offer = await this.prisma.appointmentOffer.create({
        data: {
          tenantId,
          appointmentId: candidate.id,
          type: OfferType.ADVANCE,
          options: [option] as unknown as Prisma.InputJsonValue,
          expiresAt,
        },
      });
      const minutes = Math.max(1, Math.round((expiresAt.getTime() - now.getTime()) / 60_000));
      await this.messaging.send(
        tenantId,
        candidate.customer.phone,
        Messages.advanceOffer(this.view(candidate), freed.startsAt, candidate.barber.name, tenant.timezone, minutes),
        { customerId: candidate.customerId },
      );
      return offer;
    }
    return null;
  }

  /** Envia ao cliente opções de novo horário (barbeiro não pode atender). */
  async createRescheduleOffer(tenantId: string, appointment: AppointmentFull, now = new Date()): Promise<AppointmentOffer> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const fromDate = localDate(appointment.startsAt > now ? appointment.startsAt : now, tenant.timezone);
    const slots = await this.availability.nextSlots(
      tenantId,
      { serviceId: appointment.serviceId, fromDate, limit: 3, excludeAppointmentId: appointment.id },
      now,
    );
    const options: OfferOption[] = slots.map((s) => ({ startsAt: s.startsAt, barberId: s.barberId, barberName: s.barberName }));

    await this.cancelPendingFor(appointment.id);
    const offer = await this.prisma.appointmentOffer.create({
      data: {
        tenantId,
        appointmentId: appointment.id,
        type: OfferType.RESCHEDULE,
        options: options as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(now.getTime() + RESCHEDULE_OFFER_HOURS * 3600_000),
      },
    });
    const text = options.length
      ? Messages.rescheduleOffer(
          tenant.name,
          this.view(appointment),
          options.map((o) => ({ startsAt: new Date(o.startsAt), barberName: o.barberName })),
          tenant.timezone,
        )
      : Messages.rescheduleNoOptions(tenant.name, this.view(appointment), tenant.timezone);
    await this.messaging.send(tenantId, appointment.customer.phone, text, { customerId: appointment.customerId });
    return offer;
  }

  async findPendingForCustomer(tenantId: string, customerId: string, now = new Date()) {
    return this.prisma.appointmentOffer.findFirst({
      where: { tenantId, status: OfferStatus.PENDING, expiresAt: { gt: now }, appointment: { customerId } },
      include: { appointment: { include: APPOINTMENT_INCLUDE } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Tenta tratar a mensagem do cliente como resposta a uma proposta pendente.
   * Retorna true se tratou (e já respondeu ao cliente).
   */
  async handleReply(tenantId: string, customerId: string, text: string, now = new Date()): Promise<boolean> {
    const offer = await this.findPendingForCustomer(tenantId, customerId, now);
    if (!offer) return false;

    const options = offer.options as unknown as OfferOption[];
    const reply = parseOfferReply(text, options.length);
    if (!reply) return false;

    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const appointment = offer.appointment;
    const phone = appointment.customer.phone;
    const send = (body: string) => this.messaging.send(tenantId, phone, body, { customerId });

    if (reply.kind === 'cancel') {
      if (offer.type === OfferType.ADVANCE) return false; // cancelamento normal (IA/fluxo padrão)
      await this.respond(offer.id, OfferStatus.CANCELED, now);
      await this.prisma.appointment.update({
        where: { id: appointment.id },
        data: { status: AppointmentStatus.CANCELED, canceledAt: now, cancelReason: 'Cliente cancelou na remarcação' },
      });
      await send(Messages.canceledByCustomer(this.view(appointment), tenant.timezone));
      return true;
    }

    if (reply.kind === 'decline') {
      await this.respond(offer.id, OfferStatus.DECLINED, now);
      if (offer.type === OfferType.ADVANCE) {
        await send(Messages.offerDeclinedAdvance());
        await this.offerFreedSlot(tenantId, { barberId: options[0].barberId, startsAt: new Date(options[0].startsAt) }, now);
      } else {
        await send(Messages.offerDeclinedReschedule());
      }
      return true;
    }

    const chosen = options[reply.index];
    const previousSlot = { barberId: appointment.barberId, startsAt: appointment.startsAt };
    try {
      const moved = await this.writer.move(
        tenantId,
        appointment,
        { startsAt: new Date(chosen.startsAt), barberId: chosen.barberId },
        now,
      );
      await this.respond(offer.id, OfferStatus.ACCEPTED, now);
      await send(Messages.offerAccepted(this.view(moved), tenant.timezone));
      const movedInfo = { id: moved.id, customerName: moved.customer.name, serviceName: moved.service.name, barberName: moved.barber.name, startsAt: moved.startsAt, priceCents: moved.priceCents };
      await this.push.notifyStaff(
        tenantId,
        moved.barberId,
        offer.type === OfferType.ADVANCE ? Push.advanceAccepted(movedInfo, tenant.timezone) : Push.rescheduleAccepted(movedInfo, tenant.timezone),
      );
      if (offer.type === OfferType.ADVANCE && appointment.status !== AppointmentStatus.RESCHEDULE_PENDING) {
        // O horário antigo deste cliente vagou: continua a cadeia.
        await this.offerFreedSlot(tenantId, previousSlot, now);
      }
    } catch (err) {
      if (!(err instanceof BadRequestException)) throw err;
      if (offer.type === OfferType.ADVANCE) {
        await this.respond(offer.id, OfferStatus.EXPIRED, now);
        await send(Messages.offerTaken());
      } else {
        await this.createRescheduleOffer(tenantId, appointment, now);
      }
    }
    return true;
  }

  /** Executado pelo cron: expira propostas e passa a vez para o próximo cliente. */
  async expireOffers(now = new Date()): Promise<number> {
    const expired = await this.prisma.appointmentOffer.findMany({
      where: { status: OfferStatus.PENDING, expiresAt: { lte: now } },
      include: { appointment: { include: APPOINTMENT_INCLUDE } },
      take: 200,
    });
    for (const offer of expired) {
      try {
        await this.respond(offer.id, OfferStatus.EXPIRED, now);
        const options = offer.options as unknown as OfferOption[];
        if (offer.type === OfferType.ADVANCE && options[0]) {
          await this.offerFreedSlot(offer.tenantId, { barberId: options[0].barberId, startsAt: new Date(options[0].startsAt) }, now);
        } else if (offer.type === OfferType.RESCHEDULE) {
          await this.push.notifyStaff(
            offer.tenantId,
            offer.appointment.barberId,
            Push.rescheduleNoReply(offer.appointment.customer.name ?? offer.appointment.customer.phone, offer.appointmentId),
          );
        }
      } catch (err) {
        this.logger.error(`Falha ao expirar proposta ${offer.id}: ${(err as Error).message}`);
      }
    }
    return expired.length;
  }

  async cancelPendingFor(appointmentId: string): Promise<void> {
    await this.prisma.appointmentOffer.updateMany({
      where: { appointmentId, status: OfferStatus.PENDING },
      data: { status: OfferStatus.CANCELED },
    });
  }

  private async respond(id: string, status: OfferStatus, now: Date): Promise<void> {
    await this.prisma.appointmentOffer.update({ where: { id }, data: { status, respondedAt: now } });
  }

  private view(a: AppointmentFull) {
    return { customerName: a.customer.name, serviceName: a.service.name, barberName: a.barber.name, startsAt: a.startsAt };
  }
}
