import { BadRequestException } from '@nestjs/common';
import { AppointmentStatus, OfferStatus, OfferType } from '@prisma/client';
import { createPrismaMock, PrismaMock, TENANT } from '../../testing/prisma-mock';
import { OffersService } from './offers.service';

const NOW = new Date('2026-10-24T12:00:00Z'); // 09:00 em São Paulo
const FREED = new Date('2026-10-24T13:00:00Z'); // 10:00 local

const appt = (id: string, startsAt: string, duration = 30, over: Record<string, unknown> = {}) => ({
  id,
  tenantId: 't1',
  customerId: `c-${id}`,
  barberId: 'b1',
  serviceId: 's1',
  status: AppointmentStatus.SCHEDULED,
  startsAt: new Date(startsAt),
  endsAt: new Date(new Date(startsAt).getTime() + duration * 60_000),
  customer: { id: `c-${id}`, name: `Cliente ${id}`, phone: `55119000000${id.length}` },
  service: { id: 's1', name: 'Corte', durationMinutes: duration },
  barber: { id: 'b1', name: 'João' },
  ...over,
});

describe('OffersService', () => {
  let prisma: PrismaMock;
  let availability: { assertSlotAvailable: jest.Mock; nextSlots: jest.Mock };
  let writer: { move: jest.Mock };
  let messaging: { send: jest.Mock };
  let push: { notifyUser: jest.Mock; notifyOwners: jest.Mock; notifyStaff: jest.Mock };
  let service: OffersService;

  beforeEach(() => {
    prisma = createPrismaMock();
    availability = { assertSlotAvailable: jest.fn().mockResolvedValue(undefined), nextSlots: jest.fn().mockResolvedValue([]) };
    writer = { move: jest.fn() };
    messaging = { send: jest.fn().mockResolvedValue('log') };
    push = { notifyUser: jest.fn(), notifyOwners: jest.fn(), notifyStaff: jest.fn() };
    prisma.tenant.findUnique.mockResolvedValue(TENANT);
    prisma.tenant.findUniqueOrThrow.mockResolvedValue(TENANT);
    prisma.appointmentOffer.create.mockImplementation(async ({ data }: any) => ({ id: 'offer-new', ...data }));
    service = new OffersService(prisma as any, availability as any, writer as any, messaging as any, push as any);
  });

  describe('offerFreedSlot (adiantar)', () => {
    it('oferece ao próximo cliente cujo serviço cabe no horário vago', async () => {
      const long = appt('a1', '2026-10-24T14:00:00Z', 90);
      const short = appt('a2', '2026-10-24T15:00:00Z', 30);
      prisma.appointment.findMany.mockResolvedValue([long, short]);
      availability.assertSlotAvailable
        .mockRejectedValueOnce(new BadRequestException('não cabe'))
        .mockResolvedValueOnce(undefined);

      const offer = await service.offerFreedSlot('t1', { barberId: 'b1', startsAt: FREED }, NOW);

      expect(offer).toMatchObject({ appointmentId: 'a2', type: OfferType.ADVANCE });
      expect(messaging.send).toHaveBeenCalledTimes(1);
      expect(messaging.send.mock.calls[0][1]).toBe(short.customer.phone);
      expect(messaging.send.mock.calls[0][2]).toContain('VAGA LIBERADA');
      expect(messaging.send.mock.calls[0][2]).toContain('Responde *SIM* ou *NÃO*');
      // expira em 15 min (offerTimeoutMinutes)
      expect(offer!.expiresAt).toEqual(new Date(NOW.getTime() + 15 * 60_000));
    });

    it('não repete clientes que já recusaram este horário', async () => {
      prisma.appointmentOffer.findMany.mockResolvedValue([
        { appointmentId: 'a1', status: OfferStatus.DECLINED, options: [{ startsAt: FREED.toISOString(), barberId: 'b1' }] },
      ]);
      prisma.appointment.findMany.mockResolvedValue([appt('a1', '2026-10-24T14:00:00Z'), appt('a2', '2026-10-24T15:00:00Z')]);
      const offer = await service.offerFreedSlot('t1', { barberId: 'b1', startsAt: FREED }, NOW);
      expect(offer!.appointmentId).toBe('a2');
    });

    it('não cria proposta duplicada se já há uma pendente para o horário', async () => {
      prisma.appointmentOffer.findMany.mockResolvedValue([
        { appointmentId: 'a1', status: OfferStatus.PENDING, options: [{ startsAt: FREED.toISOString(), barberId: 'b1' }] },
      ]);
      await expect(service.offerFreedSlot('t1', { barberId: 'b1', startsAt: FREED }, NOW)).resolves.toBeNull();
      expect(prisma.appointment.findMany).not.toHaveBeenCalled();
    });

    it('ignora horários que começam muito em breve', async () => {
      const soon = new Date(NOW.getTime() + 5 * 60_000);
      await expect(service.offerFreedSlot('t1', { barberId: 'b1', startsAt: soon }, NOW)).resolves.toBeNull();
    });

    it('pula cliente que já tem outra proposta pendente', async () => {
      prisma.appointment.findMany.mockResolvedValue([appt('a1', '2026-10-24T14:00:00Z'), appt('a2', '2026-10-24T15:00:00Z')]);
      prisma.appointmentOffer.findFirst.mockResolvedValueOnce({ id: 'other' }).mockResolvedValueOnce(null);
      const offer = await service.offerFreedSlot('t1', { barberId: 'b1', startsAt: FREED }, NOW);
      expect(offer!.appointmentId).toBe('a2');
    });
  });

  describe('handleReply', () => {
    const pending = (type: OfferType, options: unknown[], appointment = appt('a2', '2026-10-24T15:00:00Z')) => ({
      id: 'o1',
      tenantId: 't1',
      type,
      status: OfferStatus.PENDING,
      options,
      appointmentId: appointment.id,
      appointment,
    });
    const advanceOption = [{ startsAt: FREED.toISOString(), barberId: 'b1', barberName: 'João' }];

    it('sem proposta pendente retorna false', async () => {
      prisma.appointmentOffer.findFirst.mockResolvedValue(null);
      await expect(service.handleReply('t1', 'c', 'sim', NOW)).resolves.toBe(false);
    });

    it('mensagem que não é resposta retorna false (IA assume)', async () => {
      prisma.appointmentOffer.findFirst.mockResolvedValue(pending(OfferType.ADVANCE, advanceOption));
      await expect(service.handleReply('t1', 'c', 'qual o preço da barba?', NOW)).resolves.toBe(false);
    });

    it('SIM adianta o horário e oferece o horário antigo ao próximo (cadeia)', async () => {
      const original = appt('a2', '2026-10-24T15:00:00Z');
      prisma.appointmentOffer.findFirst.mockResolvedValue(pending(OfferType.ADVANCE, advanceOption, original));
      writer.move.mockResolvedValue({ ...original, startsAt: FREED });
      const chain = jest.spyOn(service, 'offerFreedSlot').mockResolvedValue(null);

      await expect(service.handleReply('t1', 'c-a2', 'Sim', NOW)).resolves.toBe(true);

      expect(writer.move).toHaveBeenCalledWith('t1', original, { startsAt: FREED, barberId: 'b1' }, NOW);
      expect(prisma.appointmentOffer.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: OfferStatus.ACCEPTED }) }),
      );
      expect(messaging.send.mock.calls[0][2]).toContain('Feito!');
      expect(chain).toHaveBeenCalledWith('t1', { barberId: 'b1', startsAt: original.startsAt }, NOW);
      expect(push.notifyStaff).toHaveBeenCalledWith('t1', 'b1', expect.objectContaining({ title: '⚡ HORÁRIO ADIANTADO' }));
    });

    it('NÃO mantém o horário e passa a vez para o próximo', async () => {
      prisma.appointmentOffer.findFirst.mockResolvedValue(pending(OfferType.ADVANCE, advanceOption));
      const next = jest.spyOn(service, 'offerFreedSlot').mockResolvedValue(null);
      await service.handleReply('t1', 'c', 'não', NOW);
      expect(prisma.appointmentOffer.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: OfferStatus.DECLINED }) }),
      );
      expect(next).toHaveBeenCalledWith('t1', { barberId: 'b1', startsAt: FREED }, NOW);
    });

    it('horário já preenchido: avisa e mantém o original', async () => {
      prisma.appointmentOffer.findFirst.mockResolvedValue(pending(OfferType.ADVANCE, advanceOption));
      writer.move.mockRejectedValue(new BadRequestException('Horário indisponível'));
      await service.handleReply('t1', 'c', 'sim', NOW);
      expect(messaging.send.mock.calls[0][2]).toContain('acabou de ser preenchido');
    });

    it('remarcação: número escolhe a opção', async () => {
      const opts = [
        { startsAt: '2026-10-25T13:00:00.000Z', barberId: 'b2', barberName: 'Pedro' },
        { startsAt: '2026-10-25T14:00:00.000Z', barberId: 'b1', barberName: 'João' },
      ];
      const original = appt('a3', '2026-10-24T15:00:00Z', 30, { status: AppointmentStatus.RESCHEDULE_PENDING });
      prisma.appointmentOffer.findFirst.mockResolvedValue(pending(OfferType.RESCHEDULE, opts, original));
      writer.move.mockResolvedValue({ ...original, startsAt: new Date(opts[1].startsAt), barberId: 'b1' });
      const chain = jest.spyOn(service, 'offerFreedSlot');

      await service.handleReply('t1', 'c', '2', NOW);

      expect(writer.move).toHaveBeenCalledWith('t1', original, { startsAt: new Date(opts[1].startsAt), barberId: 'b1' }, NOW);
      expect(chain).not.toHaveBeenCalled(); // barbeiro original está indisponível
    });

    it('remarcação: CANCELAR cancela o agendamento', async () => {
      prisma.appointmentOffer.findFirst.mockResolvedValue(
        pending(OfferType.RESCHEDULE, [{ startsAt: '2026-10-25T13:00:00.000Z', barberId: 'b2', barberName: 'Pedro' }]),
      );
      await service.handleReply('t1', 'c', 'cancelar', NOW);
      expect(prisma.appointment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: AppointmentStatus.CANCELED }) }),
      );
    });
  });

  describe('createRescheduleOffer', () => {
    it('envia até 3 opções numeradas', async () => {
      availability.nextSlots.mockResolvedValue([
        { startsAt: '2026-10-25T13:00:00.000Z', barberId: 'b2', barberName: 'Pedro' },
        { startsAt: '2026-10-25T14:00:00.000Z', barberId: 'b2', barberName: 'Pedro' },
      ]);
      await service.createRescheduleOffer('t1', appt('a1', '2026-10-24T15:00:00Z') as any, NOW);
      const text: string = messaging.send.mock.calls[0][2];
      expect(text).toContain('*1* -');
      expect(text).toContain('*2* -');
      expect(prisma.appointmentOffer.create.mock.calls[0][0].data.type).toBe(OfferType.RESCHEDULE);
    });

    it('sem horários disponíveis orienta o cliente a remarcar pelo menu', async () => {
      await service.createRescheduleOffer('t1', appt('a1', '2026-10-24T15:00:00Z') as any, NOW);
      expect(messaging.send.mock.calls[0][2]).toContain('Responde *REMARCAR*');
    });
  });

  it('expireOffers: proposta de adiantar expirada passa para o próximo', async () => {
    prisma.appointmentOffer.findMany.mockResolvedValueOnce([
      {
        id: 'o1',
        tenantId: 't1',
        type: OfferType.ADVANCE,
        options: [{ startsAt: FREED.toISOString(), barberId: 'b1' }],
        appointment: appt('a1', '2026-10-24T15:00:00Z'),
      },
    ]);
    const next = jest.spyOn(service, 'offerFreedSlot').mockResolvedValue(null);
    await expect(service.expireOffers(NOW)).resolves.toBe(1);
    expect(next).toHaveBeenCalledWith('t1', { barberId: 'b1', startsAt: FREED }, NOW);
  });
});
