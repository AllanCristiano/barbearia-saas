import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InstanceStatus, WhatsappInstance } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { decrypt, encrypt, randomToken } from '../../common/utils/crypto.util';
import { normalizePhone } from '../../common/utils/phone.util';
import { Push } from '../notifications/push-messages';
import { PushService } from '../notifications/push.service';
import { EvolutionApiError, EvolutionClient } from './evolution.client';

export interface PublicInstanceStatus {
  status: InstanceStatus;
  phoneNumber: string | null;
  connectedAt: Date | null;
  lastError: string | null;
}

/** Quantas checagens seguidas com falha até marcar a instância como ERROR. */
export const MAX_FAILED_CHECKS = 3;

/**
 * Ciclo de vida das instâncias de WhatsApp (uma por barbearia):
 * criação, conexão via QR, status, reconexão, recriação e remoção.
 */
@Injectable()
export class WhatsappInstanceService {
  private readonly logger = new Logger(WhatsappInstanceService.name);
  private readonly key: string;
  private readonly publicUrl: string;
  private readonly events: string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly evolution: EvolutionClient,
    private readonly push: PushService,
    config: ConfigService,
  ) {
    this.key = config.getOrThrow<string>('ENCRYPTION_KEY');
    // Evolution e API ficam na mesma rede Docker: o webhook pode usar o endereço interno.
    this.publicUrl = (config.get<string>('EVOLUTION_WEBHOOK_BASE') || config.getOrThrow<string>('PUBLIC_API_URL')).replace(/\/$/, '');
    this.events = (config.get<string>('EVOLUTION_WEBHOOK_EVENTS') ?? 'MESSAGE,CONNECTION,QRCODE')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
  }

  /** Cria a instância da barbearia (idempotente). Chamado no cadastro do tenant. */
  async ensureInstance(tenantId: string, slug: string): Promise<WhatsappInstance> {
    const existing = await this.prisma.whatsappInstance.findUnique({ where: { tenantId } });
    if (existing) return existing;

    const instanceName = `bb_${slug}_${randomToken(3)}`;
    const token = randomToken(24);
    const instance = await this.prisma.whatsappInstance.create({
      data: {
        tenantId,
        instanceName,
        tokenEncrypted: encrypt(token, this.key),
        webhookSecret: randomToken(24),
      },
    });

    try {
      const { id } = await this.evolution.createInstance(instanceName, token);
      return this.prisma.whatsappInstance.update({ where: { id: instance.id }, data: { externalId: id ?? null } });
    } catch (err) {
      // O registro fica salvo; a manutenção (cron) tentará recriar no Evolution.
      this.logger.error(`Falha ao criar instância ${instanceName}: ${(err as Error).message}`);
      return this.prisma.whatsappInstance.update({
        where: { id: instance.id },
        data: { status: InstanceStatus.ERROR, lastError: (err as Error).message },
      });
    }
  }

  /** Inicia o pareamento e retorna o QR Code para a barbearia escanear. */
  async connect(tenantId: string): Promise<{ status: InstanceStatus; qrcode?: string; code?: string }> {
    const instance = await this.getOrProvision(tenantId);
    if (instance.status === InstanceStatus.ERROR || !instance.externalId) {
      await this.recreate(instance);
    }
    const token = this.tokenOf(instance);
    const status = await this.safeStatus(token);
    if (status?.loggedIn && status.connected) {
      await this.markConnected(instance);
      return { status: InstanceStatus.CONNECTED };
    }

    await this.evolution.connect(token, this.webhookUrl(instance), this.events);
    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: { status: InstanceStatus.CONNECTING, lastError: null },
    });
    const qr = await this.evolution.getQr(token).catch(() => ({}) as { qrcode?: string; code?: string });
    return { status: InstanceStatus.CONNECTING, ...qr };
  }

  /**
   * Conexão pelo próprio celular (sem precisar de um segundo aparelho para ler o QR):
   * configura o webhook, pede ao WhatsApp um código de pareamento para o número
   * informado e o dono digita esse código no app do WhatsApp.
   */
  async pairWithPhone(tenantId: string, rawPhone?: string): Promise<{ status: InstanceStatus; pairingCode?: string }> {
    let instance = await this.getOrProvision(tenantId);
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { phone: true } });
    const source = rawPhone || tenant?.phone;
    if (!source) throw new BadRequestException('Informe o número do WhatsApp da barbearia');
    let phone: string;
    try {
      phone = normalizePhone(source);
    } catch {
      throw new BadRequestException('Número de WhatsApp inválido');
    }

    if (instance.status === InstanceStatus.ERROR || !instance.externalId) {
      await this.recreate(instance);
      instance = await this.getOrProvision(tenantId);
    }
    const token = this.tokenOf(instance);
    const status = await this.safeStatus(token);
    if (status?.loggedIn && status.connected) {
      await this.markConnected(instance);
      return { status: InstanceStatus.CONNECTED };
    }

    await this.evolution.connect(token, this.webhookUrl(instance), this.events);
    const { pairingCode } = await this.evolution.pair(token, phone, this.events);
    if (!pairingCode) throw new BadRequestException('Não foi possível gerar o código agora. Tente novamente em instantes.');
    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: { status: InstanceStatus.CONNECTING, lastError: null },
    });
    return { status: InstanceStatus.CONNECTING, pairingCode };
  }

  async getQr(tenantId: string): Promise<{ qrcode?: string; code?: string }> {
    const instance = await this.getOrProvision(tenantId);
    return this.evolution.getQr(this.tokenOf(instance));
  }

  /** Consulta o status real no Evolution e sincroniza o banco. */
  async refreshStatus(tenantId: string): Promise<PublicInstanceStatus> {
    const instance = await this.getOrProvision(tenantId);
    const status = await this.safeStatus(this.tokenOf(instance));
    let next: InstanceStatus = instance.status;
    if (status) {
      if (status.loggedIn && status.connected) {
        await this.markConnected(instance);
        next = InstanceStatus.CONNECTED;
      } else if (instance.status === InstanceStatus.CONNECTED) next = InstanceStatus.DISCONNECTED;
    }
    const updated = await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: {
        status: next,
        lastCheckedAt: new Date(),
        connectedAt: next === InstanceStatus.CONNECTED ? (instance.connectedAt ?? new Date()) : instance.connectedAt,
      },
    });
    return toPublic(updated);
  }

  async getPublicStatus(tenantId: string): Promise<PublicInstanceStatus> {
    return toPublic(await this.getOrProvision(tenantId));
  }

  async logout(tenantId: string): Promise<void> {
    const instance = await this.getOrThrow(tenantId);
    await this.evolution.logout(this.tokenOf(instance)).catch((err) => {
      if (!(err instanceof EvolutionApiError && err.isNotFound)) throw err;
    });
    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: { status: InstanceStatus.DISCONNECTED, phoneNumber: null, connectedAt: null },
    });
  }

  /** Remove completamente a instância (ex.: barbearia cancelada). */
  async remove(tenantId: string): Promise<void> {
    const instance = await this.prisma.whatsappInstance.findUnique({ where: { tenantId } });
    if (!instance) return;
    if (instance.externalId) {
      await this.evolution.deleteInstance(instance.externalId).catch((err) => {
        this.logger.warn(`Falha ao excluir instância remota ${instance.instanceName}: ${err.message}`);
      });
    }
    await this.prisma.whatsappInstance.delete({ where: { id: instance.id } });
  }

  /** Token decifrado para envio de mensagens (uso interno do módulo). */
  async getSendToken(tenantId: string): Promise<string> {
    const instance = await this.getOrThrow(tenantId);
    if (instance.status !== InstanceStatus.CONNECTED) {
      throw new BadRequestException('WhatsApp da barbearia não está conectado');
    }
    return this.tokenOf(instance);
  }

  /** Busca a instância pelo id usado na URL do webhook e valida o segredo. */
  async findByWebhook(instanceId: string): Promise<WhatsappInstance | null> {
    return this.prisma.whatsappInstance.findUnique({ where: { id: instanceId } });
  }

  async handleConnectionEvent(instance: WhatsappInstance, connected: boolean): Promise<void> {
    if (connected) {
      await this.markConnected(instance);
      return;
    }
    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: { status: InstanceStatus.DISCONNECTED },
    });
  }

  async handleLogout(instance: WhatsappInstance): Promise<void> {
    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: { status: InstanceStatus.DISCONNECTED, phoneNumber: null, connectedAt: null },
    });
    await this.push.notifyOwners(instance.tenantId, Push.whatsappDisconnected());
  }

  /**
   * Manutenção periódica (cron): verifica todas as instâncias, reconecta as que caíram,
   * recria as que sumiram do Evolution e avisa o dono quando é preciso escanear o QR.
   */
  async runMaintenance(): Promise<{ checked: number; reconnected: number; recreated: number; alerts: number }> {
    const instances = await this.prisma.whatsappInstance.findMany({
      where: { status: { in: [InstanceStatus.CONNECTED, InstanceStatus.DISCONNECTED, InstanceStatus.ERROR, InstanceStatus.CONNECTING] } },
    });
    const result = { checked: 0, reconnected: 0, recreated: 0, alerts: 0 };

    for (const instance of instances) {
      result.checked++;
      try {
        await this.checkOne(instance, result);
      } catch (err) {
        this.logger.error(`Manutenção da instância ${instance.instanceName} falhou: ${(err as Error).message}`);
      }
    }
    return result;
  }

  private async checkOne(
    instance: WhatsappInstance,
    result: { reconnected: number; recreated: number; alerts: number },
  ): Promise<void> {
    const token = this.tokenOf(instance);
    if (!instance.externalId && instance.status === InstanceStatus.ERROR) {
      // Criação inicial falhou (Evolution fora do ar no cadastro): tenta de novo.
      await this.recreate(instance);
      result.recreated++;
      return;
    }
    try {
      const status = await this.evolution.getStatus(token);
      if (status.loggedIn && status.connected) {
        await this.markConnected(instance);
        return;
      }
      if (status.loggedIn && !status.connected) {
        // Sessão válida, socket caiu: tenta reconectar sem precisar de QR.
        await this.evolution.reconnect(token);
        result.reconnected++;
        await this.bumpFailure(instance, 'Reconectando');
        return;
      }
      // Sem sessão: só um novo QR resolve. Alerta o dono uma única vez.
      if (instance.status === InstanceStatus.CONNECTED) {
        await this.handleLogout(instance);
        result.alerts++;
      }
    } catch (err) {
      if (err instanceof EvolutionApiError && err.isNotFound) {
        await this.recreate(instance);
        result.recreated++;
        if (instance.status === InstanceStatus.CONNECTED) {
          await this.handleLogout(instance);
          result.alerts++;
        }
        return;
      }
      await this.bumpFailure(instance, (err as Error).message);
    }
  }

  private async bumpFailure(instance: WhatsappInstance, error: string): Promise<void> {
    const failedChecks = instance.failedChecks + 1;
    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: {
        failedChecks,
        lastError: error,
        lastCheckedAt: new Date(),
        status: failedChecks >= MAX_FAILED_CHECKS ? InstanceStatus.ERROR : instance.status,
      },
    });
  }

  /** Recria a instância no Evolution mantendo o mesmo token (o webhook continua válido). */
  private async recreate(instance: WhatsappInstance): Promise<void> {
    if (instance.externalId) {
      await this.evolution.deleteInstance(instance.externalId).catch(() => undefined);
    }
    const { id } = await this.evolution.createInstance(instance.instanceName, this.tokenOf(instance));
    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: { externalId: id ?? null, status: InstanceStatus.CREATED, failedChecks: 0, lastError: null },
    });
  }

  /**
   * Marca como conectada. A troca de status é atômica (updateMany com condição): se o
   * webhook e a consulta do app chegarem juntos, só um deles "ganha" e dispara o aviso.
   */
  private async markConnected(instance: Pick<WhatsappInstance, 'id' | 'tenantId'>): Promise<void> {
    const now = new Date();
    const changed = await this.prisma.whatsappInstance.updateMany({
      where: { id: instance.id, status: { not: InstanceStatus.CONNECTED } },
      data: { status: InstanceStatus.CONNECTED, connectedAt: now },
    });
    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: { failedChecks: 0, lastError: null, lastCheckedAt: now },
    });
    if (changed.count > 0) await this.push.notifyOwners(instance.tenantId, Push.whatsappConnected());
  }

  private async safeStatus(token: string) {
    try {
      return await this.evolution.getStatus(token);
    } catch {
      return null;
    }
  }

  private webhookUrl(instance: WhatsappInstance): string {
    return `${this.publicUrl}/webhooks/whatsapp/${instance.id}?secret=${instance.webhookSecret}`;
  }

  private tokenOf(instance: WhatsappInstance): string {
    return decrypt(instance.tokenEncrypted, this.key);
  }

  /**
   * Instância da barbearia, criando-a se ainda não existir (ex.: barbearias criadas
   * pelo seed ou antes do Evolution estar no ar).
   */
  private async getOrProvision(tenantId: string): Promise<WhatsappInstance> {
    const instance = await this.prisma.whatsappInstance.findUnique({ where: { tenantId } });
    if (instance) return instance;
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
    if (!tenant) throw new NotFoundException('Barbearia não encontrada');
    return this.ensureInstance(tenantId, tenant.slug);
  }

  private async getOrThrow(tenantId: string): Promise<WhatsappInstance> {
    const instance = await this.prisma.whatsappInstance.findUnique({ where: { tenantId } });
    if (!instance) throw new NotFoundException('WhatsApp ainda não configurado para esta barbearia');
    return instance;
  }
}

function toPublic(i: WhatsappInstance): PublicInstanceStatus {
  // O erro técnico fica só no banco/logs: a barbearia nunca vê detalhes do provedor.
  return {
    status: i.status,
    phoneNumber: i.phoneNumber,
    connectedAt: i.connectedAt,
    lastError: i.lastError ? 'Falha de comunicação com o serviço de WhatsApp' : null,
  };
}
