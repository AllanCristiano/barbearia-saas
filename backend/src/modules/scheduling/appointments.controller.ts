import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TenantUser } from '../../common/auth/auth-user';
import { CurrentTenant } from '../../common/auth/decorators';
import { AppointmentsService } from './appointments.service';
import { AvailabilityService } from './availability.service';
import {
  AvailabilityQueryDto,
  CancelDto,
  CreateAppointmentDto,
  DayQueryDto,
  RescheduleDto,
  UnavailableDto,
  UpdateStatusDto,
} from './dto';

@ApiTags('Agendamentos')
@ApiBearerAuth()
@Controller()
export class AppointmentsController {
  constructor(
    private readonly appointments: AppointmentsService,
    private readonly availability: AvailabilityService,
  ) {}

  @Get('availability')
  @ApiOperation({ summary: 'Horários livres de um serviço em uma data' })
  slots(@CurrentTenant() user: TenantUser, @Query() q: AvailabilityQueryDto) {
    return this.availability.getSlots(user.tenantId, q);
  }

  @Get('appointments')
  @ApiOperation({ summary: 'Agenda do dia (barbeiro vê apenas a própria)' })
  list(@CurrentTenant() user: TenantUser, @Query() q: DayQueryDto) {
    return this.appointments.listDay(user.tenantId, user, q.date, q.barberId);
  }

  @Get('appointments/summary')
  @ApiOperation({ summary: 'Fluxo do dia: totais por status, faturamento e próximo cliente' })
  summary(@CurrentTenant() user: TenantUser, @Query() q: DayQueryDto) {
    return this.appointments.daySummary(user.tenantId, user, q.date, q.barberId);
  }

  @Get('appointments/:id')
  get(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.getForStaff(user.tenantId, user, id);
  }

  @Post('appointments')
  @ApiOperation({ summary: 'Cria agendamento pelo app (cliente recebe confirmação no WhatsApp)' })
  create(@CurrentTenant() user: TenantUser, @Body() dto: CreateAppointmentDto) {
    return this.appointments.create(
      user.tenantId,
      { ...dto, startsAt: new Date(dto.startsAt) },
      { kind: 'staff', user },
    );
  }

  @Patch('appointments/:id/status')
  @ApiOperation({ summary: 'Confirmar, iniciar, concluir ou marcar falta' })
  status(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStatusDto) {
    return this.appointments.updateStatus(user.tenantId, user, id, dto.status);
  }

  @Post('appointments/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancela; avisa o cliente e oferece o horário ao próximo da fila' })
  cancel(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto) {
    return this.appointments.cancel(user.tenantId, id, { kind: 'staff', user }, dto.reason);
  }

  @Post('appointments/:id/reschedule')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remarca para outro horário/barbeiro e avisa o cliente' })
  reschedule(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RescheduleDto) {
    return this.appointments.reschedule(
      user.tenantId,
      id,
      { startsAt: new Date(dto.startsAt), barberId: dto.barberId },
      { kind: 'staff', user },
    );
  }

  @Post('barbers/unavailable')
  @HttpCode(200)
  @ApiOperation({ summary: 'Barbeiro não poderá atender: bloqueia agenda e envia opções de remarcação aos clientes' })
  unavailable(@CurrentTenant() user: TenantUser, @Body() dto: UnavailableDto) {
    return this.appointments.markUnavailable(user.tenantId, user, dto);
  }
}
