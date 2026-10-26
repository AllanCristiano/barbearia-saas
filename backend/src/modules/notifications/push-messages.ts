import { formatMoney, humanDateTime } from '../../common/utils/time.util';

/**
 * Canais de notificação do Android (criados no app com os mesmos ids).
 * Cada canal tem prioridade, som e cor próprios — e o usuário pode silenciar um sem perder os outros.
 */
export type PushChannel = 'agendamentos' | 'cancelamentos' | 'whatsapp' | 'geral';

export type PushType =
  | 'APPOINTMENT_NEW'
  | 'APPOINTMENT_CANCELED'
  | 'APPOINTMENT_RESCHEDULED'
  | 'APPOINTMENT_ADVANCED'
  | 'RESCHEDULE_NO_REPLY'
  | 'WHATSAPP_DISCONNECTED'
  | 'WHATSAPP_CONNECTED'
  | 'HUMAN_REQUESTED'
  | 'BILLING'
  | 'TEST';

export interface PushMessage {
  title: string;
  body: string;
  channel?: PushChannel;
  data?: { type?: PushType; appointmentId?: string; customerId?: string; screen?: string } & Record<string, unknown>;
}

interface AppointmentInfo {
  id: string;
  customerName?: string | null;
  serviceName: string;
  barberName: string;
  startsAt: Date;
  priceCents?: number;
}

const who = (name?: string | null) => name?.trim() || 'Cliente';

/**
 * Textos das notificações push no tom do app: título curto em CAIXA ALTA com emoji
 * (lê como os títulos em Bebas Neue) e corpo com o essencial para decidir sem abrir o app.
 */
export const Push = {
  newAppointment(a: AppointmentInfo, tz: string, viaWhatsapp: boolean): PushMessage {
    return {
      title: '✂️ NOVO CLIENTE NA CADEIRA',
      body:
        `${who(a.customerName)} · ${a.serviceName}${a.priceCents ? ` · ${formatMoney(a.priceCents)}` : ''}\n` +
        `📅 ${humanDateTime(a.startsAt, tz)} com ${a.barberName}${viaWhatsapp ? ' · via WhatsApp' : ''}`,
      channel: 'agendamentos',
      data: { type: 'APPOINTMENT_NEW', appointmentId: a.id },
    };
  },

  canceledByCustomer(a: AppointmentInfo, tz: string): PushMessage {
    return {
      title: '❌ HORÁRIO CANCELADO',
      body: `${who(a.customerName)} cancelou ${a.serviceName} de ${humanDateTime(a.startsAt, tz)}.\nA vaga já foi oferecida ao próximo da fila. ⚡`,
      channel: 'cancelamentos',
      data: { type: 'APPOINTMENT_CANCELED', appointmentId: a.id },
    };
  },

  rescheduledByCustomer(a: AppointmentInfo, tz: string): PushMessage {
    return {
      title: '🔁 CLIENTE REMARCOU',
      body: `${who(a.customerName)} mudou para ${humanDateTime(a.startsAt, tz)} com ${a.barberName}.`,
      channel: 'agendamentos',
      data: { type: 'APPOINTMENT_RESCHEDULED', appointmentId: a.id },
    };
  },

  advanceAccepted(a: AppointmentInfo, tz: string): PushMessage {
    return {
      title: '⚡ HORÁRIO ADIANTADO',
      body: `${who(a.customerName)} aceitou adiantar: agora é ${humanDateTime(a.startsAt, tz)}.`,
      channel: 'agendamentos',
      data: { type: 'APPOINTMENT_ADVANCED', appointmentId: a.id },
    };
  },

  rescheduleAccepted(a: AppointmentInfo, tz: string): PushMessage {
    return {
      title: '🔁 REMARCAÇÃO CONFIRMADA',
      body: `${who(a.customerName)} escolheu o novo horário: ${humanDateTime(a.startsAt, tz)} com ${a.barberName}.`,
      channel: 'agendamentos',
      data: { type: 'APPOINTMENT_RESCHEDULED', appointmentId: a.id },
    };
  },

  rescheduleNoReply(customer: string, appointmentId: string): PushMessage {
    return {
      title: '⏳ SEM RESPOSTA NA REMARCAÇÃO',
      body: `${customer} ainda não escolheu um novo horário. Vale dar um toque nele.`,
      channel: 'geral',
      data: { type: 'RESCHEDULE_NO_REPLY', appointmentId },
    };
  },

  whatsappDisconnected(): PushMessage {
    return {
      title: '⚠️ WHATSAPP DESCONECTADO',
      body: 'Teu atendimento automático parou. Toca aqui e reconecta em 1 minuto pra não perder cliente.',
      channel: 'whatsapp',
      data: { type: 'WHATSAPP_DISCONNECTED', screen: 'WhatsApp' },
    };
  },

  whatsappConnected(): PushMessage {
    return {
      title: '✅ WHATSAPP NO AR',
      body: 'Atendimento automático funcionando. Pode deixar que a agenda enche sozinha. 💈',
      channel: 'whatsapp',
      data: { type: 'WHATSAPP_CONNECTED', screen: 'WhatsApp' },
    };
  },

  humanRequested(customer: string, customerId: string): PushMessage {
    return {
      title: '💬 CLIENTE QUER FALAR CONTIGO',
      body: `${customer} pediu atendimento. Responde pelo WhatsApp da barbearia.`,
      channel: 'geral',
      data: { type: 'HUMAN_REQUESTED', customerId },
    };
  },

  billing(title: string, body: string): PushMessage {
    return { title, body, channel: 'geral', data: { type: 'BILLING', screen: 'Billing' } };
  },

  test(): PushMessage {
    return {
      title: '💈 NOTIFICAÇÕES ATIVADAS',
      body: 'Tudo certo! Agendamentos, cancelamentos e avisos do WhatsApp chegam aqui, mesmo com o app fechado.',
      channel: 'agendamentos',
      data: { type: 'TEST' },
    };
  },
};
