# Testes

Nenhum teste precisa de banco, Redis ou Evolution: dependências externas são mockadas (`backend/src/testing/prisma-mock.ts`, `fetch` simulado).

```bash
cd backend
npm test            # unitários (162)
npm run test:e2e    # HTTP com supertest (10)
npm run test:cov    # cobertura

cd mobile
npm test            # 18
npm run typecheck
```

## Backend — o que é coberto

| Arquivo | Cenários |
|---|---|
| `availability.spec.ts` | Slots por duração/passo, pausa de almoço, colisões, serviço longo, horários passados, bordas |
| `availability.service.spec.ts` | Conversão de fuso, janela de agendamento, folga de dia inteiro, revalidação, exclusão do próprio agendamento |
| `appointments.service.spec.ts` | Confirmação no WhatsApp, permissões barbeiro/cliente, antecedência mínima de cancelamento, oferta da vaga, isolamento por tenant, remarcação, indisponibilidade (dia/período), transições de status, fluxo do dia |
| `offers.service.spec.ts` | Adiantamento: escolha do candidato que cabe, não repetir quem recusou, sem duplicidade, cliente com proposta pendente, SIM → cadeia, NÃO → próximo, vaga já ocupada, remarcação por número, CANCELAR, expiração |
| `offer-reply.spec.ts` | Interpretação de SIM/NÃO/números/cancelar com acentos e variações |
| `conversation.service.spec.ts` | Cadastro automático, SAIR, prioridade de propostas, CONFIRMAR, RECEBER PROMOÇÕES x voltar, contingência do bot, bloqueado, suspenso, atendimento humano e expiração, bot desligado, ordem das mensagens |
| `menu-bot.service.spec.ts` | Nome de cliente novo, saudação personalizada, agendamento completo, barbeiro específico, opção inválida/voltar, horário ocupado na confirmação, sem horários, meus horários, cancelar (único, manter, antecedência), remarcar, atendente humano, expiração do estado |
| `evolution.client.spec.ts` | Chave global x token da instância, formatos de resposta, erros HTTP/rede |
| `evolution-webhook.parser.spec.ts` | Texto, LID, sufixo de dispositivo, mensagens próprias/grupos/mídia, eventos de conexão |
| `whatsapp-instance.service.spec.ts` | Criação idempotente e criptografada, falha do Evolution, QR, manutenção (saudável, reconectar, sessão perdida, recriar, ERROR após 3 falhas, isolamento de falhas) |
| `billing.service.spec.ts` | Como pagar (chave PIX), registro de pagamento (+1 mês, vencida conta de hoje, vários meses, desconto), rotina diária (lembrete, inadimplência, suspensão) |
| `campaigns.service.spec.ts` | `{nome}`, rodapé SAIR, opt-in, tags, espaçamento, WhatsApp desconectado, reenvio, cron |
| `guards.spec.ts` | JWT, papéis, 402 por status da assinatura, rotas liberadas |
| `utils.spec.ts` | Telefones BR, AES-GCM, fuso horário |
| `test/app.e2e-spec.ts` | 401/403/402/400 reais, rejeição de `tenantId` no body, webhook do WhatsApp (segredo, enfileiramento, conexão) |

## Mobile

| Arquivo | Cenários |
|---|---|
| `format.test.ts` | Moeda, datas relativas, telefone, ações por status, mensagens de erro da API |
| `components.test.tsx` | StatusBadge, AppointmentCard, DayNavigator, Button desabilitado |
| `api.test.ts` | Refresh de token (sucesso, sem token, falha, chamadas simultâneas → 1 renovação) |

## Teste manual ponta a ponta (homologação)

1. `SEED_DEMO=true` + seed → login `dono@demo.com` / `demo12345` no app.
2. Conectar o WhatsApp (QR) com um número de teste.
3. De outro celular: "oi" → menu → 1 → agendar.
4. Agendar um segundo cliente mais tarde no mesmo barbeiro; cancelar o primeiro → o segundo recebe "quer adiantar?".
5. No app (João): "Não vou poder atender" → clientes recebem opções numeradas.
6. Campanha para tag `vip`; responder SAIR.
7. Assinatura: `POST /admin/tenants/:id/payments` → status muda para Ativa no app.
