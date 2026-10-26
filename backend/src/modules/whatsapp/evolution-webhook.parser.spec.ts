import { parseEvolutionWebhook } from './evolution-webhook.parser';

const message = (info: Record<string, unknown>, msg: Record<string, unknown> = { conversation: 'Oi, quero cortar' }) => ({
  event: 'Message',
  data: { Info: { ID: 'MSG1', PushName: 'Carlos', IsFromMe: false, IsGroup: false, ...info }, Message: msg },
});

describe('parseEvolutionWebhook', () => {
  it('extrai mensagem de texto de conversa individual', () => {
    expect(parseEvolutionWebhook(message({ Sender: '5511987654321@s.whatsapp.net' }))).toEqual({
      type: 'message',
      phone: '5511987654321',
      text: 'Oi, quero cortar',
      pushName: 'Carlos',
      messageId: 'MSG1',
    });
  });

  it('usa SenderAlt quando o remetente vem como LID', () => {
    const ev = parseEvolutionWebhook(message({ Sender: '123456@lid', SenderAlt: '5511987654321@s.whatsapp.net' }));
    expect(ev).toMatchObject({ type: 'message', phone: '5511987654321' });
  });

  it('remove sufixo de dispositivo do JID', () => {
    const ev = parseEvolutionWebhook(message({ Sender: '5511987654321:12@s.whatsapp.net' }));
    expect(ev).toMatchObject({ phone: '5511987654321' });
  });

  it('lê extendedTextMessage', () => {
    const ev = parseEvolutionWebhook(message({ Sender: '5511987654321@s.whatsapp.net' }, { extendedTextMessage: { text: 'link aqui' } }));
    expect(ev).toMatchObject({ text: 'link aqui' });
  });

  it('ignora mensagens próprias, grupos e sem texto', () => {
    expect(parseEvolutionWebhook(message({ Sender: '5511@s.whatsapp.net', IsFromMe: true })).type).toBe('ignored');
    expect(parseEvolutionWebhook(message({ Sender: '5511@s.whatsapp.net', IsGroup: true })).type).toBe('ignored');
    expect(parseEvolutionWebhook(message({ Sender: '5511@s.whatsapp.net' }, { audioMessage: {} })).type).toBe('ignored');
    expect(parseEvolutionWebhook(message({ Chat: '1203@g.us' })).type).toBe('ignored');
  });

  it('eventos de conexão e logout', () => {
    expect(parseEvolutionWebhook({ event: 'Connected', data: {} })).toEqual({ type: 'connection', connected: true });
    expect(parseEvolutionWebhook({ event: 'Disconnected', data: {} })).toEqual({ type: 'connection', connected: false });
    expect(parseEvolutionWebhook({ event: 'LoggedOut', data: {} })).toEqual({ type: 'logout' });
    expect(parseEvolutionWebhook({ event: 'QRCode', data: {} })).toEqual({ type: 'qrcode' });
  });

  it('evento desconhecido é ignorado', () => {
    expect(parseEvolutionWebhook({ event: 'Presence' }).type).toBe('ignored');
    expect(parseEvolutionWebhook({}).type).toBe('ignored');
  });
});
