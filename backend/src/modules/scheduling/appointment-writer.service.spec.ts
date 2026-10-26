import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, PrismaMock } from '../../testing/prisma-mock';
import { AppointmentWriter, isOverlapViolation } from './appointment-writer.service';
import { SLOT_TAKEN_CODE, SLOT_TAKEN_MESSAGE } from './availability.service';

const NOW = new Date('2026-10-24T12:00:00Z');
const input = { customerId: 'c1', serviceId: 's1', barberId: 'b1', startsAt: new Date('2026-10-26T12:00:00Z'), source: 'APP' as const };

describe('AppointmentWriter (concorrência)', () => {
  let prisma: PrismaMock;
  let availability: { assertSlotAvailable: jest.Mock };
  let writer: AppointmentWriter;
  const order: string[] = [];

  beforeEach(() => {
    order.length = 0;
    prisma = createPrismaMock();
    prisma.service.findFirst.mockResolvedValue({ id: 's1', durationMinutes: 30, priceCents: 4000 });
    prisma.user.findFirst.mockResolvedValue({ id: 'b1' });
    prisma.customer.findFirst.mockResolvedValue({ id: 'c1' });
    prisma.$executeRaw.mockImplementation(async () => order.push('lock'));
    availability = { assertSlotAvailable: jest.fn(async () => void order.push('check')) };
    prisma.appointment.create.mockImplementation(async () => {
      order.push('insert');
      return { id: 'a1' };
    });
    writer = new AppointmentWriter(prisma as any, availability as any);
  });

  it('trava a agenda do barbeiro ANTES de conferir e gravar (tudo na mesma transação)', async () => {
    await writer.book('t1', input, NOW);
    expect(order).toEqual(['lock', 'check', 'insert']);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // a conferência usa o client da transação, que já vê o que o pedido anterior gravou
    expect(availability.assertSlotAvailable.mock.calls[0][0]).toBe(prisma);
  });

  it('recusa do banco (exclusion constraint) vira "horário ocupado"', async () => {
    prisma.appointment.create.mockRejectedValue(
      new Prisma.PrismaClientUnknownRequestError(
        'conflicting key value violates exclusion constraint "Appointment_no_overlap" (23P01)',
        { clientVersion: '6' },
      ),
    );
    const err = await writer.book('t1', input, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(SLOT_TAKEN_MESSAGE);
    expect(err.getResponse()).toMatchObject({ code: SLOT_TAKEN_CODE });
  });

  it('outros erros do banco não são mascarados', async () => {
    prisma.appointment.create.mockRejectedValue(new Error('connection lost'));
    await expect(writer.book('t1', input, NOW)).rejects.toThrow('connection lost');
  });

  it('remarcar também passa pela trava do barbeiro de destino', async () => {
    prisma.appointment.update.mockImplementation(async () => {
      order.push('update');
      return { id: 'a1' };
    });
    await writer.move('t1', { id: 'a1', serviceId: 's1' }, { startsAt: input.startsAt, barberId: 'b2' }, NOW);
    expect(order).toEqual(['lock', 'check', 'update']);
    expect(availability.assertSlotAvailable.mock.calls[0][2]).toMatchObject({ barberId: 'b2', excludeAppointmentId: 'a1' });
  });

  it('isOverlapViolation reconhece pelo nome da constraint ou pelo SQLSTATE', () => {
    expect(isOverlapViolation(new Error('... "Appointment_no_overlap" ...'))).toBe(true);
    expect(isOverlapViolation({ message: 'x', meta: { code: '23P01' } })).toBe(true);
    expect(isOverlapViolation(new Error('unique constraint'))).toBe(false);
  });
});
