/* Mock do PrismaService para testes unitários (sem banco). */
const MODELS = [
  'tenant',
  'user',
  'service',
  'workingHour',
  'timeOff',
  'customer',
  'appointment',
  'appointmentOffer',
  'whatsappInstance',
  'messageLog',
  'conversation',
  'campaign',
  'subscription',
  'payment',
  'processedEvent',
] as const;

const METHODS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
] as const;

type ModelMock = Record<(typeof METHODS)[number], jest.Mock>;
export type PrismaMock = Record<(typeof MODELS)[number], ModelMock> & {
  $transaction: jest.Mock;
  $executeRaw: jest.Mock;
  $queryRaw: jest.Mock;
};

export function createPrismaMock(): PrismaMock {
  const mock: any = {};
  for (const model of MODELS) {
    mock[model] = {};
    for (const method of METHODS) mock[model][method] = jest.fn();
    mock[model].findMany.mockResolvedValue([]);
    mock[model].updateMany.mockResolvedValue({ count: 0 });
  }
  mock.$executeRaw = jest.fn().mockResolvedValue(1);
  mock.$queryRaw = jest.fn().mockResolvedValue([]);
  // Callback → executa com o próprio mock; array → resolve todas as promises.
  mock.$transaction = jest.fn((arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(mock) : Promise.all(arg as Promise<unknown>[]),
  );
  return mock as PrismaMock;
}

/** ConfigService falso com valores padrão de teste. */
export function fakeConfig(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    PUBLIC_API_URL: 'https://api.test',
    EVOLUTION_API_URL: 'http://evolution:8080',
    EVOLUTION_GLOBAL_API_KEY: 'global-key',
    JWT_SECRET: 'jwt-secret',
    JWT_REFRESH_SECRET: 'jwt-refresh-secret',
    PLATFORM_PRICE_CENTS: '20000',
    GRACE_DAYS: '3',
    PLATFORM_PIX_KEY: 'pix@plataforma.com',
    ...overrides,
  };
  return {
    get: jest.fn((k: string, d?: unknown) => values[k] ?? d),
    getOrThrow: jest.fn((k: string) => {
      if (values[k] === undefined) throw new Error(`missing ${k}`);
      return values[k];
    }),
  } as any;
}

export const TENANT = {
  id: 't1',
  name: 'Barbearia Teste',
  slug: 'barbearia-teste',
  timezone: 'America/Sao_Paulo',
  status: 'ACTIVE',
  botEnabled: true,
  welcomeMessage: null,
  address: null,
  bookingWindowDays: 30,
  minCancelHours: 2,
  reminderHoursBefore: 3,
  slotStepMinutes: 15,
  offerTimeoutMinutes: 15,
} as any;
