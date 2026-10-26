import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsDateString, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class CreateCampaignDto {
  @ApiProperty({ example: 'Promoção de novembro' }) @IsString() @MinLength(2) @MaxLength(100) title: string;

  @ApiProperty({ example: 'Fala {nome}! Corte + barba por R$ 50 até sexta. Agende por aqui mesmo 💈' })
  @IsString()
  @MinLength(5)
  @MaxLength(1500)
  message: string;

  @ApiPropertyOptional({ description: 'Somente clientes com estas tags (vazio = todos com opt-in)' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  tags?: string[];

  @ApiPropertyOptional({ description: 'Agendar envio (ISO). Vazio = rascunho' })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}

export class UpdateCampaignDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1500) message?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  scheduledAt?: string | null;
}
