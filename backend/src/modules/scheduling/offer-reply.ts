/**
 * Interpreta a resposta do cliente a uma proposta (adiantar / remarcar).
 * Retorna null quando a mensagem não é uma resposta clara — nesse caso a IA assume.
 */
export type OfferReply = { kind: 'accept'; index: number } | { kind: 'decline' } | { kind: 'cancel' } | null;

const YES = ['sim', 's', 'quero', 'pode', 'pode ser', 'bora', 'ok', 'aceito', 'claro', 'isso', 'yes', 'beleza', 'fechado', 'manda', 'adiantar', 'quero sim', 'sim quero', 'sim pode', 'pode sim'];
const NO = ['nao', 'n', 'nao quero', 'nao obrigado', 'nao obrigada', 'agora nao', 'deixa', 'deixa como esta', 'nao precisa', 'prefiro manter', 'manter', 'no'];
const CANCEL = ['cancelar', 'cancela', 'cancelar horario', 'quero cancelar'];

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseOfferReply(text: string, optionsCount: number): OfferReply {
  const t = normalizeText(text);
  if (!t) return null;

  if (CANCEL.includes(t)) return { kind: 'cancel' };

  const num = /^(?:opcao\s*)?(\d{1,2})$/.exec(t);
  if (num) {
    const index = Number(num[1]) - 1;
    return index >= 0 && index < optionsCount ? { kind: 'accept', index } : null;
  }

  if (NO.includes(t) || /^nao\b/.test(t)) return { kind: 'decline' };
  // "sim" só faz sentido quando existe uma única opção (proposta de adiantamento).
  if (optionsCount === 1 && (YES.includes(t) || /^sim\b/.test(t))) return { kind: 'accept', index: 0 };

  return null;
}
