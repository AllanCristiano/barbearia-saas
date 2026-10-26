import { Role } from '@prisma/client';

/** Payload do JWT anexado em request.user. */
export interface AuthUser {
  sub: string;
  tenantId: string | null;
  role: Role;
  email: string;
}

/** Usuário autenticado garantidamente vinculado a uma barbearia. */
export interface TenantUser extends AuthUser {
  tenantId: string;
}
