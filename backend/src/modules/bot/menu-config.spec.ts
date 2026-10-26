import { DEFAULT_MENU, enabledOptions, resolveMenu } from './menu-config';

describe('resolveMenu', () => {
  it('sem configuração usa o padrão', () => {
    expect(resolveMenu(null)).toEqual(DEFAULT_MENU);
  });

  it('respeita ordem, rótulos e opções ocultas', () => {
    const menu = resolveMenu([
      { key: 'BOOK', label: 'Marcar meu corte', enabled: true },
      { key: 'HUMAN', label: 'Chamar o patrão', enabled: true },
      { key: 'RESCHEDULE', label: 'x', enabled: false },
    ]);
    expect(menu.slice(0, 3).map((o) => o.key)).toEqual(['BOOK', 'HUMAN', 'RESCHEDULE']);
    expect(enabledOptions(menu).map((o) => o.label)).toEqual(['Marcar meu corte', 'Chamar o patrão', '📅 Meus horários', '❌ Cancelar horário']);
  });

  it('ignora chaves inválidas/duplicadas e completa as que faltam', () => {
    const menu = resolveMenu([{ key: 'HACK', label: 'x', enabled: true }, { key: 'MY', label: 'A', enabled: true }, { key: 'MY', label: 'B', enabled: true }]);
    expect(menu.map((o) => o.key)).toEqual(['MY', 'BOOK', 'CANCEL', 'RESCHEDULE', 'HUMAN']);
    expect(menu[0].label).toBe('A');
  });

  it('rótulo vazio volta ao padrão; nunca deixa o menu sem opções', () => {
    const menu = resolveMenu(DEFAULT_MENU.map((o) => ({ ...o, label: ' ', enabled: false })));
    expect(menu[0].label).toBe('✂️ Agendar meu corte');
    expect(enabledOptions(menu).map((o) => o.key)).toEqual(['BOOK']);
  });
});
