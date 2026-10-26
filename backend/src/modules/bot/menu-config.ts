/**
 * Menu do bot personalizável por barbearia: cada opção pode ser renomeada,
 * ocultada e reordenada. A numeração exibida ao cliente é sempre sequencial
 * (1, 2, 3…) sobre as opções ativas.
 */
export const MENU_KEYS = ['BOOK', 'MY', 'CANCEL', 'RESCHEDULE', 'HUMAN'] as const;
export type MenuKey = (typeof MENU_KEYS)[number];

export interface MenuOption {
  key: MenuKey;
  label: string;
  enabled: boolean;
}

export const DEFAULT_MENU: MenuOption[] = [
  { key: 'BOOK', label: '✂️ Agendar meu corte', enabled: true },
  { key: 'MY', label: '📅 Meus horários', enabled: true },
  { key: 'CANCEL', label: '❌ Cancelar horário', enabled: true },
  { key: 'RESCHEDULE', label: '🔁 Remarcar horário', enabled: true },
  { key: 'HUMAN', label: '💬 Falar com a barbearia', enabled: true },
];

export const DEFAULT_MENU_PROMPT = 'Bora deixar o visual no padrão? Manda o *número*:';

/** Palavras que acionam cada opção, independentemente da numeração. */
export const MENU_KEYWORDS: Record<string, MenuKey> = {
  agendar: 'BOOK',
  marcar: 'BOOK',
  horario: 'BOOK',
  'meus horarios': 'MY',
  'meus agendamentos': 'MY',
  cancelar: 'CANCEL',
  remarcar: 'RESCHEDULE',
  atendente: 'HUMAN',
  humano: 'HUMAN',
};

export const MAX_LABEL_LENGTH = 40;

/** Menu efetivo: configuração salva (validada) ou o padrão. Garante todas as chaves, sem duplicatas. */
export function resolveMenu(raw: unknown): MenuOption[] {
  if (!Array.isArray(raw)) return DEFAULT_MENU.map((o) => ({ ...o }));
  const seen = new Set<MenuKey>();
  const result: MenuOption[] = [];
  for (const item of raw) {
    const key = (item as MenuOption)?.key;
    if (!MENU_KEYS.includes(key) || seen.has(key)) continue;
    seen.add(key);
    const fallback = DEFAULT_MENU.find((d) => d.key === key)!;
    const label = String((item as MenuOption).label ?? '').trim().slice(0, MAX_LABEL_LENGTH) || fallback.label;
    result.push({ key, label, enabled: (item as MenuOption).enabled !== false });
  }
  // Opções novas (ou ausentes na config salva) entram no fim, ativas.
  for (const d of DEFAULT_MENU) if (!seen.has(d.key)) result.push({ ...d });
  if (!result.some((o) => o.enabled)) result.find((o) => o.key === 'BOOK')!.enabled = true;
  return result;
}

export function enabledOptions(menu: MenuOption[]): MenuOption[] {
  return menu.filter((o) => o.enabled);
}
