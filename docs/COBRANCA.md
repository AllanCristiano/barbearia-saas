# Cobrança da plataforma (manual, sem gateway)

Cada barbearia paga **R$ 200,00/mês** (`PLATFORM_PRICE_CENTS=20000`) para você. No MVP não há integração com gateway: o dono paga por PIX (ou como combinarem) e **você confirma o recebimento** no painel de admin.

## Configuração (`.env`)

| Variável | Uso |
|---|---|
| `PLATFORM_PRICE_CENTS` | Valor da mensalidade (centavos) |
| `PLATFORM_PIX_KEY` | Sua chave PIX, exibida no app com botão "copiar" |
| `PLATFORM_PAYMENT_INSTRUCTIONS` | Texto livre exibido ao dono |
| `PLATFORM_CONTACT` | Seu WhatsApp (só números) para o botão "Enviar comprovante" |
| `TRIAL_DAYS` | Dias de teste grátis no cadastro (padrão 7) |
| `GRACE_DAYS` | Carência após o vencimento antes de suspender (padrão 3) |

## Fluxo

1. O dono abre **Assinatura** no app: vê status, valor, vencimento, a chave PIX e o botão para enviar o comprovante no seu WhatsApp.
2. Você confere o pagamento e registra:
   ```http
   POST /admin/tenants/{tenantId}/payments
   Authorization: Bearer <token do SUPER_ADMIN>
   { "method": "PIX", "months": 1, "notes": "PIX recebido 24/10" }
   ```
   `method`: `PIX | CARD | CASH | TRANSFER`. `months` (padrão 1) e `amountCents` (padrão mensalidade × meses, aceita desconto) são opcionais.
3. A assinatura é estendida a partir do vencimento atual (ou de hoje, se já venceu), a barbearia volta a `ACTIVE` e o dono recebe push "Pagamento confirmado".

Use `GET /admin/tenants` para achar o `tenantId` e `GET /admin/tenants/{id}/payments` para o histórico. `POST /admin/tenants/{id}/extend { days }` continua disponível para cortesias.

## Ciclo de vida

```
TRIAL ──venceu──▶ PAST_DUE ──GRACE_DAYS──▶ SUSPENDED
  │                  ▲   │                      │
  └─pagamento─▶ ACTIVE ──┘ venceu   pagamento ──┘ (reativa na hora)
```

**Rotina diária (08:00, Brasília):** lembrete por push 3 dias antes do vencimento → `PAST_DUE` ao vencer → `SUSPENDED` após a carência.
**Suspensa:** o app responde HTTP 402 (exceto Assinatura) e o WhatsApp responde "atendimento indisponível".

## Evolução futura

Para automatizar, basta implementar um gateway (Mercado Pago, Asaas, Stripe) chamando `BillingService.recordPayment()` no webhook de pagamento aprovado — o resto do ciclo já está pronto.
