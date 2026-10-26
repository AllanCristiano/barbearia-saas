import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { TenantUser } from '../../common/auth/auth-user';
import { CurrentTenant, Roles } from '../../common/auth/decorators';
import { CreateCampaignDto, UpdateCampaignDto } from './campaigns.dto';
import { CampaignsService } from './campaigns.service';

@ApiTags('Campanhas')
@ApiBearerAuth()
@Roles(Role.OWNER)
@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  list(@CurrentTenant() user: TenantUser) {
    return this.campaigns.list(user.tenantId);
  }

  @Get('audience')
  @ApiOperation({ summary: 'Prévia de quantos clientes receberão (tags separadas por vírgula)' })
  async audience(@CurrentTenant() user: TenantUser, @Query('tags') tags?: string) {
    const list = tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
    return { count: await this.campaigns.audienceSize(user.tenantId, list) };
  }

  @Get(':id')
  get(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.get(user.tenantId, id);
  }

  @Post()
  create(@CurrentTenant() user: TenantUser, @Body() dto: CreateCampaignDto) {
    return this.campaigns.create(user.tenantId, dto);
  }

  @Patch(':id')
  update(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCampaignDto) {
    return this.campaigns.update(user.tenantId, id, dto);
  }

  @Post(':id/send')
  @HttpCode(200)
  @ApiOperation({ summary: 'Dispara a campanha agora' })
  send(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.send(user.tenantId, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.campaigns.cancel(user.tenantId, id);
  }
}
