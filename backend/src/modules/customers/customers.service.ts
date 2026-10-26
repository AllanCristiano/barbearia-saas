import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AppointmentStatus, Customer, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { normalizePhone } from '../../common/utils/phone.util';
import { CreateCustomerDto, ListCustomersDto, UpdateCustomerDto } from './customers.dto';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, q: ListCustomersDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 30;
    const digits = q.q?.replace(/\D/g, '');
    const where: Prisma.CustomerWhereInput = {
      tenantId,
      ...(q.tag ? { tags: { has: q.tag } } : {}),
      ...(q.q
        ? {
            OR: [
              { name: { contains: q.q, mode: 'insensitive' } },
              ...(digits ? [{ phone: { contains: digits } }] : []),
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.customer.findMany({ where, orderBy: { name: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.customer.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async get(tenantId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, tenantId },
      include: {
        appointments: {
          orderBy: { startsAt: 'desc' },
          take: 20,
          include: { service: { select: { name: true } }, barber: { select: { name: true } } },
        },
      },
    });
    if (!customer) throw new NotFoundException('Cliente não encontrado');
    const done = await this.prisma.appointment.aggregate({
      where: { tenantId, customerId: id, status: AppointmentStatus.COMPLETED },
      _count: true,
      _sum: { priceCents: true },
    });
    return { ...customer, stats: { visits: done._count, totalSpentCents: done._sum.priceCents ?? 0 } };
  }

  async create(tenantId: string, dto: CreateCustomerDto): Promise<Customer> {
    const phone = this.phone(dto.phone);
    const exists = await this.prisma.customer.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
    if (exists) throw new ConflictException('Já existe um cliente com este telefone');
    return this.prisma.customer.create({ data: { ...this.data(dto), phone, tenantId } });
  }

  async update(tenantId: string, id: string, dto: UpdateCustomerDto): Promise<Customer> {
    await this.findOrThrow(tenantId, id);
    const data: Prisma.CustomerUpdateInput = { ...this.data(dto), blocked: dto.blocked };
    if (dto.phone) {
      const phone = this.phone(dto.phone);
      const owner = await this.prisma.customer.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
      if (owner && owner.id !== id) throw new ConflictException(`Esse telefone já é do cliente ${owner.name ?? 'sem nome'}`);
      data.phone = phone;
    }
    return this.prisma.customer.update({ where: { id }, data });
  }

  /** Importação em massa (ex.: planilha). Telefones existentes são atualizados. */
  async import(tenantId: string, list: CreateCustomerDto[]) {
    let created = 0;
    let updated = 0;
    const invalid: string[] = [];
    for (const dto of list) {
      let phone: string;
      try {
        phone = normalizePhone(dto.phone);
      } catch {
        invalid.push(dto.phone);
        continue;
      }
      const existing = await this.prisma.customer.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
      await this.prisma.customer.upsert({
        where: { tenantId_phone: { tenantId, phone } },
        create: { ...this.data(dto), phone, tenantId },
        update: this.data(dto),
      });
      existing ? updated++ : created++;
    }
    return { created, updated, invalid };
  }

  /** Remoção definitiva (direito de exclusão — LGPD). */
  async remove(tenantId: string, id: string): Promise<void> {
    await this.findOrThrow(tenantId, id);
    await this.prisma.customer.delete({ where: { id } });
  }

  /** Usado pelo atendimento no WhatsApp: todo número que conversa vira cliente cadastrado. */
  async findOrCreateByPhone(tenantId: string, phone: string, pushName?: string): Promise<Customer> {
    const existing = await this.prisma.customer.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
    if (existing) return existing;
    return this.prisma.customer.upsert({
      where: { tenantId_phone: { tenantId, phone } },
      create: { tenantId, phone, name: pushName?.slice(0, 100) || null },
      update: {},
    });
  }

  async setMarketingOptIn(customerId: string, optIn: boolean): Promise<void> {
    await this.prisma.customer.update({ where: { id: customerId }, data: { marketingOptIn: optIn } });
  }

  async tags(tenantId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ tag: string }[]>`
      SELECT DISTINCT unnest(tags) AS tag FROM "Customer" WHERE "tenantId" = ${tenantId} ORDER BY tag`;
    return rows.map((r) => r.tag);
  }

  private data(dto: Partial<CreateCustomerDto>) {
    return {
      name: dto.name,
      email: dto.email,
      birthDate: dto.birthDate ? new Date(dto.birthDate) : undefined,
      notes: dto.notes,
      tags: dto.tags?.map((t) => t.trim().toLowerCase()).filter(Boolean),
      marketingOptIn: dto.marketingOptIn,
    };
  }

  private phone(raw: string): string {
    try {
      return normalizePhone(raw);
    } catch {
      throw new BadRequestException('Telefone inválido');
    }
  }

  private async findOrThrow(tenantId: string, id: string) {
    const c = await this.prisma.customer.findFirst({ where: { id, tenantId } });
    if (!c) throw new NotFoundException('Cliente não encontrado');
    return c;
  }
}
