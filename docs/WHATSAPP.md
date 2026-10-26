# WhatsApp — integração com Evolution Go

O Evolution Go é **infraestrutura interna**. A barbearia só vê "Conectar WhatsApp" no app; o NestJS cria, conecta, monitora e repara as instâncias. Nenhum endpoint, chave ou nome do Evolution chega ao cliente.

## Arquivos

| Arquivo | Papel |
|---|---|
| `evolution.client.ts` | Único ponto que conhece URLs/headers/formatos do Evolution Go |
| `evolution-webhook.parser.ts` | Converte o payload (whatsmeow, PascalCase/camelCase, JID/LID) num evento interno |
| `whatsapp-instance.service.ts` | Ciclo de vida: criar, conectar (QR), status, logout, recriar, manutenção |
| `whatsapp-webhook.controller.ts` | Recebe eventos, autentica, enfileira mensagens |
| `messaging.service.ts` / `outbound.processor.ts` | Fila de envio com retentativa e limite de taxa |
| `whatsapp-maintenance.cron.ts` | Verificação a cada 5 minutos |

## Endpoints do Evolution Go usados

Autenticação pelo header `apikey`: **chave global** (`EVOLUTION_GLOBAL_API_KEY`) para administração; **token da instância** para o resto.

| Operação | Método/rota | Chave |
|---|---|---|
| Criar instância | `POST /instance/create` `{ name, token, advancedSettings }` | global |
| Listar | `GET /instance/all` | global |
| Excluir | `DELETE /instance/delete/{id}` | global |
| Conectar + webhook | `POST /instance/connect` `{ webhookUrl, subscribe, immediate }` | instância |
| QR Code | `GET /instance/qr` → `{ qrcode, code }` | instância |
| Código de pareamento | `POST /instance/pair` `{ phone, subscribe }` → `{ PairingCode }` | instância |
| Status | `GET /instance/status` → `{ Connected, LoggedIn, Name }` | instância |
| Reconectar | `POST /instance/reconnect` | instância |
| Logout | `DELETE /instance/logout` | instância |
| Enviar texto | `POST /send/text` `{ number, text }` | instância |

> Rotas conferidas no Swagger do repositório `EvolutionAPI/evolution-go` (outubro/2026). Se uma versão futura mudar algo, ajuste **apenas** `evolution.client.ts` (e `evolution.client.spec.ts`). O Swagger do seu servidor fica em `http://127.0.0.1:8080/swagger/index.html`.

## Duas formas de conectar

| Forma | Quando usar | Fluxo |
|---|---|---|
| **Código (padrão)** | O WhatsApp da barbearia está no **mesmo celular** do app — o caso comum | App → *Gerar código* → `POST /whatsapp/pair` (configura o webhook com `connect` e pede o código com `pair`) → no WhatsApp: Dispositivos conectados → Conectar dispositivo → **Conectar com número de telefone** → digita o código de 8 caracteres |
| **QR Code** | O app está aberto em outro aparelho (tablet, PC, outro celular) | App → *Mostrar QR Code* → `POST /whatsapp/connect` + `GET /whatsapp/qr` (renovado a cada 15s) → escanear |

Em ambos os casos o app consulta o status a cada 4s e muda para "Conectado" sozinho.

## Ciclo de vida da instância

```
signup ──▶ CREATED ──connect (QR)──▶ CONNECTING ──escaneou──▶ CONNECTED
                                                          │
          ERROR ◀── 3 falhas seguidas ──┐                 ├─ socket caiu, sessão ok ─▶ reconnect automático
            │                           │                 ├─ sessão perdida (logout) ─▶ DISCONNECTED + push "escaneie o QR"
            └── manutenção recria ──────┘                 └─ instância sumiu (404) ──▶ recria com o MESMO token + push
```

- Nome interno `bb_<slug>_<aleatório>`; token de 48 hex criptografado com AES-256-GCM.
- Webhook configurado no `connect`: `{EVOLUTION_WEBHOOK_BASE}/webhooks/whatsapp/{id}?secret={webhookSecret}`. No Docker usa a rede interna (`http://api:3000`), sem expor nada.
- Eventos assinados: `EVOLUTION_WEBHOOK_EVENTS` (padrão `MESSAGE,CONNECTION,QRCODE`; valores desconhecidos são ignorados pelo Evolution, que mantém `MESSAGE`).
- A instância é criada com `ignoreGroups` e `ignoreStatus`.

## Manutenção automática (a cada 5 min)

Para cada instância `CONNECTED/CONNECTING/DISCONNECTED/ERROR`:

1. Criação inicial falhou (sem `externalId`) → tenta criar de novo.
2. `LoggedIn && Connected` → saudável, zera falhas.
3. `LoggedIn && !Connected` → `reconnect` (sem QR).
4. `!LoggedIn` e estava `CONNECTED` → marca desconectada e avisa o dono (push).
5. 404 → recria a instância com o mesmo token.
6. Erro de rede/timeout → `failedChecks++`; ≥ 3 → `ERROR`.

O SUPER_ADMIN pode forçar: `POST /admin/whatsapp/maintenance`, `GET /admin/tenants/:id/whatsapp`, `POST /admin/tenants/:id/whatsapp/provision`.

## Mensagens recebidas

- Ignorados: mensagens próprias (`IsFromMe` — inclusive quando o dono responde manualmente), grupos, status, newsletters, mensagens sem texto (áudio/figurinha).
- Endereço LID: usa `SenderAlt` (telefone) quando o remetente vem como `@lid`.
- Deduplicação: `jobId = instanceId-messageId`.

## Envio

- `MessagingService.send()` grava `MessageLog` (QUEUED) e enfileira.
- Worker: limite global 5 msg/s, 4 tentativas com backoff exponencial (5s, 10s, 20s). Instância desconectada → falha → retentativa.
- Status final no `MessageLog` (SENT/FAILED) e contadores da campanha.

## Ativação do Evolution Go

O Evolution Go responde **503 até a licença ser ativada**. Após `docker compose up`, acesse pelo servidor (porta presa em 127.0.0.1):

```bash
ssh -L 8080:127.0.0.1:8080 usuario@seu-servidor
# abra http://localhost:8080 e siga a ativação (ver docs.evolutionfoundation.com.br)
```

## Boas práticas anti-bloqueio

- Número dedicado por barbearia, com histórico de uso real.
- Campanhas só para opt-in, com espaçamento e opção SAIR (já implementado).
- Evite links encurtados e mensagens idênticas em massa; personalize com `{nome}`.
