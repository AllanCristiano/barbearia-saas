# Fluxos de negócio

## 1. Cadastro da barbearia

1. `POST /tenants/signup` → cria `Tenant` (status `TRIAL`, `TRIAL_DAYS` dias), usuário `OWNER`, grade padrão (seg–sáb 09–19, se `ownerIsBarber`), `Subscription` em teste.
2. Cria a instância no Evolution Go (`bb_<slug>_<rand>`, token aleatório criptografado). Se o Evolution estiver fora, a manutenção recria depois.
3. Retorna tokens de login. O dono cadastra serviços, barbeiros e conecta o WhatsApp no app.

## 2. Mensagem recebida no WhatsApp

```
Evolution → POST /webhooks/whatsapp/:instanceId?secret=…
  → valida segredo → parseia (texto, telefone, LID) → fila inbound (dedupe por id)
ConversationService:
  1. cadastra o cliente automaticamente (nome do perfil do WhatsApp)
  2. cliente bloqueado → ignora
  3. barbearia suspensa → aviso "atendimento indisponível"
  4. SAIR / VOLTAR → opt-out / opt-in de promoções
  5. resposta a proposta pendente (SIM/NÃO/1-2-3/CANCELAR) → OffersService
  6. CONFIRMAR → confirma o próximo horário (até 36h)
  7. atendimento humano ativo (< 6h) → silêncio
  8. bot desativado → silêncio
  9. bot de menu numerado → resposta (ver BOT.md)
```

## 3. Agendamento

- **Pelo WhatsApp (bot):** opção 1 → serviço → barbeiro → dia → horário → confirmar. O bot pergunta o nome de clientes novos.
- **Pelo app:** `POST /appointments` → cliente recebe confirmação no WhatsApp; barbeiro recebe push.
- Validações (dentro do lock por barbeiro): dentro da grade, sem conflito com agendamentos/folgas, não no passado (antecedência mínima de 10 min), dentro da janela `bookingWindowDays`.

## 4. Cancelamento → adiantamento em cadeia

```
Cancelou (cliente ou barbearia)
  └▶ offerFreedSlot(barbeiro, horário vago)
       candidatos = agendamentos do MESMO barbeiro, MESMO dia, DEPOIS do horário vago
       para cada candidato (em ordem):
         - já recusou/expirou para este horário? pula
         - tem outra proposta pendente? pula
         - o serviço dele cabe no buraco? (revalida disponibilidade) senão pula
         → cria proposta ADVANCE (expira em offerTimeoutMinutes, padrão 15)
         → WhatsApp: "Vagou um horário às 10:00, quer adiantar? SIM ou NÃO"
  SIM  → move o agendamento; o horário antigo DELE vaga → offerFreedSlot (cadeia)
  NÃO  → próximo candidato
  expirou (cron 1 min) → próximo candidato
  já ocupado quando respondeu → "esse horário acabou de ser preenchido"
```

Regras: cliente só cancela pelo WhatsApp com pelo menos `minCancelHours` (padrão 2h); horários que começam em menos de 15 min não são oferecidos.

## 5. Barbeiro não poderá atender

App → "Não vou poder atender" → `POST /barbers/unavailable { date, startTime?, endTime?, reason? }`

1. Cria `TimeOff` (dia inteiro ou período) — a agenda fica bloqueada.
2. Agendamentos afetados → status `RESCHEDULE_PENDING`.
3. Para cada um: calcula até 3 próximos horários livres (qualquer barbeiro, mesmo serviço) e envia:
   ```
   Tivemos um imprevisto e João não poderá atender no seu horário de sáb, 24/10 às 14:00 😔
   *1* - dom, 25/10 às 09:00 com Pedro
   *2* - dom, 25/10 às 10:00 com Pedro
   *3* - seg, 26/10 às 09:00 com João
   Responda com o número, ou me diga outro dia. Para cancelar, CANCELAR.
   ```
4. Número → remarca (se a opção foi ocupada, envia novas opções). NÃO → orienta a usar a opção 4 (remarcar) para ver outros dias. CANCELAR → cancela. Sem resposta em 12h → push para o dono.

## 6. Remarcação

- Pela barbearia (`POST /appointments/:id/reschedule`): cliente é avisado; horário antigo é oferecido a outros (adiantamento).
- Pelo cliente (bot, opção 4): barbeiro recebe push; horário antigo também entra na cadeia.

## 7. Status do atendimento (app)

```
SCHEDULED ─▶ CONFIRMED ─▶ IN_PROGRESS ─▶ COMPLETED
    │            │
    └────────────┴──▶ NO_SHOW ─▶ (COMPLETED se chegou atrasado)
SCHEDULED/CONFIRMED/RESCHEDULE_PENDING ─▶ CANCELED
```
Concluir atualiza `lastVisitAt` do cliente (útil para campanhas de retorno).

## 8. Lembretes

A cada 5 min: agendamentos `SCHEDULED/CONFIRMED` que começam em até `reminderHoursBefore` (padrão 3h) e ainda sem lembrete → mensagem com "CONFIRMAR / CANCELAR". Agendamentos criados há menos de 30 min não recebem lembrete (seria redundante).

## 9. Campanhas (promoções e avisos)

1. Dono escreve a mensagem (`{nome}` vira o primeiro nome) e escolhe tags (opcional).
2. Público = clientes do tenant com `marketingOptIn = true` e não bloqueados.
3. Envio espaçado (`WHATSAPP_SEND_INTERVAL_MS` + jitter) para reduzir risco de banimento; rodapé "responda SAIR".
4. Progresso (`sentCount`/`failedCount`) atualizado pela fila; status `SENT` ao terminar.
5. Também é possível agendar (`scheduledAt`).

## 10. Atendimento humano

A opção 5 do menu marca a conversa com `humanTakeover` e envia push ao dono. O bot fica em silêncio por 6h para esse cliente, e o dono responde pelo próprio WhatsApp.
