import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { AuthUser, TenantUser } from '../../common/auth/auth-user';
import { CurrentTenant, CurrentUser, Roles, SkipSubscriptionCheck } from '../../common/auth/decorators';
import { CreateBarberDto, PushTokenDto, SetWorkingHoursDto, UpdateBarberDto } from './staff.dto';
import { Push } from '../notifications/push-messages';
import { PushService } from '../notifications/push.service';
import { StaffService } from './staff.service';

@ApiTags('Equipe')
@ApiBearerAuth()
@Controller('staff')
export class StaffController {
  constructor(
    private readonly staff: StaffService,
    private readonly push: PushService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Lista barbeiros e donos com a grade de horários' })
  list(@CurrentTenant() user: TenantUser) {
    return this.staff.list(user.tenantId);
  }

  @Roles(Role.OWNER)
  @Post()
  create(@CurrentTenant() user: TenantUser, @Body() dto: CreateBarberDto) {
    return this.staff.create(user.tenantId, dto);
  }

  @Roles(Role.OWNER)
  @Patch(':id')
  update(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBarberDto) {
    return this.staff.update(user.tenantId, id, dto);
  }

  @Get(':id/working-hours')
  hours(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.getWorkingHours(user.tenantId, id);
  }

  @Put(':id/working-hours')
  @ApiOperation({ summary: 'Define a grade semanal (substitui a atual)' })
  setHours(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetWorkingHoursDto) {
    return this.staff.setWorkingHours(user.tenantId, user, id, dto.hours);
  }

  @Get(':id/time-off')
  timeOff(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.listTimeOff(user.tenantId, id);
  }

  @Delete('time-off/:id')
  @HttpCode(204)
  async removeTimeOff(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.staff.removeTimeOff(user.tenantId, user, id);
  }

  @SkipSubscriptionCheck()
  @Post('me/push-test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Envia uma notificação de teste para o próprio aparelho' })
  async pushTest(@CurrentUser() user: AuthUser): Promise<{ sent: number }> {
    return { sent: await this.push.notifyUser(user.sub, Push.test()) };
  }

  @SkipSubscriptionCheck()
  @Post('me/push-token')
  @HttpCode(204)
  @ApiOperation({ summary: 'Registra o token de push (Expo) do aparelho' })
  async pushToken(@CurrentUser() user: AuthUser, @Body() dto: PushTokenDto): Promise<void> {
    await this.staff.setPushToken(user.sub, dto.token);
  }
}
