import { decrypt, encrypt, safeEqual } from './crypto.util';
import { formatPhone, isValidPhone, normalizePhone } from './phone.util';
import { addDaysToDate, dateToMinutes, humanTime, localDate, minutesToDate, startOfDayInTz, weekdayOf } from './time.util';

describe('phone.util', () => {
  it.each([
    ['(11) 98765-4321', '5511987654321'],
    ['11987654321', '5511987654321'],
    ['+55 11 98765-4321', '5511987654321'],
    ['5511987654321@s.whatsapp.net', '5511987654321'],
    ['011 98765-4321', '5511987654321'],
    ['1132654321', '551132654321'],
  ])('normaliza %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('rejeita números inválidos', () => {
    expect(isValidPhone('123')).toBe(false);
    expect(isValidPhone('abc')).toBe(false);
  });

  it('formata para exibição', () => {
    expect(formatPhone('5511987654321')).toBe('(11) 98765-4321');
  });
});

describe('crypto.util', () => {
  const key = Buffer.alloc(32, 1).toString('base64');

  it('criptografa e descriptografa', () => {
    const enc = encrypt('token-secreto', key);
    expect(enc).not.toContain('token-secreto');
    expect(decrypt(enc, key)).toBe('token-secreto');
  });

  it('falha com chave errada (autenticação GCM)', () => {
    const enc = encrypt('x', key);
    expect(() => decrypt(enc, Buffer.alloc(32, 2).toString('base64'))).toThrow();
  });

  it('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('time.util (fuso America/Sao_Paulo, UTC-3)', () => {
  const tz = 'America/Sao_Paulo';

  it('converte minutos locais para UTC e de volta', () => {
    const d = minutesToDate('2026-10-24', 14 * 60 + 30, tz);
    expect(d.toISOString()).toBe('2026-10-24T17:30:00.000Z');
    expect(dateToMinutes(d, tz)).toBe(870);
    expect(humanTime(d, tz)).toBe('14:30');
  });

  it('início do dia local', () => {
    expect(startOfDayInTz('2026-10-24', tz).toISOString()).toBe('2026-10-24T03:00:00.000Z');
  });

  it('data local de um instante perto da meia-noite UTC', () => {
    expect(localDate(new Date('2026-10-25T02:00:00Z'), tz)).toBe('2026-10-24');
  });

  it('dia da semana e soma de dias', () => {
    expect(weekdayOf('2026-10-24')).toBe(6); // sábado
    expect(addDaysToDate('2026-10-31', 1)).toBe('2026-11-01');
  });
});
