/**
 * Seed:
 *  - sempre: cria/atualiza o SUPER_ADMIN (dono da plataforma) a partir do .env
 *  - SEED_DEMO=true: cria uma barbearia de demonstração com equipe, serviços e clientes
 */
import { PrismaClient, Role, SubscriptionStatus, TenantStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SUPER_ADMIN_EMAIL;
  const password = process.env.SUPER_ADMIN_PASSWORD;
  if (email && password) {
    await prisma.user.upsert({
      where: { email },
      create: { email, name: 'Administrador', role: Role.SUPER_ADMIN, passwordHash: await bcrypt.hash(password, 10) },
      update: {},
    });
    console.log(`SUPER_ADMIN pronto: ${email}`);
  } else {
    console.log('SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD não definidos — pulando super admin.');
  }

  if (process.env.SEED_DEMO !== 'true') return;

  const existing = await prisma.tenant.findUnique({ where: { slug: 'barbearia-demo' } });
  if (existing) {
    console.log('Barbearia demo já existe.');
    return;
  }
  const trialEndsAt = new Date(Date.now() + 30 * 86_400_000);
  const hash = await bcrypt.hash('demo12345', 10);
  const tenant = await prisma.tenant.create({
    data: {
      name: 'Barbearia Demo',
      slug: 'barbearia-demo',
      phone: '5511999990000',
      address: 'Rua Exemplo, 123 - São Paulo',
      status: TenantStatus.TRIAL,
      trialEndsAt,
      subscription: { create: { status: SubscriptionStatus.TRIAL, currentPeriodEnd: trialEndsAt } },
    },
  });
  const owner = await prisma.user.create({
    data: { tenantId: tenant.id, name: 'Dono Demo', email: 'dono@demo.com', passwordHash: hash, role: Role.OWNER },
  });
  const barber = await prisma.user.create({
    data: { tenantId: tenant.id, name: 'João Barbeiro', email: 'joao@demo.com', passwordHash: hash, role: Role.BARBER },
  });
  for (const b of [owner, barber]) {
    await prisma.workingHour.createMany({
      data: [1, 2, 3, 4, 5, 6].flatMap((weekday) => [
        { tenantId: tenant.id, barberId: b.id, weekday, startMinute: 9 * 60, endMinute: 12 * 60 },
        { tenantId: tenant.id, barberId: b.id, weekday, startMinute: 13 * 60, endMinute: 19 * 60 },
      ]),
    });
  }
  await prisma.service.createMany({
    data: [
      { tenantId: tenant.id, name: 'Corte', durationMinutes: 30, priceCents: 4000 },
      { tenantId: tenant.id, name: 'Barba', durationMinutes: 30, priceCents: 3000 },
      { tenantId: tenant.id, name: 'Corte + Barba', durationMinutes: 60, priceCents: 6500 },
      { tenantId: tenant.id, name: 'Sobrancelha', durationMinutes: 15, priceCents: 1500 },
    ],
  });
  await prisma.customer.createMany({
    data: [
      { tenantId: tenant.id, name: 'Carlos Souza', phone: '5511988887777', tags: ['vip'] },
      { tenantId: tenant.id, name: 'Pedro Lima', phone: '5511977776666', tags: ['barba'] },
    ],
  });
  console.log('Barbearia demo criada — logins: dono@demo.com / joao@demo.com (senha demo12345)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
