import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AppointmentStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export class DayQueryDto {
  @ApiProperty({ example: '2026-10-24' })
  @Matches(DATE, { message: 'date deve ser YYYY-MM-DD' })
  date: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  barberId?: string;
}

export class AvailabilityQueryDto extends DayQueryDto {
  @ApiProperty()
  @IsUUID()
  serviceId: string;

  @ApiPropertyOptional({ description: 'Ao remarcar: ignora o horário do próprio agendamento' })
  @IsOptional()
  @IsUUID()
  excludeAppointmentId?: string;
}

export class CreateAppointmentDto {
  @ApiProperty() @IsUUID() customerId: string;
  @ApiProperty() @IsUUID() serviceId: string;
  @ApiProperty() @IsUUID() barberId: string;
  @ApiProperty({ example: '2026-10-24T17:30:00.000Z' }) @IsDateString() startsAt: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class UpdateStatusDto {
  @ApiProperty({ enum: AppointmentStatus })
  @IsEnum(AppointmentStatus)
  status: AppointmentStatus;
}

export class CancelDto {
  @ApiPropertyOptional({ example: 'Barbeiro passou mal' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class RescheduleDto {
  @ApiProperty() @IsDateString() startsAt: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() barberId?: string;
}

export class UnavailableDto {
  @ApiProperty({ example: '2026-10-25' })
  @Matches(DATE)
  date: string;

  @ApiPropertyOptional({ description: 'Somente donos podem marcar para outro barbeiro' })
  @IsOptional()
  @IsUUID()
  barberId?: string;

  @ApiPropertyOptional({ example: '13:00', description: 'Omitir para o dia todo' })
  @IsOptional()
  @Matches(TIME)
  startTime?: string;

  @ApiPropertyOptional({ example: '19:00' })
  @IsOptional()
  @Matches(TIME)
  endTime?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) reason?: string;
}
