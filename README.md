# San Checkout — SAN & CO. Pay Engine

Motor de pagamento whitelabel do ecossistema San & Co. Pix, Boleto,
Cartão de Crédito (1 a 12x), Assinatura por cartão e Assinatura por Pix
Automático, sobre a Asaas.

**Modelo *pull*:** o checkout não guarda catálogo. Ele recebe só
referências opacas na URL, pergunta os dados do pedido à API do próprio
contratante e cobra o valor que veio nessa resposta — nunca um valor
vindo do navegador.

> **Vai mexer no projeto?** Comece pelo [`CLAUDE.md`](./CLAUDE.md) — ele
> diz o que ler antes de tocar em qualquer coisa.
>
> **Vai integrar um projeto ao checkout?** O contrato completo está em
> [`API.md`](./API.md).

---

## Como rodar

```bash
npm install
cp .env.example .env      # preencher com valores reais
npm start                 # backend em http://localhost:3001
```

Front-end: servir a pasta `public/` (Live Server na porta 5501, que é o
valor padrão de `ORIGEM_FRONTEND`).

Banco: rodar os arquivos de `supabase/migrations/` **em ordem numérica**
no SQL Editor do Supabase. Banco novo começa no `0001_baseline.sql`, que
é idempotente e pode ser reexecutado.

**Mudança de schema é sempre um arquivo novo** (`0002_…`, `0003_…`),
nunca uma edição num que já rodou — ver `CONSTRAINTS.md`.

## Como rodar os testes

```bash
npm test
```

Roda as seis suítes de uma vez (assinatura HMAC do webhook, conversão
das taxas da Asaas, regra de id imprevisível, hash da senha do admin, a
redação do log de auditoria — que falha se qualquer dado de pessoa
sobreviver — e o caminho crítico do webhook de entrada: guarda de
origem, mapa de evento→status, idempotência, soma de taxas e a
gravação da linha de auditoria). Não precisa de `.env`: o
runner injeta valores falsos só para os módulos carregarem, e nenhum
teste toca banco, rede ou relógio. Os mesmos testes rodam sozinhos a cada
push, em `.github/workflows/ci.yml` — push que quebra teste não entra.

Exige **Node 22 ou mais novo** (`engines` no `package.json`):
`@supabase/supabase-js` usa WebSocket nativo, que não existe no Node 20 —
ver `docs/erros/2026-09-11-ci-preso-em-node-20.md`.

## Variáveis de ambiente

Nomes; os valores ficam no `.env` local e no painel do Render.

| Variável | Para quê |
|---|---|
| `PORT` | Porta do backend (padrão 3001) |
| `ORIGEM_FRONTEND` | Única origem liberada no CORS |
| `SUPABASE_URL` | Projeto do Supabase |
| `SUPABASE_SERVICE_KEY` | Chave `service_role` — só o backend a usa |
| `ASAAS_API_KEY` | Chave da conta Asaas |
| `ASAAS_AMBIENTE` | `producao` usa a API de produção; qualquer outro valor usa o sandbox |
| `ASAAS_WEBHOOK_TOKEN` | Token que a Asaas reenvia em cada webhook. Sem ele, o endpoint recusa tudo |
| `CHECKOUT_ADMIN_USER` | Usuário do painel administrativo |
| `CHECKOUT_ADMIN_PASS_HASH` | Hash scrypt da senha do painel — gere com `node scripts/gerar-hash-admin.js`. A senha em texto puro não é lida em lugar nenhum |
| `TAXA_PERCENTUAL` / `TAXA_FIXA` | Compõem a taxa própria do checkout |

## Cadastrar um contratante

Pelo painel: `/admin.html` → **Contratantes** → **Novo contratante**.
A `api_key` é gerada pelo backend e mostrada uma vez — copie na hora.

Nunca por API pública, e nunca inserindo linha à mão no Supabase.

## Onde roda

| Camada | Onde |
|---|---|
| Backend | Render — `https://san-checkout.onrender.com` |
| Front | Cloudflare Pages — `https://checkout.sancocore.com.br` |
| Banco | Supabase (RLS habilitado; só o backend acessa) |
| Pagamento | Asaas |

`/api/saude` é consultada por um agendador externo a cada 10 minutos:
mantém o Render acordado, mantém o Supabase ativo, e expõe alerta de
chave da Asaas prestes a expirar.
