import { createParamDecorator, ExecutionContext, ForbiddenException, SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthUser, TenantUser } from './auth-user';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';
export const SKIP_SUBSCRIPTION_KEY = 'skipSubscription';

/** Rota sem autenticação JWT (webhooks, login, cadastro). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restringe a rota aos papéis informados. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** Permite acesso mesmo com assinatura vencida (ex.: tela de pagamento). */
export const SkipSubscriptionCheck = () => SetMetadata(SKIP_SUBSCRIPTION_KEY, true);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

/**
 * Injeta o usuário garantindo que ele pertence a um tenant.
 * Todo acesso a dados de barbearia usa este tenantId — nunca um vindo do body/query.
 */
export const CurrentTenant = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantUser => {
  const user: AuthUser | undefined = ctx.switchToHttp().getRequest().user;
  if (!user?.tenantId) throw new ForbiddenException('Usuário não vinculado a uma barbearia');
  return user as TenantUser;
});
