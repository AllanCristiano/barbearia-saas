import { EvolutionApiError } from './evolution.client';
import { EvolutionErrorFilter } from './evolution-error.filter';

function host() {
  const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) };
  return { res, host: { switchToHttp: () => ({ getResponse: () => res }) } as any };
}

describe('EvolutionErrorFilter', () => {
  it('licença não ativada → 503 com mensagem amigável, sem citar o provedor', () => {
    const { res, host: h } = host();
    new EvolutionErrorFilter().catch(
      new EvolutionApiError('Evolution POST /instance/create falhou (503): License required', 503, { code: 'LICENSE_REQUIRED' }),
      h,
    );
    expect(res.status).toHaveBeenCalledWith(503);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe('WHATSAPP_NOT_ACTIVATED');
    expect(JSON.stringify(body)).not.toMatch(/evolution/i);
  });

  it('indisponibilidade genérica → 503', () => {
    const { res, host: h } = host();
    new EvolutionErrorFilter().catch(new EvolutionApiError('Evolution GET /instance/qr inacessível: timeout', 0), h);
    expect(res.json.mock.calls[0][0].code).toBe('WHATSAPP_UNAVAILABLE');
  });
});
