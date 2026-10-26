export const OUTBOUND_QUEUE = 'whatsapp-outbound';
export const INBOUND_QUEUE = 'whatsapp-inbound';

export interface OutboundJob {
  messageLogId: string;
}

export interface InboundJob {
  tenantId: string;
  phone: string;
  text: string;
  pushName?: string;
  messageId?: string;
}
