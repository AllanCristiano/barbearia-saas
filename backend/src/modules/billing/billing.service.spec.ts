import { PaymentMethod, SubscriptionStatus, TenantStatus } from '@prisma/client';
import { createPrismaMock, fakeConfig, PrismaMock } from '../../testing/prisma-mock';
import { BillingService } from './billing.service';

const NOW = new Date('2026-10-24T12:00:00Z');

describe('BillingService (cobrança manual)', () => {
  let prisma: PrismaMock;
  let push: { notifyOwners: jest.Mock };
  let service: BillingService;

  const sub = (over: Record<string, unknown> = {}) => ({
    id: 'sub1',
    tenantId: 't1',
    status: SubscriptionStatus.TRIAL,
    amountCents: 20000,
    currentPeriodEnd: new Date('2026-10-30T00:00:00Z'),
    ...over,
  });

  beforeEach(() => {
    prisma = createPrismaMock();
    push = { notifyOwners: jest.fn() };
    prisma.subscription.findUnique.mockResolvedValue(sub());
    prisma.payment.create.mockImplementation(async ({ data }: any) => ({ id: 'p1', ...data }));
    service = new BillingService(
      prisma as any,
      push as any,
      fakeConfig({ PLATFORM_PAYMENT_INSTRUCTIONS: 'Envie o comprovante', PLATFORM_CONTACT: '5511999999999' }),
    );
  });

  it('status mostra assinatura e como pagar (chave PIX)', async () => {
    prisma.tenant.findUniqueOrThrow.mockResolvedValue({ status: TenantStatus.TRIAL, trialEndsAt: null });
    const s = await service.getStatus('t1');
    expect(s.howToPay).toEqual({ pixKey: 'pix@plataforma.com', instructions: 'Envie o comprovante', contact: '5511999999999' });
    expect(s.subscription.amountCents).toBe(20000);
  });

  describe('recordPayment', () => {
    it('estende 1 mês a partir do vencimento e reativa a barbearia', async () => {
      const r = await service.recordPayment('t1', { method: PaymentMethod.PIX }, NOW);
      expect(r.currentPeriodEnd).toEqual(new Date('2026-11-30T00:00:00Z'));
      expect(prisma.payment.create.mock.calls[0][0].data).toMatchObject({ method: 'PIX', amountCents: 20000, months: 1 });
      expect(prisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub1' },
        data: { status: SubscriptionStatus.ACTIVE, currentPeriodEnd: new Date('2026-11-30T00:00:00Z') },
      });
      expect(prisma.tenant.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { status: TenantStatus.ACTIVE } });
      expect(push.notifyOwners).toHaveBeenCalled();
    });

    it('já vencida: conta a partir de hoje; vários meses multiplicam o valor', async () => {
      prisma.subscription.findUnique.mockResolvedValue(sub({ currentPeriodEnd: new Date('2026-09-01T00:00:00Z') }));
      const r = await service.recordPayment('t1', { method: PaymentMethod.CASH, months: 3 }, NOW);
      expect(r.currentPeriodEnd).toEqual(new Date('2027-01-24T12:00:00Z'));
      expect(prisma.payment.create.mock.calls[0][0].data.amountCents).toBe(60000);
    });

    it('aceita valor personalizado (desconto)', async () => {
      await service.recordPayment('t1', { method: PaymentMethod.PIX, amountCents: 15000 }, NOW);
      expect(prisma.payment.create.mock.calls[0][0].data.amountCents).toBe(15000);
    });
  });

  describe('rotina diária', () => {
    it('lembra vencimento, marca inadimplente e suspende após a carência', async () => {
      prisma.subscription.findMany
        .mockResolvedValueOnce([sub({ id: 'soon', tenantId: 't0' })]) // vence em breve
        .mockResolvedValueOnce([sub({ id: 'due' })]) // vencida
        .mockResolvedValueOnce([sub({ id: 'over', tenantId: 't2' })]); // carência esgotada

      const stats = await service.runDailyBilling(NOW);

      expect(stats).toEqual({ reminded: 1, pastDue: 1, suspended: 1 });
      expect(prisma.tenant.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { status: TenantStatus.PAST_DUE } });
      expect(prisma.tenant.update).toHaveBeenCalledWith({ where: { id: 't2' }, data: { status: TenantStatus.SUSPENDED } });
      expect(push.notifyOwners).toHaveBeenCalledWith('t0', expect.objectContaining({ title: '⏰ MENSALIDADE VENCENDO' }));
    });

    it('nada a fazer', async () => {
      await expect(service.runDailyBilling(NOW)).resolves.toEqual({ reminded: 0, pastDue: 0, suspended: 0 });
    });
  });
});
