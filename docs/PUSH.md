# Notificações push (com o app fechado)

O que chega no celular do barbeiro/dono, mesmo com o app fechado:

| Canal (Android) | Notificações | Título |
|---|---|---|
| **Agendamentos** | novo cliente (WhatsApp ou app), remarcação pelo cliente, horário adiantado, remarcação confirmada | ✂️ NOVO CLIENTE NA CADEIRA · 🔁 CLIENTE REMARCOU · ⚡ HORÁRIO ADIANTADO |
| **Cancelamentos** | cliente cancelou | ❌ HORÁRIO CANCELADO |
| **WhatsApp** (prioridade máxima) | WhatsApp caiu / voltou | ⚠️ WHATSAPP DESCONECTADO · ✅ WHATSAPP NO AR |
| **Avisos gerais** | cliente pediu atendimento, remarcação sem resposta, mensalidade | 💬 CLIENTE QUER FALAR CONTIGO · ⏰ MENSALIDADE VENCENDO |

- Eventos de agenda vão para o **barbeiro do horário + donos**, um aviso por aparelho e nunca para quem fez a ação.
- Tocar na notificação abre a tela certa (agendamento, cliente, WhatsApp, assinatura) — inclusive quando ela abre o app fechado.
- **Com o app aberto**, a notificação aparece como um banner preto e dourado no topo (em vez do banner do sistema).
- Visual na barra do Android: ícone de tesoura (`assets/notification-icon.png`) pintado de **dourado** (`#D4AF37`), LED dourado. O fundo da notificação é desenhado pelo sistema (claro/escuro conforme o celular) — nenhum app consegue trocá-lo.
- Textos em `backend/src/modules/notifications/push-messages.ts`.

## Por que não funciona no Expo Go

Desde o SDK 53 o **Expo Go não recebe push no Android**. É preciso o **app instalado**: um *development build* (para testar) ou a versão publicada. O app mostra o diagnóstico em **Menu → Notificações**.

## Configuração (uma vez) — ~20 minutos

### 1. Projeto no Expo (EAS)
```bash
cd mobile
npx eas-cli@latest login          # conta gratuita em expo.dev
npx eas-cli@latest init           # cria o projeto e mostra o projectId
```
Se o `init` disser que não consegue gravar na configuração dinâmica, copie o `projectId` para o `app.json`:
```json
"extra": { "eas": { "projectId": "COLE-AQUI" } }
```

### 2. Firebase (é por onde o Android entrega o push)
1. https://console.firebase.google.com → **Adicionar projeto** (pode desativar o Analytics).
2. **Adicionar app → Android**, pacote: `com.suaempresa.barbearia` (o mesmo de `android.package` no `app.json`; troque os dois se quiser).
3. Baixe o **`google-services.json`** e coloque em `mobile/google-services.json` — o `app.config.ts` passa a usá-lo sozinho.
4. Firebase → ⚙️ **Configurações do projeto → Contas de serviço → Gerar nova chave privada** (baixa um `.json`).
5. Envie essa chave para o Expo:
   ```bash
   npx eas-cli@latest credentials -p android
   # → Google Service Account → Manage your Google Service Account Key for Push Notifications (FCM V1)
   # → Upload a new service account key → selecione o .json do passo 4
   ```

### 3. Gerar o app instalado
Opção A — na nuvem (mais simples, não precisa de Android Studio):
```bash
npx eas-cli@latest build --profile development --platform android
```
Ao terminar, abra o link no celular/emulador e instale o APK.

Opção B — local (usa o Android SDK que você já tem):
```bash
npm run android:build
```

### 4. Usar
```bash
npm run dev            # Metro para o app instalado (development build)
```
Abra o app, faça login e vá em **Menu → Notificações → Enviar notificação de teste**. Depois feche o app e crie um agendamento pelo WhatsApp: a notificação chega com o app fechado.

> Para continuar usando o Expo Go nas telas (sem push): `npm run go`.

## Como funciona por dentro

1. No login, o app cria os 4 canais, pede permissão e obtém o **Expo Push Token**, enviado para `POST /staff/me/push-token`.
2. O backend envia para a **Expo Push API** (`channelId`, `priority: high`, `ttl` de 6h), que entrega via **FCM**.
3. Se o Expo responder `DeviceNotRegistered` (app desinstalado), o token é apagado automaticamente.
4. `POST /staff/me/push-test` manda uma notificação de teste para o próprio aparelho.
