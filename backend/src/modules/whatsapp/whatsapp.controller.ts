import { Body, Controller, Delete, Get, HttpCode, Post, UseFilters } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Role } from '@prisma/client';
import { CurrentTenant, Roles } from '../../common/auth/decorators';
import { TenantUser } from '../../common/auth/auth-user';
import { EvolutionErrorFilter } from './evolution-error.filter';
import { WhatsappInstanceService } from './whatsapp-instance.service';

class PairDto {
  @ApiPropertyOptional({ example: '(11) 98765-4321', description: 'Número do WhatsApp da barbearia (padrão: telefone do cadastro)' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}

/** Endpoints que o dono da barbearia usa para conectar o WhatsApp (sem saber do Evolution). */
@ApiTags('WhatsApp')
@ApiBearerAuth()
@Roles(Role.OWNER)
@UseFilters(EvolutionErrorFilter)
@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly instances: WhatsappInstanceService) {}

  @Get('status')
  @ApiOperation({ summary: 'Status da conexão do WhatsApp da barbearia' })
  status(@CurrentTenant() user: TenantUser) {
    return this.instances.refreshStatus(user.tenantId);
  }

  @Post('connect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Inicia o pareamento e retorna o QR Code' })
  connect(@CurrentTenant() user: TenantUser) {
    return this.instances.connect(user.tenantId);
  }

  @Post('pair')
  @HttpCode(200)
  @ApiOperation({ summary: 'Gera código de pareamento para conectar pelo próprio celular (sem QR)' })
  pair(@CurrentTenant() user: TenantUser, @Body() dto: PairDto) {
    return this.instances.pairWithPhone(user.tenantId, dto.phone);
  }

  @Get('qr')
  @ApiOperation({ summary: 'QR Code atual (o QR expira e é renovado a cada ~20s)' })
  qr(@CurrentTenant() user: TenantUser) {
    return this.instances.getQr(user.tenantId);
  }

  @Delete('session')
  @HttpCode(204)
  @ApiOperation({ summary: 'Desconecta o número de WhatsApp' })
  async logout(@CurrentTenant() user: TenantUser): Promise<void> {
    await this.instances.logout(user.tenantId);
  }
}
