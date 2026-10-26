import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Role, SubscriptionStatus, TenantStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { randomToken } from '../../common/utils/crypto.util';
import { normalizePhone } from '../../common/utils/phone.util';
import { AuthService } from '../auth/auth.service';
import { DEFAULT_MENU_PROMPT, resolveMenu } from '../bot/menu-config';
import { WhatsappInstanceService } from '../whatsapp/whatsapp-instance.service';
import { SignupDto, UpdateTenantDto } from './tenants.dto';

/** Horário padrão do dono-barbeiro: segunda a sábado, 09:00–19:00. */
const DEFAULT_HOURS = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 19 * 60 }));

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly whatsapp: WhatsappInstanceService,
    private readonly config: ConfigService,
  ) {}

  /** Cadastro de uma nova barbearia: tenant + dono + assinatura em teste + instância de WhatsApp. */
  async signup(dto: SignupDto) {
    const email = dto.email.toLowerCase().trim();
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('Já existe uma conta com este e-mail');
    }
    let phone: string;
    try {
      phone = normalizePhone(dto.phone);
    } catch {
      throw new BadRequestException('Telefone inválido');
    }

    let slug = slugify(dto.shopName) || 'barbearia';
    if (await this.prisma.tenant.findUnique({ where: { slug } })) slug = `${slug}-${randomToken(2)}`;

    const trialDays = Number(this.config.get('TRIAL_DAYS', 7));
    const trialEndsAt = new Date(Date.now() + trialDays * 86_400_000);
    const passwordHash = await AuthService.hashPassword(dto.password);

    const tenant = await this.prisma.$transaction(async (tx) => {
      const t = await tx.tenant.create({
        data: { name: dto.shopName, slug, phone, status: TenantStatus.TRIAL, trialEndsAt },
      });
      const owner = await tx.user.create({
        data: { tenantId: t.id, name: dto.ownerName, email, phone, passwordHash, role: Role.OWNER },
      });
      if (dto.ownerIsBarber !== false) {
        await tx.workingHour.createMany({
          data: DEFAULT_HOURS.map((h) => ({ ...h, tenantId: t.id, barberId: owner.id })),
        });
      }
      await tx.subscription.create({
        data: {
          tenantId: t.id,
          status: SubscriptionStatus.TRIAL,
          amountCents: Number(this.config.get('PLATFORM_PRICE_CENTS', 20000)),
          currentPeriodEnd: trialEndsAt,
        },
      });
      return t;
    });

    // Fora da transação: falha no Evolution não impede o cadastro (o cron recria).
    await this.whatsapp.ensureInstance(tenant.id, tenant.slug).catch((err) => {
      this.logger.error(`Instância não criada para ${tenant.slug}: ${err.message}`);
    });

    const session = await this.auth.login(email, dto.password);
    return { tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, trialEndsAt }, ...session };
  }

  async get(tenantId: string) {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      include: { subscription: { select: { status: true, currentPeriodEnd: true, amountCents: true } } },
    });
    // Sempre devolve o menu efetivo (padrão quando a barbearia nunca personalizou).
    return {
      ...tenant,
      botMenu: resolveMenu(tenant.botMenu),
      menuPrompt: tenant.menuPrompt ?? DEFAULT_MENU_PROMPT,
    };
  }

  async update(tenantId: string, dto: UpdateTenantDto) {
    const { botMenu, ...rest } = dto;
    const data: Prisma.TenantUpdateInput = { ...rest };
    // null = voltar a seguir o padrão (assim melhorias nos textos padrão chegam à barbearia).
    if (botMenu === null) data.botMenu = Prisma.DbNull;
    if (botMenu) {
      const menu = resolveMenu(botMenu);
      if (!menu.some((o) => o.enabled)) throw new BadRequestException('Deixe pelo menos uma opção ativa no menu');
      data.botMenu = menu as unknown as Prisma.InputJsonValue;
    }
    if (dto.phone) {
      try {
        data.phone = normalizePhone(dto.phone);
      } catch {
        throw new BadRequestException('Telefone inválido');
      }
    }
    if (dto.timezone) {
      try {
        new Intl.DateTimeFormat('pt-BR', { timeZone: dto.timezone });
      } catch {
        throw new BadRequestException('Fuso horário inválido');
      }
    }
    await this.prisma.tenant.update({ where: { id: tenantId }, data });
    return this.get(tenantId);
  }
}
