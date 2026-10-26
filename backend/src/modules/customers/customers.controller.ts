import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { TenantUser } from '../../common/auth/auth-user';
import { CurrentTenant, Roles } from '../../common/auth/decorators';
import { CreateCustomerDto, ImportCustomersDto, ListCustomersDto, UpdateCustomerDto } from './customers.dto';
import { CustomersService } from './customers.service';

@ApiTags('Clientes')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  list(@CurrentTenant() user: TenantUser, @Query() q: ListCustomersDto) {
    return this.customers.list(user.tenantId, q);
  }

  @Get('tags')
  tags(@CurrentTenant() user: TenantUser) {
    return this.customers.tags(user.tenantId);
  }

  @Get(':id')
  get(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.get(user.tenantId, id);
  }

  @Post()
  @ApiOperation({ summary: 'Cadastra cliente (para agendamentos e campanhas)' })
  create(@CurrentTenant() user: TenantUser, @Body() dto: CreateCustomerDto) {
    return this.customers.create(user.tenantId, dto);
  }

  @Roles(Role.OWNER)
  @Post('import')
  @ApiOperation({ summary: 'Importação em massa de clientes' })
  import(@CurrentTenant() user: TenantUser, @Body() dto: ImportCustomersDto) {
    return this.customers.import(user.tenantId, dto.customers);
  }

  @Patch(':id')
  update(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(user.tenantId, id, dto);
  }

  @Roles(Role.OWNER)
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Exclui definitivamente o cliente e seu histórico (LGPD)' })
  async remove(@CurrentTenant() user: TenantUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.customers.remove(user.tenantId, id);
  }
}
