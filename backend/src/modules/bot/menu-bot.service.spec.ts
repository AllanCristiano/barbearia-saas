import { BadRequestException } from '@nestjs/common';
import { createPrismaMock, PrismaMock, TENANT } from '../../testing/prisma-mock';
import { BotState, MenuBotService, pickIndex, STATE_TTL_MINUTES } from './menu-bot.service';

const NOW = new Date('2026-10-24T12:00:00Z'); // sábado 09:00 em São Paulo
const TOMORROW = '2026-10-25';

const slot = (startsAt: string, barberId: string, barberName: string) => ({ startsAt, barberId, barberName, time: '', date: TOMORROW });
const appointment = (id: string, startsAt = '2026-10-26T13:00:00Z') => ({
  id,
  startsAt: new Date(startsAt),
  service: { id: 's1', name: 'Corte' },
  barber: { id: 'b1', name: 'João' },
  priceCents: 4000,
});

describe('MenuBotService', () => {
  let prisma: PrismaMock;
  let availability: { getSlots: jest.Mock };
  let appointments: { create: jest.Mock; cancel: jest.Mock; reschedule: jest.Mock; upcomingForCustomer: jest.Mock };
  let push: { notifyOwners: jest.Mock };
  let bot: MenuBotService;
  let customer: any;
  let state: BotState;

  /** Simula o cliente enviando uma mensagem; o estado é carregado entre as mensagens. */
  const say = async (text: string, now = NOW) => {
    const r = await bot.handle({ tenant: TENANT, customer }, text, state, now);
    state = r.state;
    return r.reply;
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    availability = {
      getSlots: jest.fn(async (_t: string, q: { date: string }) =>
        q.date === TOMORROW
          ? [
              slot('2026-10-25T13:00:00.000Z', 'b1', 'João'),
              slot('2026-10-25T13:00:00.000Z', 'b2', 'Pedro'),
              slot('2026-10-25T13:30:00.000Z', 'b2', 'Pedro'),
            ]
          : [],
      ),
    };
    appointments = {
      create: jest.fn().mockResolvedValue({ ...appointment('new', '2026-10-25T13:00:00Z') }),
      cancel: jest.fn().mockResolvedValue(appointment('a1')),
      reschedule: jest.fn().mockResolvedValue({ ...appointment('a1', '2026-10-25T13:30:00Z'), barber: { name: 'Pedro' } }),
      upcomingForCustomer: jest.fn().mockResolvedValue([]),
    };
    push = { notifyOwners: jest.fn() };
    prisma.service.findMany.mockResolvedValue([
      { id: 's1', name: 'Corte', priceCents: 4000, durationMinutes: 30 },
      { id: 's2', name: 'Barba', priceCents: 3000, durationMinutes: 30 },
    ]);
    prisma.service.findFirst.mockImplementation(async ({ where }: any) =>
      where.id === 's1' ? { id: 's1', name: 'Corte' } : { id: 's2', name: 'Barba' },
    );
    prisma.user.findMany.mockResolvedValue([
      { id: 'b1', name: 'João' },
      { id: 'b2', name: 'Pedro' },
    ]);
    customer = { id: 'c1', name: 'Carlos', phone: '5511988887777' };
    state = {};
    bot = new MenuBotService(prisma as any, availability as any, appointments as any, push as any);
  });

  it('cliente novo: pergunta o nome antes de tudo e salva', async () => {
    customer.name = null;
    expect(await say('oi')).toContain('qual é o seu *nome*');
    expect(state.step).toBe('ASK_NAME');
    expect(await say('Carlos Souza')).toContain('Prazer, Carlos!');
    expect(prisma.customer.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { name: 'Carlos Souza' } });
    expect(state.step).toBe('MENU');
  });

  it('nome inválido pede de novo', async () => {
    customer.name = null;
    await say('oi');
    expect(await say('123')).toContain('teu nome');
    expect(state.step).toBe('ASK_NAME');
  });

  it('saudação mostra o menu', async () => {
    const reply = await say('Oi');
    expect(reply).toContain('Barbearia Teste');
    expect(reply).toContain('*1* - ✂️ Agendar meu corte');
    expect(state.step).toBe('MENU');
  });

  it('usa a saudação personalizada da barbearia', async () => {
    const reply = await bot.handle({ tenant: { ...TENANT, welcomeMessage: 'Fala, parceiro! 💈' }, customer }, 'oi', {}, NOW);
    expect(reply.reply).toContain('Fala, parceiro!');
  });

  it('fluxo completo de agendamento', async () => {
    await say('oi');
    expect(await say('1')).toContain('*2* - Barba');
    expect(await say('1')).toContain('*1* - Tanto faz');
    const days = await say('1');
    expect(days).toContain('*1* - Amanhã (domingo, 25/10)');
    const slots = await say('1');
    // sem preferência: um horário por instante, com o primeiro barbeiro livre
    expect(slots).toContain('*1* - 10:00 com João');
    expect(slots).toContain('*2* - 10:30 com Pedro');
    expect(slots).not.toContain('*3*');
    expect(await say('1')).toContain('Confirma o agendamento?');
    expect(await say('sim')).toContain('está confirmado');

    expect(appointments.create).toHaveBeenCalledWith(
      't1',
      { customerId: 'c1', serviceId: 's1', barberId: 'b1', startsAt: new Date('2026-10-25T13:00:00.000Z') },
      { kind: 'customer', customerId: 'c1' },
      NOW,
    );
    expect(state.step).toBeUndefined();
  });

  it('com barbeiro escolhido consulta só a agenda dele', async () => {
    await say('1');
    await say('1');
    await say('3'); // Pedro
    expect(availability.getSlots.mock.calls[0][1]).toMatchObject({ barberId: 'b2' });
  });

  it('opção inválida mantém a etapa; 0 volta ao menu', async () => {
    await say('1');
    expect(await say('9')).toContain('Não entendi');
    expect(state.step).toBe('BOOK_SERVICE');
    expect(await say('0')).toContain('Bora deixar o visual no padrão?');
    expect(state.step).toBe('MENU');
  });

  it('horário ocupado na confirmação: avisa e mostra os horários de novo', async () => {
    appointments.create.mockRejectedValue(new BadRequestException('Horário indisponível'));
    for (const t of ['1', '1', '1', '1', '1']) await say(t);
    const reply = await say('1');
    expect(reply).toContain('acabou de ser ocupado');
    expect(reply).toContain('Qual horário?');
    expect(state.step).toBe('BOOK_SLOT');
  });

  it('sem horários nos próximos dias sugere falar com a barbearia', async () => {
    availability.getSlots.mockResolvedValue([]);
    await say('1'); // agendar
    await say('1'); // serviço
    expect(await say('1')).toContain('Não encontrei horários livres');
  });

  it('meus horários', async () => {
    appointments.upcomingForCustomer.mockResolvedValue([appointment('a1')]);
    expect(await say('2')).toContain('Corte com João');
  });

  describe('cancelar', () => {
    it('com um único horário pede confirmação direto', async () => {
      appointments.upcomingForCustomer.mockResolvedValue([appointment('a1')]);
      expect(await say('cancelar')).toContain('*1* - Sim, cancelar');
      expect(await say('1')).toContain('foi cancelado');
      expect(appointments.cancel).toHaveBeenCalledWith('t1', 'a1', { kind: 'customer', customerId: 'c1' }, 'Cancelado pelo cliente', NOW);
    });

    it('"não" mantém o horário', async () => {
      appointments.upcomingForCustomer.mockResolvedValue([appointment('a1')]);
      await say('3');
      expect(await say('2')).toContain('mantido');
      expect(appointments.cancel).not.toHaveBeenCalled();
    });

    it('regra de antecedência mínima vira mensagem amigável', async () => {
      appointments.upcomingForCustomer.mockResolvedValue([appointment('a1')]);
      appointments.cancel.mockRejectedValue(new BadRequestException('Cancelamentos com menos de 2h ...'));
      await say('3');
      const reply = await say('1');
      expect(reply).toContain('⚠️ Cancelamentos com menos de 2h');
      expect(state.step).toBe('MENU');
    });

    it('sem horários marcados', async () => {
      expect(await say('3')).toContain('não tem horários marcados');
    });
  });

  it('remarcar: escolhe o agendamento, dia e horário (ignorando o próprio horário)', async () => {
    appointments.upcomingForCustomer.mockResolvedValue([appointment('a1'), appointment('a2', '2026-10-27T13:00:00Z')]);
    expect(await say('4')).toContain('Qual horário você quer remarcar?');
    await say('1');
    expect(availability.getSlots.mock.calls[0][1]).toMatchObject({ excludeAppointmentId: 'a1', serviceId: 's1' });
    await say('1');
    await say('2');
    expect(await say('1')).toContain('Remarcado ✅');
    expect(appointments.reschedule).toHaveBeenCalledWith(
      't1',
      'a1',
      { startsAt: new Date('2026-10-25T13:30:00.000Z'), barberId: 'b2' },
      { kind: 'customer', customerId: 'c1' },
      NOW,
    );
  });

  it('falar com a barbearia: ativa atendimento humano e avisa o dono', async () => {
    expect(await say('5')).toContain('Avisei a equipe');
    expect(prisma.conversation.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { humanTakeover: true } }));
    expect(push.notifyOwners).toHaveBeenCalledWith('t1', expect.objectContaining({ title: '💬 CLIENTE QUER FALAR CONTIGO', data: { type: 'HUMAN_REQUESTED', customerId: 'c1' } }));
  });

  it(`estado expira após ${STATE_TTL_MINUTES} min de inatividade`, async () => {
    await say('1');
    const later = new Date(NOW.getTime() + (STATE_TTL_MINUTES + 1) * 60_000);
    const reply = await say('1', later);
    // "1" num estado expirado é tratado como opção do menu (agendar), não como serviço
    expect(reply).toContain('Qual serviço?');
  });

  describe('menu personalizado pela barbearia', () => {
    const custom = {
      ...TENANT,
      menuPrompt: 'Qual vai ser, chefe?',
      botMenu: [
        { key: 'BOOK', label: 'Marcar meu corte', enabled: true },
        { key: 'HUMAN', label: 'Chamar o patrão', enabled: true },
        { key: 'MY', label: 'Meus horários', enabled: false },
        { key: 'CANCEL', label: 'Cancelar', enabled: true },
        { key: 'RESCHEDULE', label: 'Remarcar', enabled: false },
      ],
    };
    const sayCustom = async (text: string) => {
      const r = await bot.handle({ tenant: custom, customer }, text, state, NOW);
      state = r.state;
      return r.reply;
    };

    it('mostra textos, ordem e só as opções ativas, numeradas em sequência', async () => {
      const reply = await sayCustom('oi');
      expect(reply).toContain('Qual vai ser, chefe?');
      expect(reply).toContain('*1* - Marcar meu corte\n*2* - Chamar o patrão\n*3* - Cancelar');
      expect(reply).not.toContain('Remarcar');
    });

    it('o número segue a ordem configurada', async () => {
      await sayCustom('oi');
      expect(await sayCustom('2')).toContain('Avisei a equipe'); // 2 = Chamar o patrão
    });

    it('opção oculta não funciona nem por palavra-chave', async () => {
      await sayCustom('oi');
      expect(await sayCustom('remarcar')).toContain('Não entendi');
      expect(appointments.upcomingForCustomer).not.toHaveBeenCalled();
    });
  });

  it('pickIndex', () => {
    expect(pickIndex('2', 3)).toBe(1);
    expect(pickIndex(' 3 ', 3)).toBe(2);
    expect(pickIndex('4', 3)).toBeNull();
    expect(pickIndex('dois', 3)).toBeNull();
  });
});
