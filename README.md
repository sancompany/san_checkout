# San Checkout v2

Motor de pagamento whitelabel — modelo *pull* (ver `INTEGRACAO.md` do
repositório de documentação). **Esta leva só tem Pix funcionando** —
Cartão/Boleto/Assinatura (via pop-up Asaas Checkout) e nota fiscal no
Drive ficam pra próxima entrega, de propósito, dado o prazo.

## Como rodar

```bash
cd san-checkout          # raiz, não src/
npm install
cp .env.example .env     # preencher com valores reais
npm start
```

Front-end: abrir `public/index.html` com Live Server (porta 5501).
Backend: `http://localhost:3001`.

## Banco de dados

Rodar `supabase/schema.sql` no SQL Editor do seu projeto Supabase.

## Cadastrar um contratante (manual, sempre — nunca por API pública)

No Supabase, tabela `contratantes`, inserir uma linha:

| Campo | Exemplo |
|---|---|
| `id` | `trimundi9` |
| `nome` | `Trimundi9` |
| `api_base_url` | `https://trimundi-backend.onrender.com/api` |
| `api_key` | uma string aleatória combinada com a Trimundi |
| `webhook_url` | `https://trimundi-backend.onrender.com/webhooks/san-checkout` |
| `wallet_id` | (deixar vazio até a Trimundi ter conta Asaas própria) |

## Link de checkout

```
http://SEU-DOMINIO/index.html?c=trimundi9&pedido=SEU_PEDIDO_ID
```

O backend liga pra `api_base_url` do contratante, em
`GET {api_base_url}/pedido/{pedido_id}`, com header
`X-Checkout-Key: {api_key}` — ver `INTEGRACAO.md` pro formato exato
que a Trimundi precisa devolver.

## Pendências desta leva (não esquecidas, só não construídas ainda)

- **Backend de Cartão e Boleto** — o front já chama
  `POST /api/checkout/cartao/:c/:pedido` e
  `POST /api/checkout/boleto/:c/:pedido`, mas **nenhum dos dois existe
  no backend ainda**. Clicar em "Continuar"/"Gerar Boleto" hoje dá 404.
  Também falta `GET /api/checkout/asaas-checkout/status/:id` (polling).
- **Assinatura** — não construída no front nesta leva. O formato do
  link (`?c=&assinatura=`) ainda não foi confirmado com você — ver
  pendência no `VISAO_COMPLETA.md` seção 4.4/13.
- Nota fiscal arquivada no Google Drive (`INVOICE_AUTHORIZED`)
- Webhook nunca testado ao vivo — formato do payload da Asaas é
  suposição informada, não confirmada
- Cartão de débito: confirmar em sandbox que só surge via
  `billingType: UNDEFINED`
