import { CampaignStatus, InstanceStatus } from '@prisma/client';
import { createPrismaMock, fakeConfig, PrismaMock } from '../../testing/prisma-mock';
import { CampaignsService, OPT_OUT_FOOTER, renderCampaignMessage } from './campaigns.service';

describe('CampaignsService', () => {
  let prisma: PrismaMock;
  let messaging: { send: jest.Mock };
  let service: CampaignsService;

  const campaign = (over: Record<string, unknown> = {}) => ({
    id: 'cp1',
    tenantId: 't1',
    title: 'Promo',
    message: 'Fala {nome}! Corte por R$ 30.',
    tags: [],
    status: CampaignStatus.DRAFT,
    sentCount: 0,
    failedCount: 0,
    totalRecipients: 0,
    ...over,
  });

  beforeEach(() => {
    prisma = createPrismaMock();
    messaging = { send: jest.fn() };
    prisma.campaign.findFirst.mockResolvedValue(campaign());
    prisma.whatsappInstance.findUnique.mockResolvedValue({ status: InstanceStatus.CONNECTED });
    service = new CampaignsService(prisma as any, messaging as any, fakeConfig({ WHATSAPP_SEND_INTERVAL_MS: '2000' }));
  });

  it('personaliza com o primeiro nome e inclui instrução de descadastro', () => {
    expect(renderCampaignMessage('Oi {nome}, tudo bem?', { name: 'Carlos Souza' })).toBe(`Oi Carlos, tudo bem?${OPT_OUT_FOOTER}`);
    expect(renderCampaignMessage('Oi {nome}, tudo bem?', { name: null })).toBe(`Oi, tudo bem?${OPT_OUT_FOOTER}`);
  });

  it('envia só para clientes com opt-in, espaçando as mensagens', async () => {
    prisma.customer.findMany.mockResolvedValue([
      { id: 'c1', name: 'Ana', phone: '5511911111111' },
      { id: 'c2', name: 'Bruno', phone: '5511922222222' },
    ]);
    await service.send('t1', 'cp1');

    expect(prisma.customer.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 't1', marketingOptIn: true, blocked: false });
    expect(messaging.send).toHaveBeenCalledTimes(2);
    const [, , text1, opts1] = messaging.send.mock.calls[0];
    const [, , , opts2] = messaging.send.mock.calls[1];
    expect(text1).toContain('Fala Ana!');
    expect(opts1).toMatchObject({ customerId: 'c1', campaignId: 'cp1' });
    expect(opts2.delayMs).toBeGreaterThanOrEqual(2000);
    expect(prisma.campaign.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: CampaignStatus.SENDING, totalRecipients: 2 }) }),
    );
  });

  it('filtra por tags', async () => {
    prisma.campaign.findFirst.mockResolvedValue(campaign({ tags: ['vip'] }));
    await service.send('t1', 'cp1');
    expect(prisma.customer.findMany.mock.calls[0][0].where.tags).toEqual({ hasSome: ['vip'] });
  });

  it('exige WhatsApp conectado', async () => {
    prisma.whatsappInstance.findUnique.mockResolvedValue({ status: InstanceStatus.DISCONNECTED });
    await expect(service.send('t1', 'cp1')).rejects.toThrow('Conecte o WhatsApp');
  });

  it('não reenvia campanha já enviada', async () => {
    prisma.campaign.findFirst.mockResolvedValue(campaign({ status: CampaignStatus.SENT }));
    await expect(service.send('t1', 'cp1')).rejects.toThrow('já enviada');
  });

  it('cron dispara agendadas e finaliza as concluídas', async () => {
    const now = new Date();
    prisma.campaign.findMany
      .mockResolvedValueOnce([campaign({ status: CampaignStatus.SCHEDULED })])
      .mockResolvedValueOnce([campaign({ id: 'cp2', status: CampaignStatus.SENDING, totalRecipients: 3, sentCount: 2, failedCount: 1 })]);
    const send = jest.spyOn(service, 'send').mockResolvedValue({} as any);
    await service.processScheduled(now);
    expect(send).toHaveBeenCalledWith('t1', 'cp1');
    expect(prisma.campaign.update).toHaveBeenCalledWith({ where: { id: 'cp2' }, data: { status: CampaignStatus.SENT, finishedAt: now } });
  });
});
