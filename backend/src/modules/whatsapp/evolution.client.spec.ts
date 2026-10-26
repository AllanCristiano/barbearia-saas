import { fakeConfig } from '../../testing/prisma-mock';
import { EvolutionApiError, EvolutionClient } from './evolution.client';

describe('EvolutionClient', () => {
  const fetchMock = jest.fn();
  let client: EvolutionClient;

  const respond = (status: number, body: unknown) =>
    fetchMock.mockResolvedValueOnce({
      ok: status < 400,
      status,
      statusText: 'x',
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    });

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as any;
    client = new EvolutionClient(fakeConfig());
  });

  it('cria instância com a chave GLOBAL', async () => {
    respond(200, { data: { id: 'evo-1', name: 'bb_x' }, message: 'success' });
    await expect(client.createInstance('bb_x', 'tok')).resolves.toEqual({ id: 'evo-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evolution:8080/instance/create');
    expect(init.headers.apikey).toBe('global-key');
    expect(JSON.parse(init.body)).toMatchObject({ name: 'bb_x', token: 'tok' });
  });

  it('envia texto com o token da INSTÂNCIA', async () => {
    respond(200, { data: { Info: { ID: 'wamid-1' } } });
    await expect(client.sendText('inst-token', '5511987654321', 'Olá')).resolves.toEqual({ messageId: 'wamid-1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evolution:8080/send/text');
    expect(init.headers.apikey).toBe('inst-token');
    expect(JSON.parse(init.body)).toEqual({ number: '5511987654321', text: 'Olá' });
  });

  it('pede código de pareamento com o token da instância', async () => {
    respond(200, { message: 'success', data: { PairingCode: 'ABCD-EFGH' } });
    await expect(client.pair('inst-token', '5511987654321', ['MESSAGE'])).resolves.toEqual({ pairingCode: 'ABCD-EFGH' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://evolution:8080/instance/pair');
    expect(init.headers.apikey).toBe('inst-token');
    expect(JSON.parse(init.body)).toEqual({ phone: '5511987654321', subscribe: ['MESSAGE'] });
  });

  it('lê status em PascalCase (Go)', async () => {
    respond(200, { data: { Connected: true, LoggedIn: true, Name: 'Barbearia' } });
    await expect(client.getStatus('t')).resolves.toEqual({ connected: true, loggedIn: true, name: 'Barbearia' });
  });

  it('lê QR code', async () => {
    respond(200, { data: { qrcode: 'data:image/png;base64,AAA', code: '2@abc' } });
    await expect(client.getQr('t')).resolves.toEqual({ qrcode: 'data:image/png;base64,AAA', code: '2@abc' });
  });

  it('converte erros HTTP em EvolutionApiError', async () => {
    respond(404, { error: 'instance not found' });
    const err = await client.getStatus('t').catch((e) => e);
    expect(err).toBeInstanceOf(EvolutionApiError);
    expect(err.status).toBe(404);
    expect(err.isNotFound).toBe(true);
  });

  it('erro de rede vira status 0', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const err = await client.getStatus('t').catch((e) => e);
    expect(err).toBeInstanceOf(EvolutionApiError);
    expect(err.status).toBe(0);
  });

  it('ping retorna false quando indisponível', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down'));
    await expect(client.ping()).resolves.toBe(false);
  });
});
