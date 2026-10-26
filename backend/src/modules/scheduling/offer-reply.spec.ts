import { normalizeText, parseOfferReply } from './offer-reply';

describe('parseOfferReply', () => {
  it.each(['Sim', 'sim!', 'SIM QUERO', 'Quero', 'pode ser', 'ok', 'Bora'])('aceita "%s" em proposta única', (t) => {
    expect(parseOfferReply(t, 1)).toEqual({ kind: 'accept', index: 0 });
  });

  it.each(['não', 'Nao', 'NÃO, obrigado', 'agora não', 'prefiro manter'])('recusa "%s"', (t) => {
    expect(parseOfferReply(t, 1)).toEqual({ kind: 'decline' });
  });

  it('número escolhe a opção', () => {
    expect(parseOfferReply('2', 3)).toEqual({ kind: 'accept', index: 1 });
    expect(parseOfferReply('opção 3', 3)).toEqual({ kind: 'accept', index: 2 });
  });

  it('número fora da faixa não é resposta', () => {
    expect(parseOfferReply('4', 3)).toBeNull();
    expect(parseOfferReply('0', 3)).toBeNull();
  });

  it('"sim" com várias opções é ambíguo (a IA assume)', () => {
    expect(parseOfferReply('sim', 3)).toBeNull();
  });

  it('cancelar', () => {
    expect(parseOfferReply('Cancelar', 3)).toEqual({ kind: 'cancel' });
  });

  it('mensagens livres retornam null', () => {
    expect(parseOfferReply('tem horário amanhã de manhã?', 1)).toBeNull();
    expect(parseOfferReply('', 1)).toBeNull();
  });

  it('normalizeText remove acentos e pontuação', () => {
    expect(normalizeText('  Não!!  Obrigado.  ')).toBe('nao obrigado');
  });
});
