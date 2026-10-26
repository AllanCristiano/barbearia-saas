/**
 * Normaliza telefones brasileiros para o formato E.164 sem "+" (ex.: 5511987654321),
 * que é o formato usado pelo WhatsApp.
 * Aceita: "(11) 98765-4321", "11987654321", "+55 11 98765-4321", "5511987654321@s.whatsapp.net".
 */
export function normalizePhone(raw: string): string {
  const digits = raw.split('@')[0].replace(/\D/g, '');
  if (!digits) throw new Error(`Telefone inválido: ${raw}`);
  let phone = digits.replace(/^0+/, '');
  // DDD + número (10 ou 11 dígitos) sem código do país
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  if (phone.length < 12 || phone.length > 15) throw new Error(`Telefone inválido: ${raw}`);
  return phone;
}

export function isValidPhone(raw: string): boolean {
  try {
    normalizePhone(raw);
    return true;
  } catch {
    return false;
  }
}

/** Formata para exibição: 5511987654321 -> (11) 98765-4321 */
export function formatPhone(phone: string): string {
  const m = phone.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : phone;
}
