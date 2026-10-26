import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from './auth-user';
import { IS_PUBLIC_KEY, SKIP_SUBSCRIPTION_KEY } from './decorators';

export const BLOCKED_STATUSES: TenantStatus[] = [TenantStatus.SUSPENDED, TenantStatus.CANCELED];

/**
 * Bloqueia (HTTP 402) as rotas de barbearias com assinatura suspensa/cancelada.
 * Rotas de cobrança usam @SkipSubscriptionCheck() para permitir a regularização.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_SUBSCRIPTION_KEY, targets)) return true;

    const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
    if (!user?.tenantId) return true; // super admin

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { status: true },
    });
    if (!tenant || BLOCKED_STATUSES.includes(tenant.status)) {
      throw new HttpException(
        'Assinatura inativa. Regularize o pagamento para continuar usando o sistema.',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return true;
  }
}
