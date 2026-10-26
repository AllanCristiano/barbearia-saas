import { formatMoney, humanDateTime, humanTime } from '../../common/utils/time.util';

/**
 * Textos enviados aos clientes pelo WhatsApp.
 *
 * Tom: a quebrada venceu e tá vencendo. Cada mensagem tem que dar vontade de
 * sentar na cadeira — autoestima, presença, "sair no nível". Mas a instrução
 * (o que responder) sempre aparece clara e em *negrito*.
 */
export interface AppointmentView {
  customerName?: string | null;
  serviceName: string;
  barberName: string;
  startsAt: Date;
  priceCents?: number;
}

const first = (name?: string | null) => name?.trim().split(/\s+/)[0];
const hey = (name?: string | null) => (first(name) ? `E aí, ${first(name)}!` : 'E aí, meu parceiro!');

/** Bloco padrão com os dados do horário. */
function ticket(a: AppointmentView, tz: string, withPrice = true): string {
  return (
    `✂️ *${a.serviceName}*${withPrice && a.priceCents ? ` — ${formatMoney(a.priceCents)}` : ''}\n` +
    `💈 Com *${a.barberName}*\n` +
    `📅 *${humanDateTime(a.startsAt, tz)}*`
  );
}

export const Messages = {
  confirmation(shop: string, a: AppointmentView, tz: string): string {
    return (
      `${hey(a.customerName)} Teu horário na *${shop}* está confirmado ✅🔥\n\n` +
      `${ticket(a, tz)}\n\n` +
      `Chega uns 5 minutinhos antes que a cadeira já vai tá te esperando. ` +
      `Daqui tu sai na régua, no nível de quem tá vencendo. 👑\n\n` +
      `_Precisou mudar? É só mandar mensagem aqui._`
    );
  },

  reminder(shop: string, a: AppointmentView, tz: string): string {
    return (
      `⏰ ${hey(a.customerName)} Hoje é dia de renovar o visual!\n\n` +
      `${ticket(a, tz, false)}\n\n` +
      `A *${shop}* já tá preparando tudo pra você sair com a autoestima lá em cima. 💈✨\n\n` +
      `Responde *CONFIRMAR* pra garantir teu lugar na cadeira, ou *CANCELAR* se pintou imprevisto.`
    );
  },

  canceledByShop(shop: string, a: AppointmentView, tz: string, reason?: string | null): string {
    return (
      `${hey(a.customerName)} Precisamos cancelar teu horário de *${humanDateTime(a.startsAt, tz)}* na *${shop}*` +
      `${reason ? ` (${reason})` : ''}. Foi mal pelo imprevisto! 🙏\n\n` +
      `Mas o visual não pode esperar: responde *AGENDAR* que a gente te encaixa no próximo horário. 💈`
    );
  },

  canceledByCustomer(a: AppointmentView, tz: string): string {
    return (
      `Fechou, teu horário de *${humanDateTime(a.startsAt, tz)}* foi cancelado. 👍\n\n` +
      `Quando bater a vontade de dar aquele trato no visual, é só mandar *AGENDAR*. A cadeira tá sempre te esperando. 💈`
    );
  },

  rescheduledByShop(shop: string, a: AppointmentView, tz: string): string {
    return (
      `${hey(a.customerName)} Teu horário na *${shop}* foi remarcado 🔁\n\n` +
      `${ticket(a, tz, false)}\n\n` +
      `Se esse horário não fechar contigo, responde *REMARCAR* que a gente acha outro. 🤝`
    );
  },

  advanceOffer(a: AppointmentView, newStart: Date, newBarber: string, tz: string, expiresMinutes: number): string {
    return (
      `🚨 *VAGA LIBERADA*, ${first(a.customerName) ?? 'parceiro'}!\n\n` +
      `Abriu um horário *mais cedo* com *${newBarber}*:\n` +
      `🕐 *${humanTime(newStart, tz)}* (o teu era ${humanDateTime(a.startsAt, tz)})\n\n` +
      `Quer adiantar e já sair na régua? Responde *SIM* ou *NÃO*.\n` +
      `_Vale por ${expiresMinutes} minutos — depois a vaga vai pro próximo da fila._ ⚡`
    );
  },

  rescheduleOffer(shop: string, a: AppointmentView, options: { startsAt: Date; barberName: string }[], tz: string): string {
    const list = options.map((o, i) => `*${i + 1}* - ${humanDateTime(o.startsAt, tz)} com ${o.barberName}`).join('\n');
    return (
      `${hey(a.customerName)} Pintou um imprevisto e o *${a.barberName}* não vai conseguir te atender ` +
      `em *${humanDateTime(a.startsAt, tz)}* na *${shop}*. Foi mal! 🙏\n\n` +
      `Mas a gente não te deixa na mão — separei esses horários pra você:\n\n${list}\n\n` +
      `Responde com o *número* da opção. Nenhum serviu? Responde *NÃO*. Prefere cancelar? *CANCELAR*.`
    );
  },

  rescheduleNoOptions(shop: string, a: AppointmentView, tz: string): string {
    return (
      `${hey(a.customerName)} Pintou um imprevisto e o *${a.barberName}* não vai conseguir te atender ` +
      `em *${humanDateTime(a.startsAt, tz)}* na *${shop}*. Foi mal! 🙏\n\n` +
      `Responde *REMARCAR* pra escolher um novo horário ou *CANCELAR* se preferir.`
    );
  },

  offerAccepted(a: AppointmentView, tz: string): string {
    return (
      `Feito! ✅ Adiantado com sucesso.\n\n` +
      `📅 Teu novo horário: *${humanDateTime(a.startsAt, tz)}* com *${a.barberName}*\n\n` +
      `Bora que hoje tu sai mais cedo no estilo. 🔥`
    );
  },

  offerTaken(): string {
    return 'Ih, alguém foi mais rápido e esse horário acabou de ser preenchido 😅 Relaxa: teu horário original continua garantido. 👊';
  },

  offerDeclinedAdvance(): string {
    return 'Tranquilo! Teu horário original continua garantido. Até lá! 👊💈';
  },

  offerDeclinedReschedule(): string {
    return 'Sem estresse! Responde *REMARCAR* pra ver outros dias e horários, ou *CANCELAR* se preferir.';
  },

  confirmedByCustomer(a: AppointmentView, tz: string): string {
    return `Presença confirmada ✅ Te esperamos *${humanDateTime(a.startsAt, tz)}*. Vem que vai ficar brabo! 🔥💈`;
  },

  optOut(): string {
    return (
      'Pronto, você não recebe mais as promoções. 👍 Os lembretes dos teus horários continuam chegando normal.\n\n' +
      'Mudou de ideia? Manda *RECEBER PROMOÇÕES*.'
    );
  },

  optIn(): string {
    return 'Aí sim! 🔥 Agora você fica sabendo das promoções e novidades antes de todo mundo.';
  },

  shopUnavailable(): string {
    return 'Opa! No momento o atendimento automático está indisponível. Chama a barbearia direto que a gente resolve contigo. 🤝';
  },

  botFallback(): string {
    return 'Eita, deu um probleminha aqui do meu lado 😅 Manda *menu* que a gente tenta de novo.';
  },
};
