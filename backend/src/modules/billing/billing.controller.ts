import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { TenantUser } from '../../common/auth/auth-user';
import { CurrentTenant, Roles, SkipSubscriptionCheck } from '../../common/auth/decorators';
import { BillingService } from './billing.service';

@ApiTags('Assinatura')
@ApiBearerAuth()
@Roles(Role.OWNER)
@SkipSubscriptionCheck()
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @ApiOperation({ summary: 'Status da assinatura, como pagar e histórico de pagamentos' })
  status(@CurrentTenant() user: TenantUser) {
    return this.billing.getStatus(user.tenantId);
  }
}
