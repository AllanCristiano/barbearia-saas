# Arquitetura

```
 Cliente (WhatsApp)                       Barbeiro / Dono (app Expo)
        │                                            │  HTTPS + JWT
        ▼                                            ▼
 ┌──────────────┐  webhook (rede interna)  ┌──────────────────────────────┐
 │ Evolution Go │ ───────────────────────▶ │          API NestJS          │
 │ (instâncias) │ ◀─────────────────────── │                              │
 └──────────────┘   envio (token instância)│  Auth · Tenants · Staff      │
        │                                  │  Scheduling · Offers · Bot   │ ──▶ Expo Push
        ▼                                  │  Campaigns · Billing · Admin │
   PostgreSQL ◀────────────────────────────┤  BullMQ (inbound/outbound)   │
   (evogo_*)                               └──────────┬─────────┬─────────┘
                                                      ▼         ▼
                                               PostgreSQL     Redis
```

## Módulos do backend (`backend/src/modules`)

| Módulo | Responsabilidade |
|---|---|
| `auth` | Login, refresh token rotativo (hash no banco), logout, `/auth/me` |
| `tenants` | Cadastro público da barbearia (tenant + dono + teste grátis + instância), configurações |
| `staff` | Barbeiros, grade semanal de horários, folgas, push token |
| `catalog` | Serviços (duração, preço). Nunca apagados, só desativados |
| `customers` | Cadastro manual, importação em massa, tags, opt-in, exclusão LGPD |
| `scheduling` | Disponibilidade, agendamentos, propostas (adiantar/remarcar), lembretes |
| `whatsapp` | Cliente Evolution Go, instâncias, webhooks, fila de envio, manutenção |
| `bot` | Orquestração das mensagens recebidas + bot de menu numerado (máquina de estados) |
| `campaigns` | Promoções/avisos em massa com espaçamento anti-bloqueio |
| `billing` | Mensalidade manual (status, chave PIX, pagamentos registrados pelo admin), rotina de inadimplência |
| `notifications` | Push Expo para o app |
| `admin` | Painel do SUPER_ADMIN |
| `health` | `/health/live` (liveness) e `/health` (Postgres, Redis, Evolution) |

## Multi-tenancy (`tenantId`)

- Toda entidade de negócio tem `tenantId` e índices começando por ele.
- O `tenantId` vem **sempre do JWT** (`@CurrentTenant()`), nunca do body/query. O `ValidationPipe` com `forbidNonWhitelisted` rejeita qualquer `tenantId` enviado pelo cliente.
- Todas as consultas dos services filtram por `tenantId` (testado em `appointments.service.spec.ts`).
- No WhatsApp o tenant é identificado pela instância que recebeu o webhook (`/webhooks/whatsapp/:instanceId?secret=`).
- O bot opera sempre com o `tenant` da instância e o `customer` do telefone: um cliente nunca vê nem altera agendamentos de outro.

## Papéis

| Papel | Escopo |
|---|---|
| `SUPER_ADMIN` | Você. Sem tenant. Rotas `/admin/*` |
| `OWNER` | Dono da barbearia. Tudo do tenant |
| `BARBER` | Apenas a própria agenda (listar, agir, remarcar, indisponibilidade) |

Guards globais, nesta ordem: `ThrottlerGuard` → `JwtAuthGuard` → `RolesGuard` → `SubscriptionGuard` (402 para barbearias suspensas/canceladas, exceto rotas `@SkipSubscriptionCheck()` como `/billing`).

## Filas (BullMQ / Redis)

| Fila | Produtor | Consumidor | Detalhes |
|---|---|---|---|
| `whatsapp-inbound` | Webhook do Evolution | `InboundProcessor` → `ConversationService` | Webhook responde 200 na hora; `jobId` = id da mensagem (deduplica reenvios) |
| `whatsapp-outbound` | `MessagingService.send()` | `OutboundProcessor` | 4 tentativas com backoff exponencial; limite 5 msg/s; campanhas espaçadas por `WHATSAPP_SEND_INTERVAL_MS` + jitter; todo envio fica em `MessageLog` |

Mensagens do mesmo cliente são processadas em ordem (lock por telefone no `ConversationService`).

## Rotinas agendadas (`@nestjs/schedule`)

| Frequência | Rotina |
|---|---|
| 1 min | Expira propostas e passa a vaga ao próximo cliente; dispara campanhas agendadas |
| 5 min | Lembretes de horário; manutenção das instâncias de WhatsApp |
| Diário 08:00 (Brasília) | Cobrança: lembrete de vencimento, teste/período vencido, suspensão |

> Rodando **mais de uma réplica** da API, os crons executariam em duplicidade. Para escalar horizontalmente, deixe uma réplica com crons (ex.: variável que desabilita o `ScheduleModule` nas demais) — os processadores BullMQ já escalam naturalmente. O lock de mensagens por cliente é em memória; com várias réplicas, prefira concurrency 1 por grupo (BullMQ Pro) ou um lock Redis.

## Concorrência de agenda (duas pessoas no mesmo horário)

Duas camadas, testadas contra o banco real com 30 pedidos simultâneos (só 1 vira agendamento):

1. **Trava por barbeiro** — `AppointmentWriter` grava dentro de uma transação com `pg_advisory_xact_lock(hashtext(barberId))`. Os pedidos daquele barbeiro entram em fila; cada um revalida a agenda já enxergando o que o anterior gravou. Vale para agendar, remarcar e aceitar "adiantar" (app, WhatsApp e propostas).
2. **Constraint no banco** — `Appointment_no_overlap` (`EXCLUDE USING gist` com `btree_gist`): o PostgreSQL recusa dois agendamentos **ativos** (agendado/confirmado/em atendimento) sobrepostos do mesmo barbeiro, mesmo que algum código futuro esqueça a trava. Intervalos são `[início, fim)`: 09:00–09:30 e 09:30–10:00 não conflitam; cancelados não ocupam a agenda.

Quem perde recebe `400 { code: "SLOT_TAKEN", message: "Esse horário acabou de ser ocupado…" }`. O app mostra "Esse horário voou! ⚡" e recarrega os horários; o bot do WhatsApp avisa e reenvia a lista do mesmo dia. "Fora do expediente" tem mensagem própria.

## Fuso horário

Datas são gravadas em UTC. Cada barbearia tem `timezone` (padrão `America/Sao_Paulo`); grade de horários é em minutos locais (0–1440). Conversões em `common/utils/time.util.ts` (date-fns-tz).

## Segurança

- Senhas com bcrypt; refresh token rotativo armazenado como SHA-256 e revogado no logout.
- Token das instâncias criptografado com AES-256-GCM (`ENCRYPTION_KEY`).
- Webhook do WhatsApp autenticado por segredo por instância (comparação em tempo constante).
- Helmet, CORS configurável, rate-limit global e reforçado em login/cadastro.
- Evolution Go sem porta pública (apenas `127.0.0.1` para administração).
- LGPD: opt-out com SAIR, exclusão definitiva de cliente (`DELETE /customers/:id`).

## Modelo de dados

Ver `backend/prisma/schema.prisma` (comentado). Principais entidades: `Tenant`, `User`, `Service`, `WorkingHour`, `TimeOff`, `Customer`, `Appointment`, `AppointmentOffer`, `WhatsappInstance`, `MessageLog`, `Conversation`, `Campaign`, `Subscription`, `Payment`.
