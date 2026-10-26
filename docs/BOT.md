# Atendimento automático no WhatsApp (bot de menu)

Sem IA e sem custo por mensagem: o cliente navega por um **menu numerado**. O estado de cada conversa fica em `Conversation.state` e expira após 30 min sem resposta.

## Menu principal

```
Olá, Carlos! 👋 Bem-vindo à *Barbearia do Zé* 💈

Como posso ajudar? Responda com o número:

*1* - Agendar horário
*2* - Meus horários
*3* - Cancelar horário
*4* - Remarcar horário
*5* - Falar com a barbearia
```

Também entende palavras (se a opção estiver ativa): `agendar`, `marcar`, `cancelar`, `remarcar`, `meus horarios`, `atendente`. Em qualquer etapa, `0`, `menu`, `voltar` ou uma saudação (`oi`, `bom dia`) voltam ao menu.

## Fluxos

| Opção | Etapas |
|---|---|
| **1 Agendar** | serviço (pulado se houver só 1) → barbeiro ("Tanto faz" ou nome; pulado se houver só 1) → dia (próximos 7 dias **com horário livre**, até 14 dias à frente) → horário (até 12) → confirmar → mensagem de confirmação |
| **2 Meus horários** | lista os próximos agendamentos |
| **3 Cancelar** | escolhe o agendamento (direto se houver só 1) → confirmar. Respeita `minCancelHours` |
| **4 Remarcar** | escolhe o agendamento → dia → horário (qualquer barbeiro, ignorando o próprio horário) → confirmar |
| **5 Falar com a barbearia** | silencia o bot por 6h para esse cliente e envia push ao dono, que responde pelo próprio WhatsApp |

- Cliente novo: o bot pergunta o **nome** antes do menu e salva no cadastro.
- Horário ocupado entre a escolha e a confirmação: avisa e mostra os horários do mesmo dia de novo.
- Regras de negócio que falham (ex.: cancelamento em cima da hora) viram mensagem com ⚠️ e voltam ao menu.

## Prioridade das mensagens

1. `SAIR` / `RECEBER PROMOÇÕES` → opt-out / opt-in de campanhas
2. Resposta a proposta pendente (SIM/NÃO para adiantar; número para remarcação por indisponibilidade)
3. `CONFIRMAR` → confirma o próximo horário (resposta ao lembrete)
4. Atendimento humano ativo → silêncio
5. Bot de menu

## Personalização (app → Menu → Personalizar → Atendimento no WhatsApp)

Tudo com prévia ao vivo no app, no formato de conversa do WhatsApp:

| Campo | O que faz |
|---|---|
| `botEnabled` | Liga/desliga o menu automático (comandos fixos, lembretes e propostas continuam) |
| `welcomeMessage` | Saudação antes do menu. Aceita `*negrito*` |
| `menuPrompt` | Texto acima das opções (padrão: "Como posso ajudar? Responda com o número:") |
| `botMenu` | Lista `[{ key, label, enabled }]`: **renomear**, **ocultar** e **reordenar** as opções |

Chaves de `botMenu`: `BOOK` (agendar), `MY` (meus horários), `CANCEL`, `RESCHEDULE`, `HUMAN` (falar com a barbearia).
A numeração é sempre sequencial sobre as opções ativas; uma opção oculta não funciona nem por palavra-chave.
Por isso as mensagens automáticas usam palavras (*AGENDAR*, *REMARCAR*, *CANCELAR*, *ATENDENTE*) em vez de números fixos.
Pelo menos uma opção fica ativa (se todas forem desligadas, "Agendar" é mantida).

## Código

`backend/src/modules/bot/menu-bot.service.ts` (máquina de estados) e `conversation.service.ts` (orquestração). Testes: `menu-bot.service.spec.ts` simula conversas completas.
