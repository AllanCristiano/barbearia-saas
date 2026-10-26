import { HttpException, Injectable } from '@nestjs/common';
import { Customer, Role, Tenant } from '@prisma/client';
import { formatInTimeZone } from 'date-fns-tz';
import { ptBR } from 'date-fns/locale';
import { PrismaService } from '../../common/prisma/prisma.service';
import { addDaysToDate, formatMoney, humanDateTime, localDate } from '../../common/utils/time.util';
import { Push } from '../notifications/push-messages';
import { PushService } from '../notifications/push.service';
import { AppointmentsService } from '../scheduling/appointments.service';
import { AvailabilityService } from '../scheduling/availability.service';
import { Messages } from '../scheduling/messages';
import { normalizeText } from '../scheduling/offer-reply';
import { DEFAULT_MENU_PROMPT, enabledOptions, MENU_KEYWORDS, MenuKey, resolveMenu } from './menu-config';

/**
 * Atendimento automático por menu numerado no WhatsApp. As opções (texto, ordem e
 * quais aparecem) são configuradas por barbearia — ver menu-config.ts.
 *
 *   MENU ─1─▶ serviço ─▶ barbeiro ─▶ dia ─▶ horário ─▶ confirmar ─▶ agendado
 *        ─2─▶ lista os próximos horários
 *        ─3─▶ escolhe o agendamento ─▶ confirmar ─▶ cancelado
 *        ─4─▶ escolhe o agendamento ─▶ dia ─▶ horário ─▶ confirmar ─▶ remarcado
 *        ─5─▶ atendimento humano
 *   "0", "menu" ou "voltar" retornam ao menu em qualquer etapa.
 *
 * O estado da conversa fica em Conversation.state e expira após STATE_TTL_MINUTES.
 */
export type Step =
  | 'MENU'
  | 'ASK_NAME'
  | 'BOOK_SERVICE'
  | 'BOOK_BARBER'
  | 'BOOK_DAY'
  | 'BOOK_SLOT'
  | 'BOOK_CONFIRM'
  | 'CANCEL_PICK'
  | 'CANCEL_CONFIRM'
  | 'RESCHEDULE_PICK'
  | 'RESCHEDULE_DAY'
  | 'RESCHEDULE_SLOT'
  | 'RESCHEDULE_CONFIRM';

interface SlotOption {
  startsAt: string;
  barberId: string;
  barberName: string;
}

export interface BotData {
  serviceId?: string;
  serviceName?: string;
  barberId?: string;
  appointmentId?: string;
  date?: string;
  /** Valores das opções numeradas exibidas na última mensagem. */
  options?: Array<string | SlotOption>;
  slot?: SlotOption;
}

export interface BotState {
  step?: Step;
  data?: BotData;
  at?: string;
}

export interface BotContext {
  tenant: Tenant;
  customer: Customer;
}

export interface BotResult {
  reply: string;
  state: BotState;
}

export const STATE_TTL_MINUTES = 30;
/** Dias à frente consultados para montar a lista de dias com horário livre. */
export const DAYS_TO_SCAN = 14;
export const MAX_DAYS_SHOWN = 7;
export const MAX_SLOTS_SHOWN = 12;

const BACK = ['0', 'menu', 'voltar', 'inicio', 'oi', 'ola', 'bom dia', 'boa tarde', 'boa noite'];
const YES = ['1', 'sim', 's', 'confirmar', 'confirmo', 'ok', 'pode'];
const NO = ['2', 'nao', 'n'];

/** "3" → índice 2 (se dentro do limite). */
export function pickIndex(text: string, count: number): number | null {
  const m = /^(\d{1,2})$/.exec(normalizeText(text));
  if (!m) return null;
  const i = Number(m[1]) - 1;
  return i >= 0 && i < count ? i : null;
}

const numbered = (items: string[]) => items.map((t, i) => `*${i + 1}* - ${t}`).join('\n');
const backHint = '\n\n_Manda 0 pra voltar ao menu_';

@Injectable()
export class MenuBotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly appointments: AppointmentsService,
    private readonly push: PushService,
  ) {}

  async handle(ctx: BotContext, text: string, current: BotState, now = new Date()): Promise<BotResult> {
    const t = normalizeText(text);
    const expired = !current.at || now.getTime() - new Date(current.at).getTime() > STATE_TTL_MINUTES * 60_000;
    const state: BotState = expired ? {} : current;

    if (!ctx.customer.name && state.step !== 'ASK_NAME') {
      return this.at({ step: 'ASK_NAME' }, now, `${this.greeting(ctx)}\n\nAntes de tudo: qual é o seu *nome*? Quero te chamar do jeito certo. 😎`);
    }
    if (state.step !== 'ASK_NAME' && BACK.includes(t)) return this.menu(ctx, now, true);

    try {
      return await this.dispatch(ctx, text, t, state, now);
    } catch (err) {
      if (err instanceof HttpException) {
        return this.at({ step: 'MENU' }, now, `⚠️ ${err.message}\n\n${this.menuText(ctx)}`);
      }
      throw err;
    }
  }

  private async dispatch(ctx: BotContext, raw: string, t: string, state: BotState, now: Date): Promise<BotResult> {
    const data = state.data ?? {};
    const options = data.options ?? [];

    switch (state.step) {
      case 'ASK_NAME': {
        const name = raw.trim().replace(/\s+/g, ' ');
        if (name.length < 2 || name.length > 60 || /\d/.test(name)) {
          return this.at(state, now, 'Manda só o teu nome, parceiro. 🙂');
        }
        await this.prisma.customer.update({ where: { id: ctx.customer.id }, data: { name } });
        ctx.customer.name = name;
        return this.at({ step: 'MENU' }, now, `Prazer, ${name.split(' ')[0]}! 🤝 Agora tu tá em casa.\n\n${this.menuText(ctx)}`);
      }

      case 'BOOK_SERVICE': {
        const i = pickIndex(t, options.length);
        if (i === null) return this.invalid(state, now);
        const service = await this.prisma.service.findFirst({ where: { id: options[i] as string, tenantId: ctx.tenant.id } });
        if (!service) return this.menu(ctx, now);
        return this.askBarber(ctx, { serviceId: service.id, serviceName: service.name }, now);
      }

      case 'BOOK_BARBER': {
        const i = pickIndex(t, options.length);
        if (i === null) return this.invalid(state, now);
        const barberId = (options[i] as string) || undefined;
        return this.askDay(ctx, { ...data, barberId, options: undefined }, 'BOOK_DAY', now);
      }

      case 'BOOK_DAY':
      case 'RESCHEDULE_DAY': {
        const i = pickIndex(t, options.length);
        if (i === null) return this.invalid(state, now);
        const next = state.step === 'BOOK_DAY' ? 'BOOK_SLOT' : 'RESCHEDULE_SLOT';
        return this.askSlot(ctx, { ...data, date: options[i] as string }, next, now);
      }

      case 'BOOK_SLOT':
      case 'RESCHEDULE_SLOT': {
        const i = pickIndex(t, options.length);
        if (i === null) return this.invalid(state, now);
        const slot = options[i] as SlotOption;
        const booking = state.step === 'BOOK_SLOT';
        const when = humanDateTime(new Date(slot.startsAt), ctx.tenant.timezone);
        const summary = booking
          ? `Confirma o agendamento? 👇\n\n✂️ *${data.serviceName}*\n💈 Com *${slot.barberName}*\n📅 *${when}*`
          : `Confirma a mudança pra *${when}* com *${slot.barberName}*? 🔁`;
        return this.at(
          { step: booking ? 'BOOK_CONFIRM' : 'RESCHEDULE_CONFIRM', data: { ...data, slot, options: undefined } },
          now,
          `${summary}\n\n*1* - ✅ Fechou, confirma\n*2* - 🔁 Ver outro horário${backHint}`,
        );
      }

      case 'BOOK_CONFIRM':
      case 'RESCHEDULE_CONFIRM': {
        const booking = state.step === 'BOOK_CONFIRM';
        if (NO.includes(t)) return this.askSlot(ctx, { ...data, slot: undefined }, booking ? 'BOOK_SLOT' : 'RESCHEDULE_SLOT', now);
        if (!YES.includes(t)) return this.invalid(state, now);
        const slot = data.slot!;
        try {
          if (booking) {
            const a = await this.appointments.create(
              ctx.tenant.id,
              { customerId: ctx.customer.id, serviceId: data.serviceId!, barberId: slot.barberId, startsAt: new Date(slot.startsAt) },
              { kind: 'customer', customerId: ctx.customer.id },
              now,
            );
            const reply = Messages.confirmation(
              ctx.tenant.name,
              { customerName: ctx.customer.name, serviceName: a.service.name, barberName: a.barber.name, startsAt: a.startsAt, priceCents: a.priceCents },
              ctx.tenant.timezone,
            );
            return this.at({}, now, reply);
          }
          const a = await this.appointments.reschedule(
            ctx.tenant.id,
            data.appointmentId!,
            { startsAt: new Date(slot.startsAt), barberId: slot.barberId },
            { kind: 'customer', customerId: ctx.customer.id },
            now,
          );
          return this.at({}, now, `Remarcado ✅ Teu novo horário é *${humanDateTime(a.startsAt, ctx.tenant.timezone)}* com *${a.barber.name}*. Tamo junto! 👊`);
        } catch (err) {
          if (!(err instanceof HttpException) || err.getStatus() !== 400) throw err;
          // Alguém reservou antes: mostra os horários do mesmo dia de novo.
          const again = await this.askSlot(ctx, { ...data, slot: undefined }, booking ? 'BOOK_SLOT' : 'RESCHEDULE_SLOT', now);
          return { ...again, reply: `Ih, alguém foi mais rápido e esse horário acabou de ser ocupado 😅 Escolhe outro:\n\n${again.reply}` };
        }
      }

      case 'CANCEL_PICK':
      case 'RESCHEDULE_PICK': {
        const i = pickIndex(t, options.length);
        if (i === null) return this.invalid(state, now);
        return state.step === 'CANCEL_PICK'
          ? this.askCancelConfirm(ctx, options[i] as string, now)
          : this.startReschedule(ctx, options[i] as string, now);
      }

      case 'CANCEL_CONFIRM': {
        if (NO.includes(t)) return this.at({ step: 'MENU' }, now, `Firmeza, teu horário está mantido 👊\n\n${this.menuText(ctx)}`);
        if (!YES.includes(t)) return this.invalid(state, now);
        const a = await this.appointments.cancel(
          ctx.tenant.id,
          data.appointmentId!,
          { kind: 'customer', customerId: ctx.customer.id },
          'Cancelado pelo cliente',
          now,
        );
        return this.at(
          {},
          now,
          Messages.canceledByCustomer(
            { customerName: ctx.customer.name, serviceName: a.service.name, barberName: a.barber.name, startsAt: a.startsAt },
            ctx.tenant.timezone,
          ),
        );
      }

      default:
        return this.handleMenu(ctx, t, state.step === 'MENU', now);
    }
  }

  private async handleMenu(ctx: BotContext, t: string, inMenu: boolean, now: Date): Promise<BotResult> {
    const choice = this.menuChoice(ctx, t);
    switch (choice) {
      case 'BOOK':
        return this.startBooking(ctx, now);
      case 'MY': {
        const list = await this.appointments.upcomingForCustomer(ctx.tenant.id, ctx.customer.id, now);
        const text = list.length
          ? `📅 *Teus próximos horários:*\n\n${list
              .map((a) => `📅 ${humanDateTime(a.startsAt, ctx.tenant.timezone)} - ${a.service.name} com ${a.barber.name}`)
              .join('\n')}`
          : 'Você não tem horários marcados. Bora resolver isso? 💈';
        return this.at({ step: 'MENU' }, now, `${text}\n\n${this.menuText(ctx)}`);
      }
      case 'CANCEL':
      case 'RESCHEDULE': {
        const cancel = choice === 'CANCEL';
        const list = await this.appointments.upcomingForCustomer(ctx.tenant.id, ctx.customer.id, now);
        if (!list.length) return this.at({ step: 'MENU' }, now, `Você não tem horários marcados.\n\n${this.menuText(ctx)}`);
        if (list.length === 1) return cancel ? this.askCancelConfirm(ctx, list[0].id, now) : this.startReschedule(ctx, list[0].id, now);
        const lines = list.map((a) => `${humanDateTime(a.startsAt, ctx.tenant.timezone)} - ${a.service.name}`);
        return this.at(
          { step: cancel ? 'CANCEL_PICK' : 'RESCHEDULE_PICK', data: { options: list.map((a) => a.id) } },
          now,
          `Qual horário você quer ${cancel ? 'cancelar' : 'remarcar'}?\n\n${numbered(lines)}${backHint}`,
        );
      }
      case 'HUMAN': {
        await this.prisma.conversation.upsert({
          where: { customerId: ctx.customer.id },
          create: { tenantId: ctx.tenant.id, customerId: ctx.customer.id, humanTakeover: true },
          update: { humanTakeover: true },
        });
        await this.push.notifyOwners(ctx.tenant.id, Push.humanRequested(ctx.customer.name ?? ctx.customer.phone, ctx.customer.id));
        return this.at({}, now, 'Demorou! Avisei a equipe da barbearia, que vai te responder por aqui rapidinho. 🤝');
      }
      default:
        return inMenu ? this.at({ step: 'MENU' }, now, `Não entendi 🤔 Manda o *número* de uma opção:\n\n${this.menuText(ctx)}`) : this.menu(ctx, now, true);
    }
  }

  private async startBooking(ctx: BotContext, now: Date): Promise<BotResult> {
    const services = await this.prisma.service.findMany({ where: { tenantId: ctx.tenant.id, active: true }, orderBy: { name: 'asc' } });
    if (!services.length) return this.at({ step: 'MENU' }, now, `Ainda não há serviços disponíveis para agendamento. ${this.humanHint(ctx)}`);
    if (services.length === 1) return this.askBarber(ctx, { serviceId: services[0].id, serviceName: services[0].name }, now);
    return this.at(
      { step: 'BOOK_SERVICE', data: { options: services.map((s) => s.id) } },
      now,
      `✂️ *Qual serviço?*\n\n${numbered(services.map((s) => `${s.name} — *${formatMoney(s.priceCents)}* _(${s.durationMinutes} min)_`))}${backHint}`,
    );
  }

  private async askBarber(ctx: BotContext, data: BotData, now: Date): Promise<BotResult> {
    const barbers = await this.prisma.user.findMany({
      where: { tenantId: ctx.tenant.id, active: true, role: { in: [Role.BARBER, Role.OWNER] }, workingHours: { some: {} } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    if (barbers.length <= 1) return this.askDay(ctx, { ...data, barberId: barbers[0]?.id }, 'BOOK_DAY', now);
    return this.at(
      { step: 'BOOK_BARBER', data: { ...data, options: ['', ...barbers.map((b) => b.id)] } },
      now,
      `💈 *Com qual barbeiro?*\n\n${numbered(['Tanto faz (o primeiro livre)', ...barbers.map((b) => b.name)])}${backHint}`,
    );
  }

  /** Lista os próximos dias que têm pelo menos um horário livre. */
  private async askDay(ctx: BotContext, data: BotData, step: 'BOOK_DAY' | 'RESCHEDULE_DAY', now: Date): Promise<BotResult> {
    const tz = ctx.tenant.timezone;
    const today = localDate(now, tz);
    const days: string[] = [];
    const scan = Math.min(DAYS_TO_SCAN, ctx.tenant.bookingWindowDays);
    for (let i = 0; i <= scan && days.length < MAX_DAYS_SHOWN; i++) {
      const date = addDaysToDate(today, i);
      const slots = await this.availability.getSlots(
        ctx.tenant.id,
        { serviceId: data.serviceId!, date, barberId: data.barberId, excludeAppointmentId: data.appointmentId },
        now,
      );
      if (slots.length) days.push(date);
    }
    if (!days.length) {
      return this.at({ step: 'MENU' }, now, `Não encontrei horários livres nos próximos dias — a agenda tá concorrida! 🔥 ${this.humanHint(ctx)}\n\n${this.menuText(ctx)}`);
    }
    const label = (d: string) => {
      const base = formatInTimeZone(new Date(`${d}T12:00:00Z`), 'UTC', 'EEEE, dd/MM', { locale: ptBR });
      return d === today ? `Hoje (${base})` : d === addDaysToDate(today, 1) ? `Amanhã (${base})` : base;
    };
    return this.at({ step, data: { ...data, options: days } }, now, `📅 *Qual dia?*\n\n${numbered(days.map(label))}${backHint}`);
  }

  private async askSlot(ctx: BotContext, data: BotData, step: 'BOOK_SLOT' | 'RESCHEDULE_SLOT', now: Date): Promise<BotResult> {
    const slots = await this.availability.getSlots(
      ctx.tenant.id,
      { serviceId: data.serviceId!, date: data.date!, barberId: data.barberId, excludeAppointmentId: data.appointmentId },
      now,
    );
    // Sem preferência de barbeiro: um horário por hora:minuto (o primeiro barbeiro livre).
    const unique = new Map<string, SlotOption>();
    for (const s of slots) if (!unique.has(s.startsAt)) unique.set(s.startsAt, { startsAt: s.startsAt, barberId: s.barberId, barberName: s.barberName });
    const options = [...unique.values()].slice(0, MAX_SLOTS_SHOWN);
    if (!options.length) {
      return this.askDay(ctx, { ...data, date: undefined }, step === 'BOOK_SLOT' ? 'BOOK_DAY' : 'RESCHEDULE_DAY', now);
    }
    const showBarber = !data.barberId;
    const lines = options.map((o) => `${formatInTimeZone(new Date(o.startsAt), ctx.tenant.timezone, 'HH:mm')}${showBarber ? ` com ${o.barberName}` : ''}`);
    return this.at({ step, data: { ...data, options } }, now, `🕐 *Qual horário?*\n\n${numbered(lines)}${backHint}`);
  }

  private async askCancelConfirm(ctx: BotContext, appointmentId: string, now: Date): Promise<BotResult> {
    const a = (await this.appointments.upcomingForCustomer(ctx.tenant.id, ctx.customer.id, now)).find((x) => x.id === appointmentId);
    if (!a) return this.menu(ctx, now);
    return this.at(
      { step: 'CANCEL_CONFIRM', data: { appointmentId } },
      now,
      `Cancelar ${a.service.name} de *${humanDateTime(a.startsAt, ctx.tenant.timezone)}* com ${a.barber.name}?\n\n*1* - Sim, cancelar\n*2* - Não, manter meu horário`,
    );
  }

  private async startReschedule(ctx: BotContext, appointmentId: string, now: Date): Promise<BotResult> {
    const a = (await this.appointments.upcomingForCustomer(ctx.tenant.id, ctx.customer.id, now)).find((x) => x.id === appointmentId);
    if (!a) return this.menu(ctx, now);
    return this.askDay(
      ctx,
      { appointmentId: a.id, serviceId: a.service.id, serviceName: a.service.name },
      'RESCHEDULE_DAY',
      now,
    );
  }

  private invalid(state: BotState, now: Date): BotResult {
    return this.at(state, now, 'Não entendi 🤔 Manda o *número* de uma das opções, ou *0* pra voltar ao menu.');
  }

  private menu(ctx: BotContext, now: Date, greet = false): BotResult {
    return this.at({ step: 'MENU' }, now, greet ? `${this.greeting(ctx)}\n\n${this.menuText(ctx)}` : this.menuText(ctx));
  }

  private greeting(ctx: BotContext): string {
    if (ctx.tenant.welcomeMessage) return ctx.tenant.welcomeMessage;
    const first = ctx.customer.name?.split(' ')[0];
    return `E aí${first ? `, ${first}` : ''}! 👊 Bem-vindo à *${ctx.tenant.name}* 💈\nAqui o corte sai na régua e tu sai no nível de quem tá vencendo. 🔥`;
  }

  private menuText(ctx: BotContext): string {
    const options = enabledOptions(resolveMenu(ctx.tenant.botMenu));
    return `${ctx.tenant.menuPrompt || DEFAULT_MENU_PROMPT}

${numbered(options.map((o) => o.label))}`;
  }

  /** Converte a resposta do cliente (número ou palavra-chave) na opção ativa correspondente. */
  private menuChoice(ctx: BotContext, t: string): MenuKey | null {
    const options = enabledOptions(resolveMenu(ctx.tenant.botMenu));
    const byKeyword = MENU_KEYWORDS[t];
    if (byKeyword) return options.some((o) => o.key === byKeyword) ? byKeyword : null;
    const i = pickIndex(t, options.length);
    return i === null ? null : options[i].key;
  }

  /** Orientação para falar com a barbearia (pela opção configurada, se estiver ativa). */
  private humanHint(ctx: BotContext): string {
    const human = enabledOptions(resolveMenu(ctx.tenant.botMenu)).find((o) => o.key === 'HUMAN');
    return human ? `Manda *ATENDENTE* que a barbearia fala contigo.` : 'Por favor, fale diretamente com a barbearia.';
  }

  private at(state: BotState, now: Date, reply: string): BotResult {
    return { reply, state: { ...state, at: now.toISOString() } };
  }
}
