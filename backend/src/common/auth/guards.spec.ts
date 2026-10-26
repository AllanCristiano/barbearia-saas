import { ExecutionContext, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role, TenantStatus } from '@prisma/client';
import { createPrismaMock, fakeConfig } from '../../testing/prisma-mock';
import { IS_PUBLIC_KEY, ROLES_KEY, SKIP_SUBSCRIPTION_KEY } from './decorators';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { SubscriptionGuard } from './subscription.guard';

function context(req: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => null,
    getClass: () => null,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function reflector(meta: Record<string, unknown>): Reflector {
  return { getAllAndOverride: (key: string) => meta[key] } as unknown as Reflector;
}

describe('JwtAuthGuard', () => {
  const config = fakeConfig();
  const jwt = new JwtService({});

  it('libera rotas públicas', async () => {
    const guard = new JwtAuthGuard(reflector({ [IS_PUBLIC_KEY]: true }), jwt, config);
    await expect(guard.canActivate(context({ headers: {} }))).resolves.toBe(true);
  });

  it('exige token', async () => {
    const guard = new JwtAuthGuard(reflector({}), jwt, config);
    await expect(guard.canActivate(context({ headers: {} }))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('aceita token válido e anexa o usuário', async () => {
    const token = await jwt.signAsync({ sub: 'u1', tenantId: 't1', role: Role.OWNER, email: 'a@b.c' }, { secret: 'jwt-secret' });
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    await new JwtAuthGuard(reflector({}), jwt, config).canActivate(context(req));
    expect(req.user).toMatchObject({ sub: 'u1', tenantId: 't1' });
  });

  it('rejeita token assinado com outro segredo', async () => {
    const token = await jwt.signAsync({ sub: 'u1' }, { secret: 'outro' });
    const guard = new JwtAuthGuard(reflector({}), jwt, config);
    await expect(guard.canActivate(context({ headers: { authorization: `Bearer ${token}` } }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('RolesGuard', () => {
  it('bloqueia papel não autorizado', () => {
    const guard = new RolesGuard(reflector({ [ROLES_KEY]: [Role.OWNER] }));
    expect(() => guard.canActivate(context({ user: { role: Role.BARBER } }))).toThrow(ForbiddenException);
  });

  it('libera papel autorizado e rotas sem restrição', () => {
    expect(new RolesGuard(reflector({ [ROLES_KEY]: [Role.OWNER] })).canActivate(context({ user: { role: Role.OWNER } }))).toBe(true);
    expect(new RolesGuard(reflector({})).canActivate(context({ user: { role: Role.BARBER } }))).toBe(true);
  });
});

describe('SubscriptionGuard', () => {
  const prisma = createPrismaMock();

  it.each([TenantStatus.SUSPENDED, TenantStatus.CANCELED])('retorna 402 para barbearia %s', async (status) => {
    prisma.tenant.findUnique.mockResolvedValue({ status });
    const guard = new SubscriptionGuard(reflector({}), prisma as any);
    const err = await guard.canActivate(context({ user: { tenantId: 't1' } })).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(402);
  });

  it.each([TenantStatus.TRIAL, TenantStatus.ACTIVE, TenantStatus.PAST_DUE])('libera barbearia %s', async (status) => {
    prisma.tenant.findUnique.mockResolvedValue({ status });
    await expect(new SubscriptionGuard(reflector({}), prisma as any).canActivate(context({ user: { tenantId: 't1' } }))).resolves.toBe(true);
  });

  it('rotas de cobrança ficam liberadas mesmo suspenso', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ status: TenantStatus.SUSPENDED });
    const guard = new SubscriptionGuard(reflector({ [SKIP_SUBSCRIPTION_KEY]: true }), prisma as any);
    await expect(guard.canActivate(context({ user: { tenantId: 't1' } }))).resolves.toBe(true);
  });
});
