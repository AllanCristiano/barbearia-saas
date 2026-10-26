import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MAX_LABEL_LENGTH, MENU_KEYS, MenuKey } from '../bot/menu-config';

export class SignupDto {
  @ApiProperty({ example: 'Barbearia do Zé' }) @IsString() @MinLength(2) @MaxLength(80) shopName: string;
  @ApiProperty({ example: 'José da Silva' }) @IsString() @MinLength(2) ownerName: string;
  @ApiProperty({ example: 'ze@barbearia.com' }) @IsEmail() email: string;
  @ApiProperty({ minLength: 8 }) @IsString() @MinLength(8) password: string;
  @ApiProperty({ example: '11987654321' }) @IsString() phone: string;
  @ApiPropertyOptional({ default: true, description: 'O dono também atende como barbeiro' })
  @IsOptional()
  @IsBoolean()
  ownerIsBarber?: boolean;
}

export class MenuOptionDto {
  @ApiProperty({ enum: MENU_KEYS }) @IsIn(MENU_KEYS as unknown as string[]) key: MenuKey;
  @ApiProperty({ example: 'Marcar meu corte' }) @IsString() @MinLength(2) @MaxLength(MAX_LABEL_LENGTH) label: string;
  @ApiProperty() @IsBoolean() enabled: boolean;
}

export class UpdateTenantDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) address?: string;
  @ApiPropertyOptional({ example: 'America/Sao_Paulo' }) @IsOptional() @IsString() timezone?: string;
  @ApiPropertyOptional({ description: 'Atendimento automático (menu) no WhatsApp' }) @IsOptional() @IsBoolean() botEnabled?: boolean;
  @ApiPropertyOptional({ description: 'Saudação exibida antes do menu do WhatsApp' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  welcomeMessage?: string | null;
  @ApiPropertyOptional({ description: 'Texto acima das opções do menu' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  menuPrompt?: string | null;
  @ApiPropertyOptional({ type: [MenuOptionDto], description: 'Opções do menu na ordem exibida' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => MenuOptionDto)
  botMenu?: MenuOptionDto[] | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(120) bookingWindowDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(72) minCancelHours?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(48) reminderHoursBefore?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(5) @Max(60) slotStepMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(5) @Max(120) offerTimeoutMinutes?: number;
}
