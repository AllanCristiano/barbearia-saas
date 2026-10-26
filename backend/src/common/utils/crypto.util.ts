import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto';

const ALGO = 'aes-256-gcm';

/** Criptografa um segredo (ex.: token da instância) com AES-256-GCM. Saída: iv.tag.dados em base64. */
export function encrypt(plain: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload: string, keyBase64: string): string {
  const [iv, tag, data] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
  if (!iv || !tag || !data) throw new Error('Payload criptografado inválido');
  const decipher = createDecipheriv(ALGO, Buffer.from(keyBase64, 'base64'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('hex');
}

/** Comparação de strings resistente a timing attacks. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
