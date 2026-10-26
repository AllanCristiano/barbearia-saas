import { Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { TenantUser } from '../../common/auth/auth-user';
import { CurrentTenant, Roles } from '../../common/auth/decorators';
import { PrismaService } from '../../common/prisma/prisma.service';

export class CreateServiceDto {
  @ApiProperty({ example: 'Corte + Barba' }) @IsString() @MinLength(2) @MaxLength(80) name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) description?: string;
  @ApiProperty({ example: 45 }) @IsInt() @Min(5) @Max(480) durationMinutes: number;
  @ApiProperty({ example: 6000, description: 'Preço em centavos' }) @IsInt() @Min(0) priceCents: number;
}

export class UpdateServiceDto extends PartialType(CreateServiceDto) {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
}

/** Catálogo de serviços (corte, barba, sobrancelha...). */
@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  list(tenantId: string, includeInactive = false) {
    return this.prisma.service.findMany({
      where: { tenantId, ...(includeInactive ? {} : { active: true }) },
      orderBy: { name: 'asc' },
    });
  }

  create(tenantId: string, dto: CreateServiceDto) {
    return this.prisma.service.create({ data: { ...dto, tenantId } });
  }

  async update(tenantId: string, id: string, dto: UpdateServiceDto) {
    const found = await this.prisma.service.findFirst({ where: { id, tenantId } });
    if (!found) throw new NotFoundException('Serviço não encontrado');
    // Serviços nunca são apagados (histórico de agendamentos); apenas desativados.
    return this.prisma.service.update({ where: { id }, data: dto });
  }
}

@ApiTags('Serviços')
@ApiBearerAuth()
@Controller('services')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list(@CurrentTenant() user: TenantUser, @Query('all') all?: string) {
    return this.catalog.list(user.tenantId, all === 'true');
  }

  @Roles(Role.OWNER)
  @Post()
  create(@CurrentTenant() user: TenantUser, @Body() dto: CreateServiceDto) {
    return this.catalog.create(user.tenantId, dto);
  }

  @Roles(Role.OWNER)
  @Patch(':id')
  update(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateServiceDto) {
    return this.catalog.update(user.tenantId, id, dto);
  }
}

@Module({
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
