import { ConflictException } from '@nestjs/common';
import { createPrismaMock, PrismaMock } from '../../testing/prisma-mock';
import { CustomersService } from './customers.service';

describe('CustomersService (edição)', () => {
  let prisma: PrismaMock;
  let service: CustomersService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.customer.findFirst.mockResolvedValue({ id: 'c1', tenantId: 't1', name: 'Carlos' });
    prisma.customer.update.mockImplementation(async ({ data }: any) => ({ id: 'c1', ...data }));
    service = new CustomersService(prisma as any);
  });

  it('edita nome, tags (normalizadas) e opt-in', async () => {
    await service.update('t1', 'c1', { name: 'Carlos Souza', tags: [' VIP ', 'barba'], marketingOptIn: false });
    expect(prisma.customer.update.mock.calls[0][0].data).toMatchObject({ name: 'Carlos Souza', tags: ['vip', 'barba'], marketingOptIn: false });
  });

  it('troca de telefone normaliza o número', async () => {
    prisma.customer.findUnique.mockResolvedValue(null);
    await service.update('t1', 'c1', { phone: '(11) 97777-6666' });
    expect(prisma.customer.update.mock.calls[0][0].data.phone).toBe('5511977776666');
  });

  it('telefone de outro cliente → 409 com mensagem clara (antes era erro 500)', async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: 'c2', name: 'Pedro' });
    const err = await service.update('t1', 'c1', { phone: '11977776666' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toContain('Pedro');
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });

  it('manter o próprio telefone não é conflito', async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: 'c1', name: 'Carlos' });
    await expect(service.update('t1', 'c1', { phone: '11988887777' })).resolves.toBeTruthy();
  });

  it('bloquear cliente', async () => {
    await service.update('t1', 'c1', { blocked: true });
    expect(prisma.customer.update.mock.calls[0][0].data.blocked).toBe(true);
  });

  it('detalhe traz histórico e estatísticas (visitas e total gasto)', async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: 'c1', name: 'Carlos', appointments: [] });
    prisma.appointment.aggregate.mockResolvedValue({ _count: 4, _sum: { priceCents: 18000 } });
    const c = await service.get('t1', 'c1');
    expect(c.stats).toEqual({ visits: 4, totalSpentCents: 18000 });
    expect(prisma.appointment.aggregate.mock.calls[0][0].where).toMatchObject({ tenantId: 't1', customerId: 'c1', status: 'COMPLETED' });
  });

  it('cliente de outra barbearia não é encontrado', async () => {
    prisma.customer.findFirst.mockResolvedValue(null);
    await expect(service.update('t2', 'c1', { name: 'x' })).rejects.toThrow('não encontrado');
  });
});
