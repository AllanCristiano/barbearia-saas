import { Prisma } from '@prisma/client';
import { createPrismaMock, fakeConfig, PrismaMock } from '../../testing/prisma-mock';
import { DEFAULT_MENU, DEFAULT_MENU_PROMPT } from '../bot/menu-config';
import { TenantsService } from './tenants.service';

describe('TenantsService (personalização)', () => {
  let prisma: PrismaMock;
  let service: TenantsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.tenant.findUniqueOrThrow.mockResolvedValue({ id: 't1', name: 'Demo', botMenu: null, menuPrompt: null });
    service = new TenantsService(prisma as any, {} as any, {} as any, fakeConfig());
  });

  it('sem personalização devolve o menu e o texto padrão', async () => {
    const t = await service.get('t1');
    expect(t.botMenu).toEqual(DEFAULT_MENU);
    expect(t.menuPrompt).toBe(DEFAULT_MENU_PROMPT);
  });

  it('salva o menu personalizado já normalizado', async () => {
    await service.update('t1', { botMenu: [{ key: 'HUMAN', label: ' Chamar o patrão ', enabled: true }] } as any);
    const saved = prisma.tenant.update.mock.calls[0][0].data.botMenu;
    expect(saved[0]).toEqual({ key: 'HUMAN', label: 'Chamar o patrão', enabled: true });
    expect(saved).toHaveLength(5); // completa com as demais opções
  });

  it('botMenu null volta a seguir o padrão (limpa o campo)', async () => {
    await service.update('t1', { botMenu: null, menuPrompt: null } as any);
    expect(prisma.tenant.update.mock.calls[0][0].data).toEqual({ botMenu: Prisma.DbNull, menuPrompt: null });
  });

  it('telefone inválido vira erro 400', async () => {
    await expect(service.update('t1', { phone: '123' } as any)).rejects.toThrow('Telefone inválido');
  });
});
