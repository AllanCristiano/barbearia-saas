import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Cliente HTTP do Evolution Go.
 *
 * Toda a comunicação com o Evolution Go passa por aqui — nenhum outro módulo
 * conhece URLs, chaves ou formatos do provedor. A barbearia nunca vê o Evolution:
 * para ela existe apenas "conectar WhatsApp".
 *
 * Autenticação (header `apikey`):
 *  - chave GLOBAL  → operações administrativas (criar, listar, excluir instâncias)
 *  - token da instância → operações da instância (connect, qr, status, envio)
 */
export class EvolutionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }

  get isNotFound(): boolean {
    return this.status === 404 || /not found|não encontrad/i.test(this.message);
  }
}

export interface EvolutionStatus {
  connected: boolean;
  loggedIn: boolean;
  name?: string;
}

export interface EvolutionQr {
  /** Imagem PNG em data URI/base64, pronta para exibir. */
  qrcode?: string;
  /** Conteúdo bruto do QR (para gerar no app, se preferir). */
  code?: string;
}

type Json = Record<string, any>;

@Injectable()
export class EvolutionClient {
  private readonly logger = new Logger(EvolutionClient.name);
  private readonly baseUrl: string;
  private readonly globalKey: string;
  private readonly timeoutMs = 15_000;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('EVOLUTION_API_URL').replace(/\/$/, '');
    this.globalKey = config.getOrThrow<string>('EVOLUTION_GLOBAL_API_KEY');
  }

  async createInstance(name: string, token: string): Promise<{ id?: string }> {
    const res = await this.request('POST', '/instance/create', this.globalKey, {
      name,
      token,
      advancedSettings: { ignoreGroups: true, ignoreStatus: true, alwaysOnline: false, readMessages: false },
    });
    const data = unwrap(res);
    return { id: data?.id ?? data?.Id ?? data?.instanceId };
  }

  async connect(token: string, webhookUrl: string, events: string[]): Promise<void> {
    await this.request('POST', '/instance/connect', token, {
      webhookUrl,
      subscribe: events,
      immediate: true,
    });
  }

  async getQr(token: string): Promise<EvolutionQr> {
    const data = unwrap(await this.request('GET', '/instance/qr', token));
    return {
      qrcode: data?.qrcode ?? data?.Qrcode ?? data?.base64,
      code: data?.code ?? data?.Code,
    };
  }

  /**
   * Código de pareamento (8 caracteres) para conectar pelo próprio celular, sem QR:
   * WhatsApp → Dispositivos conectados → Conectar com número de telefone.
   * `phone` no formato internacional só com dígitos (5511987654321).
   */
  async pair(token: string, phone: string, events: string[]): Promise<{ pairingCode?: string }> {
    const data = unwrap(await this.request('POST', '/instance/pair', token, { phone, subscribe: events }));
    const code = typeof data === 'string' ? data : (data?.PairingCode ?? data?.pairingCode ?? data?.code);
    return { pairingCode: code };
  }

  async getStatus(token: string): Promise<EvolutionStatus> {
    const data = unwrap(await this.request('GET', '/instance/status', token));
    return {
      connected: Boolean(data?.Connected ?? data?.connected),
      loggedIn: Boolean(data?.LoggedIn ?? data?.loggedIn),
      name: data?.Name ?? data?.name,
    };
  }

  async reconnect(token: string): Promise<void> {
    await this.request('POST', '/instance/reconnect', token);
  }

  async logout(token: string): Promise<void> {
    await this.request('DELETE', '/instance/logout', token);
  }

  async deleteInstance(instanceId: string): Promise<void> {
    await this.request('DELETE', `/instance/delete/${encodeURIComponent(instanceId)}`, this.globalKey);
  }

  async listInstances(): Promise<Array<{ id?: string; name: string; connected?: boolean }>> {
    const data = unwrap(await this.request('GET', '/instance/all', this.globalKey));
    const list: Json[] = Array.isArray(data) ? data : [];
    return list.map((i) => ({ id: i.id ?? i.Id, name: i.name ?? i.Name, connected: i.connected ?? i.Connected }));
  }

  async sendText(token: string, number: string, text: string): Promise<{ messageId?: string }> {
    const data = unwrap(await this.request('POST', '/send/text', token, { number, text }));
    return { messageId: data?.Info?.ID ?? data?.key?.id ?? data?.id ?? data?.ID };
  }

  /** Verifica se o Evolution Go está no ar (usado no /health). */
  async ping(): Promise<boolean> {
    try {
      await this.request('GET', '/instance/all', this.globalKey);
      return true;
    } catch (err) {
      this.logger.warn(`Evolution indisponível: ${(err as Error).message}`);
      return false;
    }
  }

  private async request(method: string, path: string, apikey: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', apikey },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      const parsed = text ? safeJson(text) : undefined;
      if (!res.ok) {
        const msg = (parsed as Json)?.error ?? (parsed as Json)?.message ?? res.statusText;
        throw new EvolutionApiError(`Evolution ${method} ${path} falhou (${res.status}): ${msg}`, res.status, parsed);
      }
      return parsed;
    } catch (err) {
      if (err instanceof EvolutionApiError) throw err;
      const reason = (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message;
      throw new EvolutionApiError(`Evolution ${method} ${path} inacessível: ${reason}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** O Evolution Go responde `{ data: ..., message: ... }`; aceitamos também o objeto puro. */
function unwrap(res: unknown): any {
  if (res && typeof res === 'object' && 'data' in (res as Json)) return (res as Json).data;
  return res;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
