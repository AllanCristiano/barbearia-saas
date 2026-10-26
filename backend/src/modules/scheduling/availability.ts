/**
 * Cálculo puro de horários livres (sem banco), em minutos desde 00:00 do dia local.
 * Mantido isolado para ser fácil de testar e de raciocinar.
 */
export interface MinuteRange {
  start: number;
  end: number;
}

export interface SlotQuery {
  /** Janelas de trabalho do barbeiro no dia (ex.: [{540, 720}, {780, 1140}]). */
  windows: MinuteRange[];
  /** Agendamentos e folgas que ocupam a agenda. */
  busy: MinuteRange[];
  durationMinutes: number;
  stepMinutes: number;
  /** Nenhum horário antes deste minuto (usado para "hoje": agora + antecedência). */
  notBefore?: number;
}

export function overlaps(a: MinuteRange, b: MinuteRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function computeSlots(q: SlotQuery): number[] {
  if (q.durationMinutes <= 0 || q.stepMinutes <= 0) return [];
  const slots: number[] = [];
  const windows = [...q.windows].sort((a, b) => a.start - b.start);

  for (const w of windows) {
    for (let t = w.start; t + q.durationMinutes <= w.end; t += q.stepMinutes) {
      if (q.notBefore !== undefined && t < q.notBefore) continue;
      const candidate = { start: t, end: t + q.durationMinutes };
      if (!q.busy.some((b) => overlaps(candidate, b))) slots.push(t);
    }
  }
  return [...new Set(slots)].sort((a, b) => a - b);
}

/** O intervalo inteiro cabe dentro de alguma janela de trabalho e não colide com nada? */
export function fitsInSchedule(range: MinuteRange, windows: MinuteRange[], busy: MinuteRange[]): boolean {
  return checkRange(range, windows, busy) === 'ok';
}

/** Motivo de um horário não servir: fora do expediente ou já ocupado. */
export function checkRange(range: MinuteRange, windows: MinuteRange[], busy: MinuteRange[]): 'ok' | 'outside' | 'taken' {
  if (!windows.some((w) => range.start >= w.start && range.end <= w.end)) return 'outside';
  return busy.some((b) => overlaps(range, b)) ? 'taken' : 'ok';
}

/** "09:00" -> 540 */
export function parseHHMM(value: string): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!m) throw new Error(`Horário inválido: ${value}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 540 -> "09:00" */
export function formatHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
