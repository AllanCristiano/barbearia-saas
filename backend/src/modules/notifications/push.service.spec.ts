import { createPrismaMock, PrismaMock } from '../../testing/prisma-mock';
import { Push } from './push-messages';
import { PushService } from './push.service';

describe('PushService', () => {
  let prisma: PrismaMock;
  let service: PushService;
  const fetchMock = jest.fn();

  const tickets = (...items: unknown[]) => fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: items }) });

  beforeEach(() => {
    prisma = createPrismaMock();
    fetchMock.mockReset();
    global.fetch = fetchMock as any;
    service = new PushService(prisma as any);
  });

  it('envia com canal, prioridade alta e som (para chegar com o app fechado)', async () => {
    tickets({ status: 'ok' });
    const sent = await service.send(['ExponentPushToken[a]'], Push.whatsappDisconnected());
    expect(sent).toBe(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect(JSON.parse(init.body)).toEqual([
      expect.objectContaining({
        to: 'ExponentPushToken[a]',
        title: '⚠️ WHATSAPP DESCONECTADO',
        channelId: 'whatsapp',
        priority: 'high',
        sound: 'default',
        data: { type: 'WHATSAPP_DISCONNECTED', screen: 'WhatsApp' },
      }),
    ]);
  });

  it('notifyStaff: barbeiro + donos, um aviso por aparelho, sem quem fez a ação', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 'b1', pushToken: 'ExponentPushToken[barbeiro]' },
      { id: 'o1', pushToken: 'ExponentPushToken[dono]' },
      { id: 'o2', pushToken: 'ExponentPushToken[dono]' }, // mesmo aparelho
    ]);
    tickets({ status: 'ok' });
    await service.notifyStaff('t1', 'b1', Push.test(), 'o1');
    expect(prisma.user.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 't1', active: true, OR: [{ id: 'b1' }, { role: 'OWNER' }] });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.map((m: { to: string }) => m.to)).toEqual(['ExponentPushToken[barbeiro]', 'ExponentPushToken[dono]']);
  });

  it('app desinstalado (DeviceNotRegistered) → remove o token', async () => {
    tickets({ status: 'ok' }, { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } });
    const sent = await service.send(['ExponentPushToken[ok]', 'ExponentPushToken[morto]'], Push.test());
    expect(sent).toBe(1);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { pushToken: { in: ['ExponentPushToken[morto]'] } }, data: { pushToken: null } });
  });

  it('ignora tokens inválidos e nunca lança erro (best-effort)', async () => {
    await expect(service.send(['lixo', ''], Push.test())).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(service.send(['ExponentPushToken[a]'], Push.test())).resolves.toBe(0);
  });

  it('textos no tom do app', () => {
    const a = { id: 'a1', customerName: 'Carlos', serviceName: 'Corte', barberName: 'João', startsAt: new Date('2026-10-24T17:30:00Z'), priceCents: 4000 };
    const n = Push.newAppointment(a, 'America/Sao_Paulo', true);
    expect(n.title).toBe('✂️ NOVO CLIENTE NA CADEIRA');
    expect(n.body).toContain('Carlos · Corte · R$');
    expect(n.body).toContain('14:30 com João · via WhatsApp');
    expect(Push.canceledByCustomer(a, 'America/Sao_Paulo').channel).toBe('cancelamentos');
  });
});
