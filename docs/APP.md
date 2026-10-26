# App dos barbeiros (React Native / Expo)

Stack: **Expo SDK 58**, React Native 0.88, **Expo Router** (rotas em `src/app`), TanStack Query, Axios, SecureStore, Expo Notifications.

## Identidade visual

Tema "luxo de quebrada": fundo preto profundo (`#0A0A0B`), dourado com degradê polido (`#F6DC86 → #D4AF37 → #9C7A1E`) em botões e destaques, títulos em **Bebas Neue** (caixa alta condensada), textos em **Inter**, ícones **Ionicons**. Todos os tokens ficam em `src/components/theme.ts` e os componentes base em `src/components/ui.tsx` — trocar a identidade é mexer só nesses dois arquivos.

**Diálogos e avisos:** nunca use `Alert.alert` (caixa branca do sistema). Todos são modais flutuantes preto e dourado (medalhão dourado com brilho, borda dourada). Use `useFeedback()` de `src/components/feedback.tsx`:

| Função | Quando |
|---|---|
| `await feedback.confirm({ title, message, confirmLabel, destructive })` | Confirmações — retorna `true/false`. `destructive` deixa o botão vermelho (excluir, cancelar, bloquear) |
| `feedback.dialog({ title, message, icon, tone, actions })` | Avisos importantes ou com várias ações |
| `feedback.notify({ title, message, tone })` | Sucesso, erro, "copiado" — modal flutuante preto e dourado que fica até a pessoa tocar em *Beleza* / *Entendi* |

## Telas

| Rota | Quem | Conteúdo |
|---|---|---|
| `login` | todos | E-mail e senha |
| `(tabs)/index` — **Agenda** | todos | Lista do dia, navegação por dia, filtro por barbeiro (dono), atualização a cada 60s e por arrastar |
| `(tabs)/summary` — **Fluxo do dia** | todos | Atendimentos, concluídos, faturado, previsto, por status, próximo cliente |
| `(tabs)/customers` — **Clientes** | todos | Busca, tags, opt-in, cadastro |
| `(tabs)/more` — **Mais** | todos | Indisponibilidade; para o dono: WhatsApp, campanhas, assinatura; sair |
| `appointment/[id]` | todos | Detalhe, abrir conversa no WhatsApp, confirmar/iniciar/concluir/falta, remarcar, cancelar com motivo |
| `appointment/reschedule` | todos | Escolha de dia + horário livre (qualquer barbeiro) |
| `appointment/new` | todos | Agendamento manual (cliente, serviço, horário) |
| `customer/new` | todos | Cadastro de cliente |
| `customer/[id]` | todos | Ficha do cliente: visitas e total gasto, editar dados/tags/observações/opt-in, chamar no WhatsApp, agendar já com o cliente, histórico, bloquear; excluir (só dono, LGPD) |
| `unavailable` | todos | "Não vou poder atender": dia inteiro ou período |
| `whatsapp` | dono | Status; conectar **por código no próprio celular** (padrão) ou por QR Code em outro aparelho; desconectar |
| `campaigns` | dono | Nova mensagem com `{nome}`, filtro por tags, prévia de público, histórico |
| `settings` | dono | Central **Personalizar** |
| `settings/bot` | dono | Atendimento no WhatsApp: saudação, texto, renomear/ocultar/reordenar opções, prévia ao vivo |
| `settings/services` | dono | Serviços e preços: criar, editar preço/duração, tirar do cardápio |
| `settings/hours` | todos | Grade semanal com pausa de almoço (dono escolhe o barbeiro; barbeiro edita a própria) |
| `settings/team` | dono | Adicionar barbeiros com login próprio, ativar/desativar acesso |
| `settings/shop` | dono | Nome, WhatsApp, endereço e regras (cancelamento, lembrete, vaga, janela, intervalo) |
| `billing` | dono | Status, vencimento, chave PIX para copiar, enviar comprovante no WhatsApp, histórico |

Rotas protegidas com `Stack.Protected` (sem login → só `login`; telas do dono só para `OWNER`).

## Sessão

- Tokens no **SecureStore**. Interceptor do Axios renova o access token uma única vez quando várias requisições recebem 401 ao mesmo tempo; refresh inválido → volta ao login.
- HTTP 402 (assinatura suspensa) leva o dono para a tela de assinatura.

## Notificações push

Passo a passo completo (Firebase, EAS, development build) em [PUSH.md](PUSH.md).

Após o login o app pede permissão, obtém o **Expo Push Token** e registra em `/staff/me/push-token`. O backend envia push para: novo agendamento, cancelamento/remarcação pelo cliente, adiantamento aceito, WhatsApp desconectado, remarcação sem resposta, pedido de atendimento humano, cobrança. Tocar na notificação abre a tela correspondente.

> Push remoto **não funciona no Expo Go (Android)**: use um development build (`npx expo run:android` ou `eas build --profile development`). Para ativar o push, rode `npx eas-cli@latest init` (ele grava `extra.eas.projectId` no `app.json`). Sem `projectId` o app funciona normalmente, só sem push.

> **Expo pedindo login no Windows?** Se o `npx expo start` perguntar sobre login, escolha **Proceed anonymously** ou use `npx expo start --offline`. A opção "Log in" pelo navegador falha no Windows (bug do Expo CLI com o `&` da URL); para logar, use `npx expo login` (usuário e senha no terminal).

## Rodando

```bash
cd mobile
cp .env.example .env          # EXPO_PUBLIC_API_URL=http://IP_DA_MAQUINA:3000
npm install
npx expo start                # Expo Go para testar telas; dev build para push
npm test                      # testes (jest-expo + Testing Library)
npm run typecheck
```

## Publicação

```bash
npx eas-cli@latest init                       # gera projectId
npx eas-cli@latest build --platform android   # e/ou ios
npx eas-cli@latest submit
```
Antes, ajuste `name`, `slug`, `ios.bundleIdentifier` e `android.package` em `app.json` e os ícones em `assets/`.
