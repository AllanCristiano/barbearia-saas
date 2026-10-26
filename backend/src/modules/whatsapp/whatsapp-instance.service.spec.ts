import { InstanceStatus } from '@prisma/client';
import { encrypt } from '../../common/utils/crypto.util';
import { createPrismaMock, fakeConfig, PrismaMock } from '../../testing/prisma-mock';
import { EvolutionApiError } from './evolution.client';
import { MAX_FAILED_CHECKS, WhatsappInstanceService } from './whatsapp-instance.service';

describe('WhatsappInstanceService', () => {
  const config = fakeConfig();
  const key = config.getOrThrow('ENCRYPTION_KEY');
  let prisma: PrismaMock;
  let evolution: Record<string, jest.Mock>;
  let push: { notifyOwners: jest.Mock };
  let service: WhatsappInstanceService;

  const instance = (over: Record<string, unknown> = {}) => ({
    id: 'i1',
    tenantId: 't1',
    instanceName: 'bb_teste',
    externalId: 'evo-1',
    tokenEncrypted: encrypt('inst-token', key),
    webhookSecret: 'sec',
    status: InstanceStatus.CONNECTED,
    failedChecks: 0,
    connectedAt: null,
    ...over,
  });

  beforeEach(() => {
    prisma = createPrismaMock();
    evolution = {
      createInstance: jest.fn().mockResolvedValue({ id: 'evo-2' }),
      connect: jest.fn().mockResolvedValue(undefined),
      getQr: jest.fn().mockResolvedValue({ qrcode: 'QR' }),
      getStatus: jest.fn(),
      reconnect: jest.fn().mockResolvedValue(undefined),
      deleteInstance: jest.fn().mockResolvedValue(undefined),
      logout: jest.fn().mockResolvedValue(undefined),
      pair: jest.fn().mockResolvedValue({ pairingCode: 'ABCD-EFGH' }),
    };
    push = { notifyOwners: jest.fn() };
    prisma.whatsappInstance.update.mockImplementation(async ({ data }: any) => ({ ...instance(), ...data }));
    service = new WhatsappInstanceService(prisma as any, evolution as any, push as any, config);
  });

  describe('ensureInstance', () => {
    it('cria instância com token criptografado e nome interno', async () => {
      prisma.whatsappInstance.findUnique.mockResolvedValue(null);
      prisma.whatsappInstance.create.mockImplementation(async ({ data }: any) => ({ id: 'i1', ...data }));
      await service.ensureInstance('t1', 'barbearia-teste');

      const data = prisma.whatsappInstance.create.mock.calls[0][0].data;
      expect(data.instanceName).toMatch(/^bb_barbearia-teste_/);
      expect(data.tokenEncrypted).not.toContain(evolution.createInstance.mock.calls[0][1]);
      expect(evolution.createInstance).toHaveBeenCalledWith(data.instanceName, expect.any(String));
    });

    it('é idempotente', async () => {
      prisma.whatsappInstance.findUnique.mockResolvedValue(instance());
      await service.ensureInstance('t1', 'x');
      expect(evolution.createInstance).not.toHaveBeenCalled();
    });

    it('marca ERROR se o Evolution estiver fora (cron recria depois)', async () => {
      prisma.whatsappInstance.findUnique.mockResolvedValue(null);
      prisma.whatsappInstance.create.mockResolvedValue(instance({ status: InstanceStatus.CREATED }));
      evolution.createInstance.mockRejectedValue(new Error('down'));
      await service.ensureInstance('t1', 'x');
      expect(prisma.whatsappInstance.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: InstanceStatus.ERROR }) }),
      );
    });
  });

  describe('connect', () => {
    it('configura webhook com segredo e retorna QR', async () => {
      prisma.whatsappInstance.findUnique.mockResolvedValue(instance({ status: InstanceStatus.CREATED }));
      evolution.getStatus.mockResolvedValue({ connected: false, loggedIn: false });
      const res = await service.connect('t1');
      expect(res).toEqual({ status: InstanceStatus.CONNECTING, qrcode: 'QR' });
      expect(evolution.connect).toHaveBeenCalledWith('inst-token', 'https://api.test/webhooks/whatsapp/i1?secret=sec', [
        'MESSAGE',
        'CONNECTION',
        'QRCODE',
      ]);
    });

    it('não pede QR se já está conectado', async () => {
      prisma.whatsappInstance.findUnique.mockResolvedValue(instance());
      evolution.getStatus.mockResolvedValue({ connected: true, loggedIn: true });
      await expect(service.connect('t1')).resolves.toEqual({ status: InstanceStatus.CONNECTED });
      expect(evolution.connect).not.toHaveBeenCalled();
    });
  });

  describe('pairWithPhone (conectar pelo próprio celular)', () => {
    it('configura o webhook e devolve o código de pareamento', async () => {
      prisma.whatsappInstance.findUnique.mockResolvedValue(instance({ status: InstanceStatus.CREATED }));
      prisma.tenant.findUnique.mockResolvedValue({ phone: '5511999990000' });
      evolution.getStatus.mockResolvedValue({ connected: false, loggedIn: false });

      const r = await service.pairWithPhone('t1', '(11) 98765-4321');

      expect(r).toEqual({ status: InstanceStatus.CONNECTING, pairingCode: 'ABCD-EFGH' });
      expect(evolution.connect).toHaveBeenCalledWith('inst-token', expect.stringContaining('/webhooks/whatsapp/i1?secret=sec'), expect.any(Array));
      expect(evolution.pair).toHaveBeenCalledWith('inst-token', '5511987654321', expect.any(Array));
      // webhook configurado ANTES de pedir o código
      expect(evolution.connect.mock.invocationCallOrder[0]).toBeLessThan(evolution.pair.mock.invocationCallOrder[0]);
    });

    it('usa o telefone do cadastro quando nenhum é informado', async () => {
      prisma.whatsappInstance.findUnique.mockResolvedValue(instance({ status: InstanceStatus.CREATED }));
      prisma.tenant.findUnique.mockResolvedValue({ phone: '5511999990000' });
      evolution.getStatus.mockResolvedValue({ connected: false, loggedIn: false });
      await service.pairWithPhone('t1');
      expect(evolution.pair).toHaveBeenCalledWith('inst-token', '5511999990000', expect.any(Array));
    });

    it('número inválido é rejeitado', async () => {
      prisma.whatsappInstance.findUnique.mockResolvedValue(instance());
      prisma.tenant.findUnique.mockResolvedValue({ phone: null });
      await expect(service.pairWithPhone('t1', '123')).rejects.toThrow('inválido');
    });

    it('já conectado não gera código', async () => {
      prisma.whatsappInstance.findUnique.mockResolvedValue(instance());
      prisma.tenant.findUnique.mockResolvedValue({ phone: '5511999990000' });
      evolution.getStatus.mockResolvedValue({ connected: true, loggedIn: true });
      await expect(service.pairWithPhone('t1')).resolves.toEqual({ status: InstanceStatus.CONNECTED });
      expect(evolution.pair).not.toHaveBeenCalled();
    });
  });

  describe('runMaintenance', () => {
    it('instância saudável zera falhas', async () => {
      prisma.whatsappInstance.findMany.mockResolvedValue([instance({ failedChecks: 2 })]);
      evolution.getStatus.mockResolvedValue({ connected: true, loggedIn: true });
      const r = await service.runMaintenance();
      expect(r.checked).toBe(1);
      expect(prisma.whatsappInstance.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ failedChecks: 0 }) }));
      // já estava conectada: não avisa de novo
      expect(push.notifyOwners).not.toHaveBeenCalled();
    });

    it('voltou a conectar → avisa o dono UMA vez (troca atômica de status)', async () => {
      prisma.whatsappInstance.findMany.mockResolvedValue([instance({ status: InstanceStatus.DISCONNECTED })]);
      evolution.getStatus.mockResolvedValue({ connected: true, loggedIn: true });
      prisma.whatsappInstance.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 });
      await service.runMaintenance();
      expect(prisma.whatsappInstance.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'i1', status: { not: InstanceStatus.CONNECTED } }, data: expect.objectContaining({ status: InstanceStatus.CONNECTED }) }),
      );
      expect(push.notifyOwners).toHaveBeenCalledWith('t1', expect.objectContaining({ title: '✅ WHATSAPP NO AR' }));
      // segunda confirmação simultânea (ex.: webhook + app) não gera outro aviso
      await service.handleConnectionEvent(instance({ status: InstanceStatus.DISCONNECTED }) as any, true);
      expect(push.notifyOwners).toHaveBeenCalledTimes(1);
    });

    it('sessão válida com socket caído → reconecta sem QR', async () => {
      prisma.whatsappInstance.findMany.mockResolvedValue([instance()]);
      evolution.getStatus.mockResolvedValue({ connected: false, loggedIn: true });
      const r = await service.runMaintenance();
      expect(evolution.reconnect).toHaveBeenCalledWith('inst-token');
      expect(r.reconnected).toBe(1);
    });

    it('sessão perdida → avisa o dono para escanear o QR', async () => {
      prisma.whatsappInstance.findMany.mockResolvedValue([instance()]);
      evolution.getStatus.mockResolvedValue({ connected: false, loggedIn: false });
      const r = await service.runMaintenance();
      expect(r.alerts).toBe(1);
      expect(push.notifyOwners).toHaveBeenCalledWith('t1', expect.objectContaining({ title: '⚠️ WHATSAPP DESCONECTADO', channel: 'whatsapp' }));
    });

    it('instância sumiu do Evolution → recria com o mesmo token', async () => {
      prisma.whatsappInstance.findMany.mockResolvedValue([instance()]);
      evolution.getStatus.mockRejectedValue(new EvolutionApiError('not found', 404));
      const r = await service.runMaintenance();
      expect(r.recreated).toBe(1);
      expect(evolution.createInstance).toHaveBeenCalledWith('bb_teste', 'inst-token');
    });

    it(`após ${MAX_FAILED_CHECKS} falhas seguidas marca ERROR`, async () => {
      prisma.whatsappInstance.findMany.mockResolvedValue([instance({ failedChecks: MAX_FAILED_CHECKS - 1 })]);
      evolution.getStatus.mockRejectedValue(new EvolutionApiError('timeout', 0));
      await service.runMaintenance();
      expect(prisma.whatsappInstance.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: InstanceStatus.ERROR, failedChecks: MAX_FAILED_CHECKS }) }),
      );
    });

    it('erro em uma instância não interrompe as outras', async () => {
      prisma.whatsappInstance.findMany.mockResolvedValue([instance({ tokenEncrypted: 'corrompido' }), instance({ id: 'i2' })]);
      evolution.getStatus.mockResolvedValue({ connected: true, loggedIn: true });
      const r = await service.runMaintenance();
      expect(r.checked).toBe(2);
      expect(evolution.getStatus).toHaveBeenCalledTimes(1);
    });
  });

  it('status cria a instância automaticamente se a barbearia ainda não tem', async () => {
    prisma.whatsappInstance.findUnique.mockResolvedValue(null);
    prisma.tenant.findUnique.mockResolvedValue({ slug: 'barbearia-demo' });
    prisma.whatsappInstance.create.mockImplementation(async ({ data }: any) => ({ id: 'i9', ...data }));
    evolution.getStatus.mockResolvedValue({ connected: false, loggedIn: false });
    await service.refreshStatus('t1');
    expect(prisma.whatsappInstance.create).toHaveBeenCalled();
    expect(evolution.createInstance).toHaveBeenCalledWith(expect.stringMatching(/^bb_barbearia-demo_/), expect.any(String));
  });

  it('nunca expõe detalhes do provedor no status', async () => {
    prisma.whatsappInstance.findUnique.mockResolvedValue(
      instance({ status: InstanceStatus.ERROR, lastError: 'Evolution POST /instance/create falhou (503): LICENSE_REQUIRED' }),
    );
    const s = await service.getPublicStatus('t1');
    expect(s.lastError).toBe('Falha de comunicação com o serviço de WhatsApp');
    expect(JSON.stringify(s)).not.toMatch(/evolution/i);
  });

  it('getSendToken exige instância conectada', async () => {
    prisma.whatsappInstance.findUnique.mockResolvedValue(instance({ status: InstanceStatus.DISCONNECTED }));
    await expect(service.getSendToken('t1')).rejects.toThrow('não está conectado');
  });
});
