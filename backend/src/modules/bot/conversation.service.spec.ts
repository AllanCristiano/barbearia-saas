import { TenantStatus } from '@prisma/client';
import { createPrismaMock, PrismaMock, TENANT } from '../../testing/prisma-mock';
import { ConversationService, HUMAN_TAKEOVER_HOURS } from './conversation.service';

const job = (text: string) => ({ tenantId: 't1', phone: '5511988887777', text, pushName: 'Carlos', messageId: 'm1' });

describe('ConversationService', () => {
  let prisma: PrismaMock;
  let customers: { findOrCreateByPhone: jest.Mock; setMarketingOptIn: jest.Mock };
  let offers: { handleReply: jest.Mock };
  let appointments: { confirmByCustomer: jest.Mock };
  let messaging: { send: jest.Mock; logInbound: jest.Mock };
  let bot: { handle: jest.Mock };
  let service: ConversationService;

  const customer = { id: 'c1', name: 'Carlos', phone: '5511988887777', blocked: false };
  const sentText = () => messaging.send.mock.calls.map((c) => c[2] as string);

  beforeEach(() => {
    prisma = createPrismaMock();
    customers = { findOrCreateByPhone: jest.fn().mockResolvedValue(customer), setMarketingOptIn: jest.fn() };
    offers = { handleReply: jest.fn().mockResolvedValue(false) };
    appointments = { confirmByCustomer: jest.fn().mockResolvedValue(null) };
    messaging = { send: jest.fn(), logInbound: jest.fn() };
    bot = { handle: jest.fn().mockResolvedValue({ reply: 'Menu do bot', state: { step: 'MENU', at: 'x' } }) };
    prisma.tenant.findUnique.mockResolvedValue(TENANT);
    prisma.conversation.upsert.mockResolvedValue({ id: 'conv1', state: {}, humanTakeover: false, updatedAt: new Date() });
    service = new ConversationService(
      prisma as any,
      customers as any,
      offers as any,
      appointments as any,
      messaging as any,
      bot as any,
    );
  });

  it('cadastra o cliente automaticamente e registra a mensagem', async () => {
    await service.handleInbound(job('oi'));
    expect(customers.findOrCreateByPhone).toHaveBeenCalledWith('t1', '5511988887777', 'Carlos');
    expect(messaging.logInbound).toHaveBeenCalledWith('t1', '5511988887777', 'oi', 'c1', 'm1');
  });

  it('mensagens comuns vão para o bot; resposta enviada e estado salvo', async () => {
    await service.handleInbound(job('1'));
    expect(bot.handle).toHaveBeenCalledWith({ tenant: TENANT, customer }, '1', {}, expect.any(Date));
    expect(sentText()).toEqual(['Menu do bot']);
    expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: 'conv1' }, data: { state: { step: 'MENU', at: 'x' } } });
  });

  it('RECEBER PROMOÇÕES reativa o opt-in ("voltar" é navegação do menu)', async () => {
    await service.handleInbound(job('Receber promoções'));
    expect(customers.setMarketingOptIn).toHaveBeenCalledWith('c1', true);
    await service.handleInbound(job('voltar'));
    expect(customers.setMarketingOptIn).toHaveBeenCalledTimes(1);
    expect(bot.handle).toHaveBeenCalledTimes(1);
  });

  it('SAIR remove o opt-in de promoções sem chamar o bot', async () => {
    await service.handleInbound(job('Sair'));
    expect(customers.setMarketingOptIn).toHaveBeenCalledWith('c1', false);
    expect(bot.handle).not.toHaveBeenCalled();
  });

  it('respostas a propostas (adiantar/remarcar) têm prioridade sobre o bot', async () => {
    offers.handleReply.mockResolvedValue(true);
    await service.handleInbound(job('sim'));
    expect(bot.handle).not.toHaveBeenCalled();
  });

  it('CONFIRMAR confirma o próximo horário', async () => {
    appointments.confirmByCustomer.mockResolvedValue({
      service: { name: 'Corte' },
      barber: { name: 'João' },
      startsAt: new Date('2026-10-24T17:00:00Z'),
    });
    await service.handleInbound(job('Confirmar'));
    expect(sentText()[0]).toContain('Presença confirmada');
    expect(bot.handle).not.toHaveBeenCalled();
  });

  it('falha do bot envia mensagem de contingência', async () => {
    bot.handle.mockRejectedValue(new Error('db'));
    await service.handleInbound(job('oi'));
    expect(sentText()[0]).toContain('menu');
  });

  it('cliente bloqueado é ignorado', async () => {
    customers.findOrCreateByPhone.mockResolvedValue({ ...customer, blocked: true });
    await service.handleInbound(job('oi'));
    expect(messaging.send).not.toHaveBeenCalled();
  });

  it('barbearia suspensa responde aviso e não usa o bot', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ ...TENANT, status: TenantStatus.SUSPENDED });
    await service.handleInbound(job('oi'));
    expect(sentText()[0]).toContain('indisponível');
    expect(bot.handle).not.toHaveBeenCalled();
  });

  it('atendimento humano ativo silencia o bot', async () => {
    prisma.conversation.upsert.mockResolvedValue({ id: 'conv1', state: {}, humanTakeover: true, updatedAt: new Date() });
    await service.handleInbound(job('oi'));
    expect(bot.handle).not.toHaveBeenCalled();
  });

  it(`atendimento humano expira após ${HUMAN_TAKEOVER_HOURS}h`, async () => {
    const old = new Date(Date.now() - (HUMAN_TAKEOVER_HOURS + 1) * 3600_000);
    prisma.conversation.upsert.mockResolvedValue({ id: 'conv1', state: {}, humanTakeover: true, updatedAt: old });
    await service.handleInbound(job('oi'));
    expect(bot.handle).toHaveBeenCalled();
  });

  it('bot desativado pela barbearia: não responde', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ ...TENANT, botEnabled: false });
    await service.handleInbound(job('oi'));
    expect(messaging.send).not.toHaveBeenCalled();
  });

  it('processa mensagens do mesmo cliente em ordem', async () => {
    const order: string[] = [];
    bot.handle.mockImplementation(async (_c: unknown, text: string) => {
      await new Promise((r) => setTimeout(r, text === 'primeira' ? 30 : 1));
      order.push(text);
      return { reply: text, state: {} };
    });
    await Promise.all([service.handleInbound(job('primeira')), service.handleInbound(job('segunda'))]);
    expect(order).toEqual(['primeira', 'segunda']);
  });
});
