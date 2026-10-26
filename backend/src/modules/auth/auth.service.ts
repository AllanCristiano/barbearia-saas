import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash } from 'crypto';
import { AuthUser } from '../../common/auth/auth-user';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  static hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10);
  }

  async login(email: string, password: string): Promise<TokenPair & { user: PublicUser }> {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    // Mesma mensagem para e-mail inexistente e senha errada (evita enumeração de usuários).
    if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('E-mail ou senha inválidos');
    }
    const tokens = await this.issue(user);
    return { ...tokens, user: toPublicUser(user) };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: AuthUser;
    try {
      payload = await this.jwt.verifyAsync<AuthUser>(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Sessão expirada, faça login novamente');
    }
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user?.active || user.refreshHash !== sha256(refreshToken)) {
      throw new UnauthorizedException('Sessão inválida, faça login novamente');
    }
    return this.issue(user);
  }

  async logout(userId: string): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { refreshHash: null, pushToken: null } });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { tenant: { select: { id: true, name: true, slug: true, status: true, timezone: true } } },
    });
    return { ...toPublicUser(user), tenant: user.tenant };
  }

  private async issue(user: User): Promise<TokenPair> {
    const payload: AuthUser = { sub: user.id, tenantId: user.tenantId, role: user.role, email: user.email };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_SECRET'),
      expiresIn: this.config.get<string>('JWT_EXPIRES_IN', '15m') as any,
    });
    const refreshToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '30d') as any,
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { refreshHash: sha256(refreshToken) } });
    return { accessToken, refreshToken };
  }
}

export type PublicUser = Pick<User, 'id' | 'name' | 'email' | 'role' | 'tenantId' | 'phone'>;

export function toPublicUser(u: User): PublicUser {
  return { id: u.id, name: u.name, email: u.email, role: u.role, tenantId: u.tenantId, phone: u.phone };
}
