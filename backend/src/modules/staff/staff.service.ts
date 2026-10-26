import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { TenantUser } from '../../common/auth/auth-user';
import { PrismaService } from '../../common/prisma/prisma.service';
import { normalizePhone } from '../../common/utils/phone.util';
import { AuthService } from '../auth/auth.service';
import { formatHHMM, parseHHMM } from '../scheduling/availability';
import { CreateBarberDto, UpdateBarberDto, WorkingHourDto } from './staff.dto';

const PUBLIC_FIELDS = { id: true, name: true, email: true, phone: true, role: true, active: true, createdAt: true } as const;

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  list(tenantId: string) {
    return this.prisma.user.findMany({
      where: { tenantId },
      select: { ...PUBLIC_FIELDS, workingHours: { orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }] } },
      orderBy: { name: 'asc' },
    });
  }

  async create(tenantId: string, dto: CreateBarberDto) {
    const email = dto.email.toLowerCase().trim();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('E-mail já cadastrado');
    if (dto.role === Role.SUPER_ADMIN) throw new ForbiddenException();
    return this.prisma.user.create({
      data: {
        tenantId,
        name: dto.name,
        email,
        phone: dto.phone ? normalizePhone(dto.phone) : null,
        role: dto.role ?? Role.BARBER,
        passwordHash: await AuthService.hashPassword(dto.password),
      },
      select: PUBLIC_FIELDS,
    });
  }

  async update(tenantId: string, id: string, dto: UpdateBarberDto) {
    await this.findOrThrow(tenantId, id);
    return this.prisma.user.update({
      where: { id },
      data: {
        name: dto.name,
        phone: dto.phone ? normalizePhone(dto.phone) : undefined,
        active: dto.active,
        passwordHash: dto.password ? await AuthService.hashPassword(dto.password) : undefined,
        // Desativar derruba a sessão do app.
        refreshHash: dto.active === false ? null : undefined,
      },
      select: PUBLIC_FIELDS,
    });
  }

  async getWorkingHours(tenantId: string, barberId: string) {
    await this.findOrThrow(tenantId, barberId);
    const hours = await this.prisma.workingHour.findMany({
      where: { tenantId, barberId },
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
    });
    return hours.map((h) => ({ weekday: h.weekday, start: formatHHMM(h.startMinute), end: formatHHMM(h.endMinute) }));
  }

  /** Substitui toda a grade semanal do barbeiro. */
  async setWorkingHours(tenantId: string, user: TenantUser, barberId: string, hours: WorkingHourDto[]) {
    if (user.role === Role.BARBER && user.sub !== barberId) throw new ForbiddenException();
    await this.findOrThrow(tenantId, barberId);

    const parsed = hours.map((h) => ({
      weekday: h.weekday,
      startMinute: parseHHMM(h.start),
      endMinute: h.end === '24:00' ? 1440 : parseHHMM(h.end),
    }));
    for (const h of parsed) {
      if (h.endMinute <= h.startMinute) throw new BadRequestException('Fim deve ser depois do início');
    }
    for (const a of parsed) {
      const clash = parsed.some((b) => a !== b && a.weekday === b.weekday && a.startMinute < b.endMinute && b.startMinute < a.endMinute);
      if (clash) throw new BadRequestException('Há períodos sobrepostos no mesmo dia');
    }

    await this.prisma.$transaction([
      this.prisma.workingHour.deleteMany({ where: { tenantId, barberId } }),
      this.prisma.workingHour.createMany({ data: parsed.map((h) => ({ ...h, tenantId, barberId })) }),
    ]);
    return this.getWorkingHours(tenantId, barberId);
  }

  async listTimeOff(tenantId: string, barberId: string) {
    return this.prisma.timeOff.findMany({
      where: { tenantId, barberId, endsAt: { gte: new Date() } },
      orderBy: { startsAt: 'asc' },
    });
  }

  async removeTimeOff(tenantId: string, user: TenantUser, id: string) {
    const timeOff = await this.prisma.timeOff.findFirst({ where: { id, tenantId } });
    if (!timeOff) throw new NotFoundException();
    if (user.role === Role.BARBER && timeOff.barberId !== user.sub) throw new ForbiddenException();
    await this.prisma.timeOff.delete({ where: { id } });
  }

  async setPushToken(userId: string, token: string) {
    // Um aparelho pertence a um único usuário: limpa o token de outras contas.
    await this.prisma.user.updateMany({ where: { pushToken: token, id: { not: userId } }, data: { pushToken: null } });
    await this.prisma.user.update({ where: { id: userId }, data: { pushToken: token } });
  }

  private async findOrThrow(tenantId: string, id: string) {
    const user = await this.prisma.user.findFirst({ where: { id, tenantId } });
    if (!user) throw new NotFoundException('Barbeiro não encontrado');
    return user;
  }
}
