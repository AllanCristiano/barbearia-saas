# Referência da API

Documentação interativa (Swagger/OpenAPI) com todos os schemas: **`GET /docs`**.

Autenticação: `Authorization: Bearer <accessToken>` (15 min). Renove com `/auth/refresh`.
Erros seguem o padrão NestJS: `{ statusCode, message, error }`. Códigos: 400 validação/regra de negócio, 401 sem sessão, 403 sem permissão, 402 assinatura inativa, 404 não encontrado, 409 duplicado, 429 limite de requisições.

Legenda de papéis: **P** público · **O** OWNER · **B** BARBER · **A** SUPER_ADMIN

## Auth e barbearia

| Método | Rota | Papel | Descrição |
|---|---|---|---|
| POST | `/tenants/signup` | P | `{ shopName, ownerName, email, password, phone, ownerIsBarber? }` → tenant + tokens |
| POST | `/auth/login` | P | `{ email, password }` → `{ accessToken, refreshToken, user }` |
| POST | `/auth/refresh` | P | `{ refreshToken }` → novo par (o anterior é invalidado) |
| POST | `/auth/logout` | O B | Revoga refresh e push token |
| GET | `/auth/me` | todos | Usuário + barbearia |
| GET | `/tenants/me` | O B | Dados, regras e assinatura |
| PATCH | `/tenants/me` | O | `name, phone, address, timezone, botEnabled, welcomeMessage, menuPrompt, botMenu[{key,label,enabled}], bookingWindowDays, minCancelHours, reminderHoursBefore, slotStepMinutes, offerTimeoutMinutes` |

## Equipe e serviços

| Método | Rota | Papel | Descrição |
|---|---|---|---|
| GET | `/staff` | O B | Equipe com grade |
| POST | `/staff` | O | `{ name, email, password, phone?, role? }` |
| PATCH | `/staff/:id` | O | `{ name?, phone?, active?, password? }` |
| GET/PUT | `/staff/:id/working-hours` | O B* | PUT `{ hours: [{ weekday: 0-6, start: "09:00", end: "12:00" }] }` (substitui) |
| GET | `/staff/:id/time-off` | O B | Folgas futuras |
| DELETE | `/staff/time-off/:id` | O B* | Remove folga |
| POST | `/staff/me/push-token` | O B | `{ token: "ExponentPushToken[...]" }` |
| GET | `/services?all=true` | O B | Serviços (ativos, ou todos) |
| POST | `/services` | O | `{ name, description?, durationMinutes, priceCents }` |
| PATCH | `/services/:id` | O | Campos acima + `active` |

\* barbeiro só na própria agenda.

## Clientes

| Método | Rota | Papel | Descrição |
|---|---|---|---|
| GET | `/customers?q=&tag=&page=&pageSize=` | O B | Busca paginada |
| GET | `/customers/tags` | O B | Tags existentes |
| GET | `/customers/:id` | O B | Detalhe + últimos 20 agendamentos + `stats { visits, totalSpentCents }` |
| POST | `/customers` | O B | `{ name, phone, email?, birthDate?, notes?, tags?, marketingOptIn? }` |
| POST | `/customers/import` | O | `{ customers: [...] }` (até 5000; upsert por telefone) → `{ created, updated, invalid }` |
| PATCH | `/customers/:id` | O B | Campos acima + `blocked` (`email: null` limpa; telefone de outro cliente → 409) |
| DELETE | `/customers/:id` | O | Exclusão definitiva (LGPD) |

## Agenda

| Método | Rota | Papel | Descrição |
|---|---|---|---|
| GET | `/availability?serviceId&date&barberId?&excludeAppointmentId?` | O B | Horários livres `[{ barberId, barberName, startsAt, time, date }]` |
| GET | `/appointments?date&barberId?` | O B | Agenda do dia |
| GET | `/appointments/summary?date&barberId?` | O B | Fluxo do dia: `total, byStatus, expectedRevenueCents, completedRevenueCents, next, appointments` |
| GET | `/appointments/:id` | O B | Detalhe |
| POST | `/appointments` | O B | `{ customerId, serviceId, barberId, startsAt, notes? }` — cliente recebe confirmação |
| PATCH | `/appointments/:id/status` | O B | `{ status: CONFIRMED | IN_PROGRESS | COMPLETED | NO_SHOW | SCHEDULED }` |
| POST | `/appointments/:id/cancel` | O B | `{ reason? }` — avisa o cliente e oferece a vaga |
| POST | `/appointments/:id/reschedule` | O B | `{ startsAt, barberId? }` |
| POST | `/barbers/unavailable` | O B | `{ date, startTime?, endTime?, reason?, barberId? }` → `{ timeOffId, affected }` |

## WhatsApp

| Método | Rota | Papel | Descrição |
|---|---|---|---|
| GET | `/whatsapp/status` | O | `{ status, phoneNumber, connectedAt, lastError }` (consulta em tempo real) |
| POST | `/whatsapp/pair` | O | `{ phone? }` → `{ status, pairingCode }` — conectar **pelo próprio celular** (sem QR) |
| POST | `/whatsapp/connect` | O | Pareamento por QR Code (outro aparelho) → `{ status, qrcode?, code? }` |
| GET | `/whatsapp/qr` | O | QR atual (renova a cada ~20s) |
| DELETE | `/whatsapp/session` | O | Desconecta o número |

## Campanhas

| Método | Rota | Papel | Descrição |
|---|---|---|---|
| GET | `/campaigns` | O | Histórico |
| GET | `/campaigns/audience?tags=a,b` | O | `{ count }` |
| POST | `/campaigns` | O | `{ title, message, tags?, scheduledAt? }` |
| PATCH | `/campaigns/:id` | O | Editar rascunho/agendada |
| POST | `/campaigns/:id/send` | O | Disparar agora |
| POST | `/campaigns/:id/cancel` | O | Cancelar |

## Assinatura

| Método | Rota | Papel | Descrição |
|---|---|---|---|
| GET | `/billing` | O | Status, vencimento, como pagar (`howToPay.pixKey`…), histórico — acessível mesmo suspenso |

## Admin da plataforma

| Método | Rota | Descrição |
|---|---|---|
| GET | `/admin/tenants` | Barbearias com assinatura, instância e contagens |
| GET | `/admin/metrics` | Status, instâncias, receita 30 dias |
| POST | `/admin/tenants/:id/status` | `{ status }` |
| POST | `/admin/tenants/:id/payments` | `{ method: PIX, CARD, CASH ou TRANSFER, months?, amountCents?, notes? }` — registra pagamento e estende |
| GET | `/admin/tenants/:id/payments` | Histórico de pagamentos |
| POST | `/admin/tenants/:id/extend` | `{ days }` (cortesia) |
| GET | `/admin/tenants/:id/whatsapp` | Status da instância |
| POST | `/admin/tenants/:id/whatsapp/provision` | Cria instância se faltar |
| POST | `/admin/whatsapp/maintenance` | Roda a manutenção agora |

## Webhooks e saúde (sem JWT)

| Método | Rota | Autenticação |
|---|---|---|
| POST | `/webhooks/whatsapp/:instanceId?secret=` | Segredo por instância |
| GET | `/health/live` | — |
| GET | `/health` | — (503 se Postgres/Redis fora; `degraded` se Evolution fora) |
