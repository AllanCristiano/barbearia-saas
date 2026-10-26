import { Body, Controller, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { PaymentMethod, Role, SubscriptionStatus, TenantStatus } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { addDays } from 'date-fns';
import { Roles } from '../../common/auth/decorators';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BillingModule } from '../billing/billing.module';
import { BillingService } from '../billing/billing.service';
import { WhatsappInstanceService } from '../whatsapp/whatsapp-instance.service';
import { WhatsappModule } from '../whatsapp/whatsapp.module';

class SetStatusDto {
  @ApiProperty({ enum: TenantStatus }) @IsEnum(TenantStatus) status: TenantStatus;
}

class RecordPaymentDto {
  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.PIX }) @IsEnum(PaymentMethod) method: PaymentMethod;
  @ApiProperty({ required: false, default: 1, description: 'Meses pagos' }) @IsOptional() @IsInt() @Min(1) @Max(24) months?: number;
  @ApiProperty({ required: false, description: 'Valor em centavos (padrão: mensalidade × meses)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  amountCents?: number;
  @ApiProperty({ required: false, example: 'PIX recebido em 24/10' }) @IsOptional() @IsString() @MaxLength(300) notes?: string;
}

class ExtendDto {
  @ApiProperty({ example: 30 }) @IsInt() @Min(1) @Max(365) days: number;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappInstanceService,
    private readonly billing: BillingService,
  ) {}

  async recordPayment(tenantId: string, dto: RecordPaymentDto) {
    await this.ensure(tenantId);
    return this.billing.recordPayment(tenantId, dto);
  }

  payments(tenantId: string) {
    return this.prisma.payment.findMany({ where: { tenantId }, orderBy: { paidAt: 'desc' } });
  }

  tenants() {
    return this.prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        subscription: { select: { status: true, currentPeriodEnd: true, amountCents: true } },
        instance: { select: { status: true, lastError: true, lastCheckedAt: true, failedChecks: true } },
        _count: { select: { customers: true, appointments: true, users: true } },
      },
    });
  }

  async metrics() {
    const [byStatus, instances, approved] = await Promise.all([
      this.prisma.tenant.groupBy({ by: ['status'], _count: true }),
      this.prisma.whatsappInstance.groupBy({ by: ['status'], _count: true }),
      this.prisma.payment.aggregate({
        where: { paidAt: { gte: addDays(new Date(), -30) } },
        _sum: { amountCents: true },
        _count: true,
      }),
    ]);
    return {
      tenantsByStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
      instancesByStatus: Object.fromEntries(instances.map((s) => [s.status, s._count])),
      revenueLast30DaysCents: approved._sum.amountCents ?? 0,
      paymentsLast30Days: approved._count,
    };
  }

  async setStatus(tenantId: string, status: TenantStatus) {
    await this.ensure(tenantId);
    return this.prisma.tenant.update({ where: { id: tenantId }, data: { status } });
  }

  /** Cortesia/ajuste manual: estende o período pago. */
  async extend(tenantId: string, days: number) {
    await this.ensure(tenantId);
    const sub = await this.prisma.subscription.findUniqueOrThrow({ where: { tenantId } });
    const base = sub.currentPeriodEnd && sub.currentPeriodEnd > new Date() ? sub.currentPeriodEnd : new Date();
    await this.prisma.$transaction([
      this.prisma.subscription.update({
        where: { id: sub.id },
        data: { currentPeriodEnd: addDays(base, days), status: SubscriptionStatus.ACTIVE },
      }),
      this.prisma.tenant.update({ where: { id: tenantId }, data: { status: TenantStatus.ACTIVE } }),
    ]);
    return this.prisma.subscription.findUnique({ where: { tenantId } });
  }

  private async ensure(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!t) throw new NotFoundException('Barbearia não encontrada');
    return t;
  }

  runWhatsappMaintenance() {
    return this.whatsapp.runMaintenance();
  }

  async whatsappStatus(tenantId: string) {
    return this.whatsapp.refreshStatus(tenantId);
  }

  async provisionInstance(tenantId: string) {
    const t = await this.ensure(tenantId);
    return this.whatsapp.ensureInstance(t.id, t.slug).then((i) => ({ status: i.status, lastError: i.lastError }));
  }
}

/** Painel do dono da plataforma (SUPER_ADMIN). */
@ApiTags('Admin da plataforma')
@ApiBearerAuth()
@Roles(Role.SUPER_ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('tenants')
  tenants() {
    return this.admin.tenants();
  }

  @Get('metrics')
  metrics() {
    return this.admin.metrics();
  }

  @Post('tenants/:id/status')
  @HttpCode(200)
  setStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetStatusDto) {
    return this.admin.setStatus(id, dto.status);
  }

  @Post('tenants/:id/payments')
  @HttpCode(200)
  @ApiOperation({ summary: 'Registra pagamento recebido (PIX/cartão/dinheiro) e estende a assinatura' })
  recordPayment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordPaymentDto) {
    return this.admin.recordPayment(id, dto);
  }

  @Get('tenants/:id/payments')
  payments(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.payments(id);
  }

  @Post('tenants/:id/extend')
  @HttpCode(200)
  @ApiOperation({ summary: 'Estende a assinatura manualmente (cortesia)' })
  extend(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ExtendDto) {
    return this.admin.extend(id, dto.days);
  }

  @Get('tenants/:id/whatsapp')
  whatsapp(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.whatsappStatus(id);
  }

  @Post('tenants/:id/whatsapp/provision')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cria a instância caso não exista' })
  provision(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.provisionInstance(id);
  }

  @Post('whatsapp/maintenance')
  @HttpCode(200)
  @ApiOperation({ summary: 'Executa agora a manutenção de todas as instâncias' })
  maintenance() {
    return this.admin.runWhatsappMaintenance();
  }
}

@Module({
  imports: [WhatsappModule, BillingModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
