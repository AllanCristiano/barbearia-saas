import { BadRequestException } from '@nestjs/common';
import { createPrismaMock, PrismaMock, TENANT } from '../../testing/prisma-mock';
import { AvailabilityService } from './availability.service';

const NOW = new Date('2026-10-24T12:00:00Z'); // sábado 09:00 em São Paulo

describe('AvailabilityService', () => {
  let prisma: PrismaMock;
  let service: AvailabilityService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.tenant.findUnique.mockResolvedValue({ ...TENANT, slotStepMinutes: 30 });
    prisma.service.findFirst.mockResolvedValue({ id: 's1', durationMinutes: 30 });
    prisma.workingHour.findMany.mockResolvedValue([{ startMinute: 9 * 60, endMinute: 11 * 60 }]);
    service = new AvailabilityService(prisma as any);
  });

  it('lista horários livres de cada barbeiro, em UTC, excluindo ocupados', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'b1', name: 'João' }]);
    prisma.appointment.findMany.mockResolvedValue([
      { startsAt: new Date('2026-10-25T13:00:00Z'), endsAt: new Date('2026-10-25T13:30:00Z') }, // 10:00 local
    ]);
    const slots = await service.getSlots('t1', { serviceId: 's1', date: '2026-10-25' }, NOW);
    expect(slots.map((s) => s.time)).toEqual(['09:00', '09:30', '10:30']);
    expect(slots[0]).toMatchObject({ barberId: 'b1', startsAt: '2026-10-25T12:00:00.000Z' });
  });

  it('hoje: não mostra horários que já passaram (+ antecedência mínima)', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'b1', name: 'João' }]);
    const slots = await service.getSlots('t1', { serviceId: 's1', date: '2026-10-24' }, NOW);
    expect(slots.map((s) => s.time)).toEqual(['09:30', '10:00', '10:30']);
  });

  it('datas fora da janela de agendamento retornam vazio', async () => {
    await expect(service.getSlots('t1', { serviceId: 's1', date: '2026-10-23' }, NOW)).resolves.toEqual([]);
    await expect(service.getSlots('t1', { serviceId: 's1', date: '2027-01-30' }, NOW)).resolves.toEqual([]);
  });

  it('folga (TimeOff) bloqueia o dia inteiro', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'b1', name: 'João' }]);
    prisma.timeOff.findMany.mockResolvedValue([
      { startsAt: new Date('2026-10-25T03:00:00Z'), endsAt: new Date('2026-10-26T03:00:00Z') },
    ]);
    await expect(service.getSlots('t1', { serviceId: 's1', date: '2026-10-25' }, NOW)).resolves.toEqual([]);
  });

  describe('assertSlotAvailable', () => {
    it('aceita horário livre dentro do expediente', async () => {
      await expect(
        service.assertSlotAvailable(prisma as any, 't1', { barberId: 'b1', startsAt: new Date('2026-10-25T12:30:00Z'), durationMinutes: 30 }, NOW),
      ).resolves.toBeUndefined();
    });

    it('horário já ocupado → "acabou de ser ocupado" (código SLOT_TAKEN)', async () => {
      prisma.appointment.findMany.mockResolvedValue([{ startsAt: new Date('2026-10-25T12:30:00Z'), endsAt: new Date('2026-10-25T13:00:00Z') }]);
      const err = await service
        .assertSlotAvailable(prisma as any, 't1', { barberId: 'b1', startsAt: new Date('2026-10-25T12:30:00Z'), durationMinutes: 30 }, NOW)
        .catch((e) => e);
      expect(err.message).toContain('acabou de ser ocupado');
      expect(err.getResponse()).toMatchObject({ code: 'SLOT_TAKEN' });
    });

    it('rejeita fora do expediente', async () => {
      await expect(
        service.assertSlotAvailable(prisma as any, 't1', { barberId: 'b1', startsAt: new Date('2026-10-25T13:45:00Z'), durationMinutes: 30 }, NOW),
      ).rejects.toThrow('fora do expediente');
    });

    it('rejeita horário no passado', async () => {
      await expect(
        service.assertSlotAvailable(prisma as any, 't1', { barberId: 'b1', startsAt: new Date('2026-10-24T11:00:00Z'), durationMinutes: 30 }, NOW),
      ).rejects.toThrow('passou');
    });

    it('exclui o próprio agendamento ao remarcar', async () => {
      await service.assertSlotAvailable(
        prisma as any,
        't1',
        { barberId: 'b1', startsAt: new Date('2026-10-25T12:30:00Z'), durationMinutes: 30, excludeAppointmentId: 'a1' },
        NOW,
      );
      expect(prisma.appointment.findMany.mock.calls[0][0].where.id).toEqual({ not: 'a1' });
    });
  });
});
