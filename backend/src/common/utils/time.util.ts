import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';
import { ptBR } from 'date-fns/locale';

/** Converte "2026-10-24" no fuso da barbearia para o instante UTC de 00:00 daquele dia. */
export function startOfDayInTz(date: string, tz: string): Date {
  return fromZonedTime(`${date}T00:00:00`, tz);
}

/** Retorna o instante UTC correspondente a `minutes` minutos após a meia-noite local de `date`. */
export function minutesToDate(date: string, minutes: number, tz: string): Date {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return fromZonedTime(`${date}T${h}:${m}:00`, tz);
}

/** Minutos desde a meia-noite local para um instante. */
export function dateToMinutes(d: Date, tz: string): number {
  const z = toZonedTime(d, tz);
  return z.getHours() * 60 + z.getMinutes();
}

/** Dia da semana (0 = domingo) de uma data "YYYY-MM-DD". */
export function weekdayOf(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

export function localDate(d: Date, tz: string): string {
  return formatInTimeZone(d, tz, 'yyyy-MM-dd');
}

/** Ex.: "sáb, 24/10 às 14:30" */
export function humanDateTime(d: Date, tz: string): string {
  return formatInTimeZone(d, tz, "EEE, dd/MM 'às' HH:mm", { locale: ptBR });
}

export function humanTime(d: Date, tz: string): string {
  return formatInTimeZone(d, tz, 'HH:mm');
}

export function addDaysToDate(date: string, days: number): string {
  const [y, mo, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function isValidDateString(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`));
}

export function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
