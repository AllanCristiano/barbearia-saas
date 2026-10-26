import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { TenantUser } from '../../common/auth/auth-user';
import { CurrentTenant, Public, Roles, SkipSubscriptionCheck } from '../../common/auth/decorators';
import { SignupDto, UpdateTenantDto } from './tenants.dto';
import { TenantsService } from './tenants.service';

@ApiTags('Barbearia')
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('signup')
  @ApiOperation({ summary: 'Cadastra uma nova barbearia (inicia período de teste)' })
  signup(@Body() dto: SignupDto) {
    return this.tenants.signup(dto);
  }

  @ApiBearerAuth()
  @SkipSubscriptionCheck()
  @Get('me')
  get(@CurrentTenant() user: TenantUser) {
    return this.tenants.get(user.tenantId);
  }

  @ApiBearerAuth()
  @Roles(Role.OWNER)
  @Patch('me')
  @ApiOperation({ summary: 'Atualiza dados e regras da barbearia' })
  update(@CurrentTenant() user: TenantUser, @Body() dto: UpdateTenantDto) {
    return this.tenants.update(user.tenantId, dto);
  }
}
