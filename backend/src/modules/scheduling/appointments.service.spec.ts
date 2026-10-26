import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AppointmentStatus, Role } from '@prisma/client';
import { TenantUser } from '../../common/auth/auth-user';
import { createPrismaMock, PrismaMock, TENANT } from '../../testing/prisma-mock';
import { AppointmentsService } from './appointments.service';

const NOW = new Date('2026-10-24T12:00:00Z');
const owner: TenantUser = { sub: 'owner', tenantId: 't1', role: Role.OWNER, email: 'o@x.com' };
const barber: TenantUser = { sub: 'b1', tenantId: 't1', role: Role.BARBER, email: 'b@x.com' };

const appointment = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  tenantId: 't1',
  customerId: 'c1',
  barberId: 'b1',
  serviceId: 's1',
  status: AppointmentStatus.SCHEDULED,
  startsAt: new Date('2026-10-24T17:00:00Z'),
  endsAt: new Date('2026-10-24T17:30:00Z'),
  priceCents: 4000,
  customer: { id: 'c1', name: 'Carlos', phone: '5511988887777' },
  service: { id: 's1', name: 'Corte', durationMinutes: 30 },
  barber: { id: 'b1', name: 'João' },
  ...over,
});

describe('AppointmentsService', () => {
  let prisma: PrismaMock;
  let writer: { book: jest.Mock; move: jest.Mock };
  let offers: { offerFreedSlot: jest.Mock; cancelPendingFor: jest.Mock; createRescheduleOffer: jest.Mock };
  let messaging: { send: jest.Mock };
  let push: { notifyUser: jest.Mock; notifyStaff: jest.Mock };
  let service: AppointmentsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    writer = { book: jest.fn(), move: jest.fn() };
    offers = { offerFreedSlot: jest.fn(), cancelPendingFor: jest.fn(), createRescheduleOffer: jest.fn() };
    messaging = { send: jest.fn() };
    push = { notifyUser: jest.fn(), notifyStaff: jest.fn() };
    prisma.tenant.findUniqueOrThrow.mockResolvedValue(TENANT);
    prisma.appointment.update.mockImplementation(async ({ data }: any) => ({ ...appointment(), ...data }));
    service = new AppointmentsService(prisma as any, writer as any, offers as any, messaging as any, push as any);
  });

  describe('create', () => {
    it('pelo app: confirma ao cliente no WhatsApp e avisa o barbeiro', async () => {
      writer.book.mockResolvedValue(appointment());
      await service.create('t1', { customerId: 'c1', serviceId: 's1', barberId: 'b1', startsAt: NOW }, { kind: 'staff', user: owner }, NOW);
      expect(writer.book).toHaveBeenCalledWith('t1', expect.objectContaining({ source: 'APP' }), NOW);
      expect(messaging.send.mock.calls[0][2]).toContain('está confirmado');
      // barbeiro + donos, sem notificar quem agendou (o dono, aqui)
      expect(push.notifyStaff).toHaveBeenCalledWith(
        't1',
        'b1',
        expect.objectContaining({ title: '✂️ NOVO CLIENTE NA CADEIRA', channel: 'agendamentos', data: { type: 'APPOINTMENT_NEW', appointmentId: 'a1' } }),
        'owner',
      );
    });

    it('barbeiro não agenda na agenda de outro', async () => {
      await expect(
        service.create('t1', { customerId: 'c1', serviceId: 's1', barberId: 'b2', startsAt: NOW }, { kind: 'staff', user: barber }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cliente só agenda para si mesmo', async () => {
      await expect(
        service.create('t1', { customerId: 'outro', serviceId: 's1', barberId: 'b1', startsAt: NOW }, { kind: 'customer', customerId: 'c1' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('cancel', () => {
    it('cliente não cancela com menos antecedência que o mínimo', async () => {
      prisma.appointment.findFirst.mockResolvedValue(appointment({ startsAt: new Date(NOW.getTime() + 60 * 60_000) }));
      await expect(service.cancel('t1', 'a1', { kind: 'customer', customerId: 'c1' }, undefined, NOW)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('cliente cancela: avisa o barbeiro e oferece o horário ao próximo', async () => {
      prisma.appointment.findFirst.mockResolvedValue(appointment());
      await service.cancel('t1', 'a1', { kind: 'customer', customerId: 'c1' }, 'imprevisto', NOW);
      expect(push.notifyStaff).toHaveBeenCalledWith('t1', 'b1', expect.objectContaining({ title: '❌ HORÁRIO CANCELADO', channel: 'cancelamentos' }));
      expect(offers.offerFreedSlot).toHaveBeenCalledWith('t1', { barberId: 'b1', startsAt: appointment().startsAt }, NOW);
      expect(messaging.send).not.toHaveBeenCalled();
    });

    it('barbearia cancela: avisa o cliente no WhatsApp', async () => {
      prisma.appointment.findFirst.mockResolvedValue(appointment());
      await service.cancel('t1', 'a1', { kind: 'staff', user: owner }, 'Barbeiro doente', NOW);
      expect(messaging.send.mock.calls[0][2]).toContain('Precisamos cancelar teu horário');
      expect(messaging.send.mock.calls[0][2]).toContain('(Barbeiro doente)');
    });

    it('barbeiro não acessa agendamento de outro barbeiro', async () => {
      prisma.appointment.findFirst.mockResolvedValue(appointment({ barberId: 'b2' }));
      await expect(service.cancel('t1', 'a1', { kind: 'staff', user: barber })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('não cancela agendamento concluído', async () => {
      prisma.appointment.findFirst.mockResolvedValue(appointment({ status: AppointmentStatus.COMPLETED }));
      await expect(service.cancel('t1', 'a1', { kind: 'staff', user: owner })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('consulta sempre filtrando pelo tenant (isolamento)', async () => {
      prisma.appointment.findFirst.mockResolvedValue(appointment());
      await service.cancel('t1', 'a1', { kind: 'staff', user: owner }, undefined, NOW);
      expect(prisma.appointment.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'a1', tenantId: 't1' });
    });
  });

  describe('reschedule', () => {
    it('pela barbearia: move, avisa o cliente e oferece o horário antigo', async () => {
      const old = appointment();
      prisma.appointment.findFirst.mockResolvedValue(old);
      const target = new Date('2026-10-24T19:00:00Z');
      writer.move.mockResolvedValue(appointment({ startsAt: target }));
      await service.reschedule('t1', 'a1', { startsAt: target }, { kind: 'staff', user: owner }, NOW);
      expect(writer.move).toHaveBeenCalledWith('t1', old, { startsAt: target, barberId: 'b1' }, NOW);
      expect(messaging.send.mock.calls[0][2]).toContain('foi remarcado');
      expect(offers.offerFreedSlot).toHaveBeenCalledWith('t1', { barberId: 'b1', startsAt: old.startsAt }, NOW);
    });
  });

  describe('markUnavailable', () => {
    it('bloqueia o dia e envia opções de remarcação para cada cliente afetado', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'b1' });
      prisma.timeOff.create.mockResolvedValue({ id: 'off1' });
      prisma.appointment.findMany.mockResolvedValue([appointment(), appointment({ id: 'a2' })]);

      const r = await service.markUnavailable('t1', barber, { date: '2026-10-24', reason: 'Médico' }, NOW);

      expect(r).toEqual({ timeOffId: 'off1', affected: 2 });
      const created = prisma.timeOff.create.mock.calls[0][0].data;
      expect(created.startsAt.toISOString()).toBe('2026-10-24T03:00:00.000Z');
      expect(created.endsAt.toISOString()).toBe('2026-10-25T03:00:00.000Z');
      expect(offers.createRescheduleOffer).toHaveBeenCalledTimes(2);
      expect(prisma.appointment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: AppointmentStatus.RESCHEDULE_PENDING } }),
      );
    });

    it('barbeiro sempre marca para si (ignora barberId de outro)', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'b1' });
      prisma.timeOff.create.mockResolvedValue({ id: 'off1' });
      await service.markUnavailable('t1', barber, { date: '2026-10-24', barberId: 'b2' }, NOW);
      expect(prisma.timeOff.create.mock.calls[0][0].data.barberId).toBe('b1');
    });

    it('período parcial', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'b1' });
      prisma.timeOff.create.mockResolvedValue({ id: 'off1' });
      await service.markUnavailable('t1', owner, { date: '2026-10-24', barberId: 'b1', startTime: '14:00', endTime: '16:00' }, NOW);
      const data = prisma.timeOff.create.mock.calls[0][0].data;
      expect(data.startsAt.toISOString()).toBe('2026-10-24T17:00:00.000Z');
      expect(data.endsAt.toISOString()).toBe('2026-10-24T19:00:00.000Z');
    });
  });

  it('updateStatus rejeita transição inválida', async () => {
    prisma.appointment.findFirst.mockResolvedValue(appointment({ status: AppointmentStatus.CANCELED }));
    await expect(service.updateStatus('t1', owner, 'a1', AppointmentStatus.COMPLETED)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('concluir atualiza a última visita do cliente', async () => {
    prisma.appointment.findFirst.mockResolvedValue(appointment({ status: AppointmentStatus.IN_PROGRESS }));
    await service.updateStatus('t1', owner, 'a1', AppointmentStatus.COMPLETED);
    expect(prisma.customer.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1' } }));
  });

  it('daySummary calcula faturamento e próximo cliente', async () => {
    prisma.appointment.findMany.mockResolvedValue([
      appointment({ id: 'x1', status: AppointmentStatus.COMPLETED, endsAt: new Date('2026-10-24T11:30:00Z') }),
      appointment({ id: 'x2', status: AppointmentStatus.CANCELED }),
      appointment({ id: 'x3', status: AppointmentStatus.CONFIRMED }),
    ]);
    prisma.tenant.findUniqueOrThrow.mockResolvedValue(TENANT);
    const s = await service.daySummary('t1', owner, '2026-10-24', undefined, NOW);
    expect(s.total).toBe(2);
    expect(s.completedRevenueCents).toBe(4000);
    expect(s.expectedRevenueCents).toBe(8000);
    expect(s.next?.id).toBe('x3');
  });
});
