# Deploy em produção

## Requisitos

- VPS Linux com Docker + Docker Compose (2 vCPU / 4 GB RAM atendem dezenas de barbearias).
- Domínio com HTTPS para a API (o app em produção deve falar com HTTPS).
- Licença do Evolution Go e uma chave PIX para receber as mensalidades.

## Passo a passo

```bash
git clone <seu-repo> barbearia-saas && cd barbearia-saas
cp .env.example .env
# Gere segredos:
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY  (NÃO perca: sem ela os tokens das instâncias não são lidos)
openssl rand -hex 32      # EVOLUTION_GLOBAL_API_KEY
# Ajuste DATABASE_URL com a mesma senha de POSTGRES_PASSWORD

docker compose up -d --build
docker compose --profile tools run --rm seed     # SUPER_ADMIN
docker compose logs -f api
```

A API aplica as migrações (`prisma migrate deploy`) a cada inicialização.

## HTTPS (proxy reverso)

Exemplo com Caddy (certificado automático):

```
api.suabarbearia.com.br {
    reverse_proxy localhost:3000
}
```

Depois: `PUBLIC_API_URL=https://api.suabarbearia.com.br`, e mude a porta da API no compose para `127.0.0.1:3000:3000`.

## Consistência e resiliência

- Todos os serviços com `restart: unless-stopped` e healthchecks; a API só sobe com Postgres/Redis saudáveis.
- Redis com AOF (`--appendonly yes`): filas sobrevivem a reinícios.
- Envios e processamento de mensagens com retentativa; webhooks idempotentes.
- Instâncias do WhatsApp verificadas a cada 5 min e reparadas automaticamente.
- Monitore `GET /health` (UptimeRobot, BetterStack…): `down` = Postgres/Redis; `degraded` = Evolution.

## Backups

```bash
# diário (cron do host)
docker compose exec -T postgres pg_dumpall -U $POSTGRES_USER | gzip > backup-$(date +%F).sql.gz
```
Inclui os bancos do Evolution (`evogo_auth`, `evogo_users`) — com eles as sessões do WhatsApp sobrevivem a uma restauração. Guarde também o `.env`.

## Atualizações

```bash
git pull && docker compose up -d --build api
```
Para atualizar o Evolution Go, fixe uma tag em vez de `latest` no compose, teste em homologação e rode `npm test` no backend (os testes do `evolution.client` documentam o contrato).

## Checklist de go-live

- [ ] `.env` completo, segredos fortes, `SEED_DEMO=false`
- [ ] HTTPS ativo e `PUBLIC_API_URL` correto
- [ ] Licença do Evolution Go ativada
- [ ] `PLATFORM_PIX_KEY` e `PLATFORM_CONTACT` preenchidos
- [ ] Teste completo: cadastro → conectar WhatsApp → agendar pelo WhatsApp → cancelar → adiantamento → registrar pagamento no admin
- [ ] Backup diário configurado e restauração testada
- [ ] App publicado com `EXPO_PUBLIC_API_URL` de produção e `projectId` do EAS
- [ ] Termos de uso e política de privacidade (LGPD) para barbearias e clientes finais
