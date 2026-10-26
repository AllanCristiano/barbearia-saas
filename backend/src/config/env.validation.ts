const REQUIRED = [
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'ENCRYPTION_KEY',
  'PUBLIC_API_URL',
  'EVOLUTION_API_URL',
  'EVOLUTION_GLOBAL_API_KEY',
] as const;

const DEFAULTS: Record<string, string> = {
  PORT: '3000',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  JWT_EXPIRES_IN: '15m',
  JWT_REFRESH_EXPIRES_IN: '30d',
  PLATFORM_PRICE_CENTS: '20000',
  TRIAL_DAYS: '7',
  GRACE_DAYS: '3',
  WHATSAPP_SEND_INTERVAL_MS: '1500',
};

/**
 * Validação simples das variáveis de ambiente (executada pelo ConfigModule).
 * Falha cedo no boot caso falte algo essencial.
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...DEFAULTS, ...config };
  const missing = REQUIRED.filter((key) => !merged[key]);
  if (missing.length) {
    throw new Error(`Variáveis de ambiente ausentes: ${missing.join(', ')}`);
  }
  const key = Buffer.from(String(merged.ENCRYPTION_KEY), 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY deve ser 32 bytes em base64 (openssl rand -base64 32)');
  }
  return merged;
}
