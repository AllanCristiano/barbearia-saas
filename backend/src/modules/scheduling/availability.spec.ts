import { computeSlots, fitsInSchedule, formatHHMM, overlaps, parseHHMM } from './availability';

describe('availability (cálculo puro)', () => {
  const morning = { start: 540, end: 720 }; // 09:00–12:00
  const afternoon = { start: 780, end: 1140 }; // 13:00–19:00

  it('gera slots respeitando duração e passo', () => {
    const slots = computeSlots({ windows: [morning], busy: [], durationMinutes: 60, stepMinutes: 30 });
    expect(slots.map(formatHHMM)).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00']);
  });

  it('não oferece horário que ultrapassa o fim da janela (pausa de almoço)', () => {
    const slots = computeSlots({ windows: [morning, afternoon], busy: [], durationMinutes: 45, stepMinutes: 15 });
    expect(slots).not.toContain(parseHHMM('11:30'));
    expect(slots).toContain(parseHHMM('11:15'));
    expect(slots).toContain(parseHHMM('13:00'));
  });

  it('remove horários que colidem com agendamentos/folgas', () => {
    const slots = computeSlots({
      windows: [morning],
      busy: [{ start: parseHHMM('10:00'), end: parseHHMM('10:30') }],
      durationMinutes: 30,
      stepMinutes: 30,
    });
    expect(slots.map(formatHHMM)).toEqual(['09:00', '09:30', '10:30', '11:00', '11:30']);
  });

  it('um serviço longo não cabe antes de um agendamento próximo', () => {
    const slots = computeSlots({
      windows: [morning],
      busy: [{ start: parseHHMM('10:00'), end: parseHHMM('10:30') }],
      durationMinutes: 60,
      stepMinutes: 30,
    });
    expect(slots.map(formatHHMM)).toEqual(['09:00', '10:30', '11:00']);
  });

  it('respeita notBefore (horários de hoje que já passaram)', () => {
    const slots = computeSlots({ windows: [morning], busy: [], durationMinutes: 30, stepMinutes: 30, notBefore: parseHHMM('10:10') });
    expect(slots.map(formatHHMM)).toEqual(['10:30', '11:00', '11:30']);
  });

  it('retorna vazio sem janelas ou com parâmetros inválidos', () => {
    expect(computeSlots({ windows: [], busy: [], durationMinutes: 30, stepMinutes: 15 })).toEqual([]);
    expect(computeSlots({ windows: [morning], busy: [], durationMinutes: 0, stepMinutes: 15 })).toEqual([]);
  });

  it('overlaps considera intervalos encostados como livres', () => {
    expect(overlaps({ start: 0, end: 30 }, { start: 30, end: 60 })).toBe(false);
    expect(overlaps({ start: 0, end: 31 }, { start: 30, end: 60 })).toBe(true);
  });

  it('fitsInSchedule exige caber numa janela e não colidir', () => {
    expect(fitsInSchedule({ start: 540, end: 600 }, [morning], [])).toBe(true);
    expect(fitsInSchedule({ start: 700, end: 760 }, [morning, afternoon], [])).toBe(false);
    expect(fitsInSchedule({ start: 540, end: 600 }, [morning], [{ start: 570, end: 600 }])).toBe(false);
  });

  it('parseHHMM/formatHHMM', () => {
    expect(parseHHMM('09:05')).toBe(545);
    expect(formatHHMM(545)).toBe('09:05');
    expect(() => parseHHMM('25:00')).toThrow();
  });
});
