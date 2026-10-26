import { Injectable, Logger } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PushMessage } from './push-messages';

export type { PushMessage } from './push-messages';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoTicket {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

export const isExpoToken = (t?: string | null): t is string => !!t && (t.startsWith('ExponentPushToken') || t.startsWith('ExpoPushToken'));

/**
 * Notificações push para o app (Expo Push → FCM/APNs). Chegam com o app fechado.
 * Best-effort: falha de push nunca derruba o fluxo principal.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(private readonly prisma: PrismaService) {}

  async notifyUser(userId: string, msg: PushMessage): Promise<number> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { pushToken: true, active: true } });
    return user?.active && user.pushToken ? this.send([user.pushToken], msg) : 0;
  }

  async notifyOwners(tenantId: string, msg: PushMessage): Promise<number> {
    const owners = await this.prisma.user.findMany({
      where: { tenantId, role: Role.OWNER, active: true, pushToken: { not: null } },
      select: { pushToken: true },
    });
    return this.send(owners.map((o) => o.pushToken!), msg);
  }

  /**
   * Eventos de agenda: avisa o barbeiro do horário e os donos da barbearia, uma vez
   * por aparelho, sem notificar quem fez a ação (`excludeUserId`).
   */
  async notifyStaff(tenantId: string, barberId: string, msg: PushMessage, excludeUserId?: string): Promise<number> {
    const users = await this.prisma.user.findMany({
      where: { tenantId, active: true, pushToken: { not: null }, OR: [{ id: barberId }, { role: Role.OWNER }] },
      select: { id: true, pushToken: true },
    });
    const tokens = users.filter((u) => u.id !== excludeUserId).map((u) => u.pushToken!);
    return this.send(tokens, msg);
  }

  /** Envia e devolve quantos aparelhos aceitaram. Remove tokens de apps desinstalados. */
  async send(tokens: string[], msg: PushMessage): Promise<number> {
    const valid = [...new Set(tokens.filter(isExpoToken))];
    if (!valid.length) return 0;
    const { channel = 'geral', ...rest } = msg;
    const payload = valid.map((to) => ({
      to,
      ...rest,
      sound: 'default',
      channelId: channel,
      priority: 'high',
      // Agendamento de daqui a pouco não serve se chegar amanhã: expira em 6h.
      ttl: 6 * 3600,
    }));
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        this.logger.warn(`Expo push falhou: ${res.status}`);
        return 0;
      }
      const tickets: ExpoTicket[] = ((await res.json()) as { data?: ExpoTicket[] }).data ?? [];
      const dead = valid.filter((_, i) => tickets[i]?.details?.error === 'DeviceNotRegistered');
      if (dead.length) {
        await this.prisma.user.updateMany({ where: { pushToken: { in: dead } }, data: { pushToken: null } });
        this.logger.log(`${dead.length} token(s) de app desinstalado removidos`);
      }
      for (const t of tickets) if (t.status === 'error' && t.details?.error !== 'DeviceNotRegistered') this.logger.warn(`Push recusado: ${t.message}`);
      return tickets.filter((t) => t.status === 'ok').length;
    } catch (err) {
      this.logger.warn(`Expo push indisponível: ${(err as Error).message}`);
      return 0;
    }
  }
}
