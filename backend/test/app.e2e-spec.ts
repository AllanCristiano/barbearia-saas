/**
 * Testes HTTP (supertest) dos controllers com guards globais e ValidationPipe reais.
 * Serviços e banco são mockados — não precisa de Postgres/Redis rodando.
 */
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Role, TenantStatus } from '@prisma/client';
import request from 'supertest';
import { JwtAuthGuard } from '../src/common/auth/jwt-auth.guard';
import { RolesGuard } from '../src/common/auth/roles.guard';
import { SubscriptionGuard } from '../src/common/auth/subscription.guard';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { BillingController } from '../src/modules/billing/billing.controller';
import { BillingService } from '../src/modules/billing/billing.service';
import { AppointmentsController } from '../src/modules/scheduling/appointments.controller';
import { AppointmentsService } from '../src/modules/scheduling/appointments.service';
import { AvailabilityService } from '../src/modules/scheduling/availability.service';
import { INBOUND_QUEUE } from '../src/modules/whatsapp/queues';
import { WhatsappInstanceService } from '../src/modules/whatsapp/whatsapp-instance.service';
import { WhatsappWebhookController } from '../src/modules/whatsapp/whatsapp-webhook.controller';
import { WhatsappController } from '../src/modules/whatsapp/whatsapp.controller';
import { createPrismaMock, fakeConfig } from '../src/testing/prisma-mock';

describe('API (e2e)', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const prisma = createPrismaMock();
  const inbound = { add: jest.fn() };
  const instances = {
    findByWebhook: jest.fn(),
    handleConnectionEvent: jest.fn(),
    handleLogout: jest.fn(),
    refreshStatus: jest.fn().mockResolvedValue({ status: 'CONNECTED' }),
    connect: jest.fn(),
    getQr: jest.fn(),
    logout: jest.fn(),
  };
  const appointments = { listDay: jest.fn().mockResolvedValue([]), cancel: jest.fn().mockResolvedValue({ id: 'a1' }) };
  const billing = { getStatus: jest.fn().mockResolvedValue({ ok: true }) };

  const token = (role: Role, tenantId: string | null = 't1') =>
    jwt.signAsync({ sub: 'u1', tenantId, role, email: 'x@y.z' }, { secret: 'jwt-secret' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({})],
      controllers: [WhatsappWebhookController, WhatsappController, AppointmentsController, BillingController],
      providers: [
        { provide: ConfigService, useValue: fakeConfig() },
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken(INBOUND_QUEUE), useValue: inbound },
        { provide: WhatsappInstanceService, useValue: instances },
        { provide: AppointmentsService, useValue: appointments },
        { provide: AvailabilityService, useValue: { getSlots: jest.fn().mockResolvedValue([]) } },
        { provide: BillingService, useValue: billing },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: SubscriptionGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    jwt = moduleRef.get(JwtService);
  });

  afterAll(() => app.close());

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.tenant.findUnique.mockResolvedValue({ status: TenantStatus.ACTIVE });
  });

  describe('autenticação e autorização', () => {
    it('401 sem token', () => request(app.getHttpServer()).get('/appointments?date=2026-10-24').expect(401));

    it('200 com token válido', async () => {
      await request(app.getHttpServer())
        .get('/appointments?date=2026-10-24')
        .set('Authorization', `Bearer ${await token(Role.BARBER)}`)
        .expect(200);
      expect(appointments.listDay).toHaveBeenCalledWith('t1', expect.objectContaining({ tenantId: 't1' }), '2026-10-24', undefined);
    });

    it('400 com data inválida (ValidationPipe)', async () => {
      await request(app.getHttpServer())
        .get('/appointments?date=24-10-2026')
        .set('Authorization', `Bearer ${await token(Role.OWNER)}`)
        .expect(400);
    });

    it('403: barbeiro não acessa a conexão do WhatsApp (somente dono)', async () => {
      await request(app.getHttpServer())
        .get('/whatsapp/status')
        .set('Authorization', `Bearer ${await token(Role.BARBER)}`)
        .expect(403);
    });

    it('402: barbearia suspensa é bloqueada…', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ status: TenantStatus.SUSPENDED });
      await request(app.getHttpServer())
        .get('/appointments?date=2026-10-24')
        .set('Authorization', `Bearer ${await token(Role.OWNER)}`)
        .expect(402);
    });

    it('…mas ainda acessa a tela de pagamento', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ status: TenantStatus.SUSPENDED });
      await request(app.getHttpServer()).get('/billing').set('Authorization', `Bearer ${await token(Role.OWNER)}`).expect(200);
    });

    it('rejeita campos não permitidos no body', async () => {
      await request(app.getHttpServer())
        .post('/appointments/11111111-1111-4111-8111-111111111111/cancel')
        .set('Authorization', `Bearer ${await token(Role.OWNER)}`)
        .send({ reason: 'ok', tenantId: 'outro-tenant' })
        .expect(400);
    });
  });

  describe('webhook do WhatsApp (Evolution Go)', () => {
    const instance = { id: 'i1', tenantId: 't1', webhookSecret: 'sec' };
    const body = {
      event: 'Message',
      data: { Info: { ID: 'm1', Sender: '5511987654321@s.whatsapp.net', PushName: 'Carlos' }, Message: { conversation: 'Oi' } },
    };

    it('401 com segredo errado', async () => {
      instances.findByWebhook.mockResolvedValue(instance);
      await request(app.getHttpServer()).post('/webhooks/whatsapp/i1?secret=errado').send(body).expect(401);
      expect(inbound.add).not.toHaveBeenCalled();
    });

    it('enfileira a mensagem com deduplicação por id', async () => {
      instances.findByWebhook.mockResolvedValue(instance);
      await request(app.getHttpServer()).post('/webhooks/whatsapp/i1?secret=sec').send(body).expect(200, { ok: true, handled: 'message' });
      expect(inbound.add).toHaveBeenCalledWith(
        'inbound',
        { tenantId: 't1', phone: '5511987654321', text: 'Oi', pushName: 'Carlos', messageId: 'm1' },
        expect.objectContaining({ jobId: 'i1-m1' }),
      );
    });

    it('atualiza status em evento de conexão', async () => {
      instances.findByWebhook.mockResolvedValue(instance);
      await request(app.getHttpServer()).post('/webhooks/whatsapp/i1?secret=sec').send({ event: 'Connected' }).expect(200);
      expect(instances.handleConnectionEvent).toHaveBeenCalledWith(instance, true);
    });
  });
});
