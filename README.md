# 💈 Barbearia SaaS — agendamento via WhatsApp

Plataforma **multi-tenant** para barbearias: o cliente agenda, cancela e remarca pelo WhatsApp num **menu numerado** automático; os barbeiros acompanham a agenda por um app React Native; o dono da plataforma cobra **R$ 200/mês** de cada barbearia (PIX, confirmado manualmente no painel de admin).

```
barbearia-saas/
├── backend/            API NestJS + Prisma (PostgreSQL) + BullMQ (Redis)
├── mobile/             App dos barbeiros (Expo / React Native / Expo Router)
├── docker/             Scripts de inicialização (bancos do Evolution Go)
├── docs/               Documentação detalhada
├── docker-compose.yml  Stack completa (API, Postgres, Redis, Evolution Go)
└── .env.example        Todas as variáveis de ambiente
```

## Funcionalidades

| Para quem | O que faz |
|---|---|
| **Cliente (WhatsApp)** | Agenda, consulta, cancela e remarca pelo menu (1 Agendar, 2 Meus horários, 3 Cancelar, 4 Remarcar, 5 Atendente); recebe confirmação e lembrete; responde **SIM/NÃO** para adiantar horário; escolhe nova opção quando o barbeiro falta; **SAIR** para parar promoções |
| **Barbeiro (app)** | Agenda do dia, fluxo do dia (faturamento, próximo cliente), confirmar/iniciar/concluir/falta, remarcar, cancelar, “não vou poder atender” (remarcação automática), agendamento manual, push notifications |
| **Dono da barbearia (app)** | Tudo acima + conectar WhatsApp por QR Code, cadastro/importação de clientes com tags, campanhas de promoções/avisos, assinatura (PIX/cartão) |
| **Você (SUPER_ADMIN)** | Registrar pagamentos recebidos, Lista de barbearias, métricas, receita, suspender/reativar, cortesia, manutenção das instâncias de WhatsApp |

**Automação inteligente**

- **Vaga → adiantamento em cadeia:** se alguém cancela, o próximo cliente do mesmo barbeiro no dia recebe “quer adiantar?”. Recusou ou não respondeu em 15 min → oferece ao seguinte. Aceitou → o horário dele vaga e a cadeia continua.
- **Barbeiro indisponível:** bloqueia o dia/período e cada cliente afetado recebe até 3 opções de novo horário (responde com o número).
- **WhatsApp autogerenciado:** o NestJS cria, conecta, monitora (a cada 5 min), reconecta e recria as instâncias no Evolution Go. A barbearia nunca vê o Evolution.
- **Inadimplência:** vencido → aviso; após a carência → suspensão automática (API responde 402 e o bot pausa); pagou → reativa na hora.

## Início rápido (Docker)

```bash
cp .env.example .env            # gere os segredos e preencha sua chave PIX (ver comentários)
docker compose up -d --build
docker compose --profile tools run --rm seed   # cria o SUPER_ADMIN (e demo com SEED_DEMO=true)
```

- API: http://localhost:3001 (porta definida por `API_PORT` no `.env`) — Swagger: `/docs` — Health: `/health`
- ⚠️ O Evolution Go exige **ativação de licença** antes de responder (retorna 503 `LICENSE_REQUIRED`): abra http://localhost:8080/manager/login. Veja [docs/WHATSAPP.md](docs/WHATSAPP.md).
- Se o `docker compose up` falhar com `lookup registry-1.docker.io: no such host`, é instabilidade de DNS do Docker Desktop: rode `docker pull evoapicloud/evolution-go:latest` (ou reinicie o Docker Desktop) e tente de novo.

App:

```bash
cd mobile
cp .env.example .env    # EXPO_PUBLIC_API_URL=http://SEU_IP:3000
npm install
npx expo start
```

## Testes

```bash
cd backend && npm test && npm run test:e2e     # 162 unitários + 10 e2e (HTTP)
cd mobile  && npm test && npm run typecheck     # 18 testes
```

## Documentação

| Documento | Conteúdo |
|---|---|
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | Visão geral, módulos, multi-tenancy, filas, segurança |
| [docs/FLUXOS.md](docs/FLUXOS.md) | Agendamento, cancelamento + adiantamento, indisponibilidade, lembretes, campanhas |
| [docs/WHATSAPP.md](docs/WHATSAPP.md) | Integração Evolution Go, ciclo de vida das instâncias, webhooks, manutenção |
| [docs/BOT.md](docs/BOT.md) | Bot de menu do WhatsApp: fluxos, comandos, personalização |
| [docs/COBRANCA.md](docs/COBRANCA.md) | Mensalidade manual: chave PIX, registro de pagamentos, suspensão |
| [docs/API.md](docs/API.md) | Referência dos endpoints |
| [docs/APP.md](docs/APP.md) | App React Native: telas, push, build com EAS |
| [docs/PUSH.md](docs/PUSH.md) | Notificações com o app fechado: canais, Firebase/EAS, development build |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Produção: HTTPS, backups, variáveis, checklist |
| [docs/TESTES.md](docs/TESTES.md) | Estratégia e cobertura de testes |
