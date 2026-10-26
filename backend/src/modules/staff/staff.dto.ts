import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Role } from '@prisma/client';

export class CreateBarberDto {
  @ApiProperty() @IsString() @MinLength(2) name: string;
  @ApiProperty() @IsEmail() email: string;
  @ApiProperty({ minLength: 8 }) @IsString() @MinLength(8) password: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional({ enum: [Role.BARBER, Role.OWNER], default: Role.BARBER })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}

export class UpdateBarberDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(8) password?: string;
}

export class WorkingHourDto {
  @ApiProperty({ description: '0 = domingo ... 6 = sábado' }) @IsInt() @Min(0) @Max(6) weekday: number;
  @ApiProperty({ example: '09:00' }) @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) start: string;
  @ApiProperty({ example: '19:00' }) @Matches(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/) end: string;
}

export class SetWorkingHoursDto {
  @ApiProperty({ type: [WorkingHourDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WorkingHourDto)
  hours: WorkingHourDto[];
}

export class PushTokenDto {
  @ApiProperty({ example: 'ExponentPushToken[xxxx]' }) @IsString() token: string;
}
