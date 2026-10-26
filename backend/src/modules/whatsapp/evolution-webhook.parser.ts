/**
 * Converte o payload de webhook do Evolution Go (baseado em whatsmeow) num evento
 * interno simples. O parser é tolerante: campos podem vir em PascalCase (Go) ou
 * camelCase, e endereços podem vir como JID de telefone ou LID.
 */
export type ParsedWebhookEvent =
  | {
      type: 'message';
      phone: string;
      text: string;
      pushName?: string;
      messageId?: string;
    }
  | { type: 'connection'; connected: boolean }
  | { type: 'qrcode' }
  | { type: 'logout' }
  | { type: 'ignored'; reason: string };

type Json = Record<string, any>;

export function parseEvolutionWebhook(body: Json): ParsedWebhookEvent {
  const event = String(body?.event ?? body?.type ?? body?.Event ?? '').toLowerCase();
  const data: Json = body?.data ?? body?.Data ?? {};

  if (event.includes('logout') || event.includes('loggedout')) return { type: 'logout' };
  if (event.includes('qr')) return { type: 'qrcode' };
  if (event === 'connected' || event === 'connection' || event.includes('disconnect') || event === 'connection.update') {
    const state = String(data?.state ?? data?.status ?? '').toLowerCase();
    const connected = event === 'connected' || state === 'open' || state === 'connected' || data?.Connected === true;
    return { type: 'connection', connected: event.includes('disconnect') ? false : connected };
  }
  if (!event.includes('message')) return { type: 'ignored', reason: `evento ${event || 'desconhecido'}` };

  const info: Json = data?.Info ?? data?.info ?? data?.key ?? {};
  const message: Json = data?.Message ?? data?.message ?? {};

  if (info.IsFromMe ?? info.isFromMe ?? info.fromMe) return { type: 'ignored', reason: 'mensagem própria' };
  if (info.IsGroup ?? info.isGroup) return { type: 'ignored', reason: 'grupo' };

  const jid = pickPhoneJid(info);
  if (!jid) return { type: 'ignored', reason: 'remetente sem telefone' };
  if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) {
    return { type: 'ignored', reason: 'não é conversa individual' };
  }

  const text = extractText(message);
  if (!text) return { type: 'ignored', reason: 'mensagem sem texto' };

  return {
    type: 'message',
    phone: jid.split('@')[0].split(':')[0],
    text: text.trim(),
    pushName: info.PushName ?? info.pushName ?? data?.pushName,
    messageId: info.ID ?? info.Id ?? info.id,
  };
}

/** Prefere o JID de telefone (@s.whatsapp.net); com LID usa o endereço alternativo. */
function pickPhoneJid(info: Json): string | undefined {
  const candidates = [
    info.Sender,
    info.SenderAlt,
    info.Chat,
    info.RecipientAlt,
    info.sender,
    info.remoteJid,
    info.remoteJidAlt,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);
  return candidates.find((c) => c.endsWith('@s.whatsapp.net')) ?? candidates.find((c) => !c.endsWith('@lid'));
}

function extractText(m: Json): string | undefined {
  return (
    m.conversation ??
    m.Conversation ??
    m.extendedTextMessage?.text ??
    m.ExtendedTextMessage?.Text ??
    m.buttonsResponseMessage?.selectedDisplayText ??
    m.listResponseMessage?.title ??
    m.imageMessage?.caption ??
    undefined
  );
}
