# Contexto — San Checkout

## O que é

**San Checkout** é o motor de pagamento whitelabel da San & Co., modelo
**pull**, com a Asaas (PSP brasileiro) por baixo. Não é um produto vendido
a clientes finais — é **estrutura compartilhada** do ecossistema San & Co.
(skill `classificar`, `.ia/CONTROL_PLANE.md`): outros projetos ("contratantes")
consomem o Checkout para cobrar os próprios clientes, sem construir
cobrança própria.

Repositório: `sancompany/san_checkout`. Backend: `src/server.js` +
`public/` (front do comprador e painel admin). Produção real, sandbox de
pagamento (Asaas ainda em modo sandbox — ver `PROJECT_STATE.md`).

## O problema que resolve

Cada novo projeto do ecossistema (loja, SaaS, evento) precisaria construir
do zero: cobrança avulsa (Pix/boleto/cartão), assinatura recorrente,
webhook assinado, conciliação, estorno, split de taxa — superfície grande
de segurança e dinheiro para reconstruir a cada projeto. O Checkout
resolve isso **uma vez**, e cada projeto novo só integra um contrato de
API (`API.md`), nunca reimplementa.

## Modelo: pull, não push

O Checkout **não guarda catálogo**. Ele não sabe o que um projeto vende
nem por quanto. O fluxo:

1. O projeto-contratante cria o pedido/plano no próprio banco.
2. Manda o comprador para o link do Checkout levando só o **id** do
   pedido/plano.
3. O Checkout liga de volta na API do contratante (`GET /pedido/{id}`
   ou `GET /plano/{id}`) para saber o que é — e cobra **o valor que
   recebeu daquela chamada**, nunca o que veio na URL.
4. Avisa o contratante por webhook assinado quando o dinheiro entra.

Consequência de desenho: adulterar o link não muda o valor cobrado, e o
dado de negócio de cada contratante nunca entra no banco do Checkout —
só o necessário para processar o pagamento (documento do pagador,
telefone, endereço quando o método exige, valor, status).

## Quem usa (usuários)

- **Contratantes** — outros projetos San & Co. (ex.: MostrAí) que
  integram via `API.md` para cobrar os próprios clientes. Cadastrados
  manualmente no banco do Checkout (nunca por endpoint público):
  `contratante_id`, `api_base_url`, `api_key`, `webhook_url`,
  `wallet_id`, métodos habilitados.
- **Pagadores** — o cliente final do contratante, que abre o link do
  Checkout e paga. Nunca tem conta no Checkout; a experiência é uma
  única tela de pagamento.
- **O dono (operador)** — administra contratantes via `public/admin.html`
  (atrás de Cloudflare Access + login próprio), acompanha métrica de
  cobranças confirmadas, resolve incidente.

## Terminologia

| Termo | Significado |
|---|---|
| **Contratante** | Projeto que integra o Checkout para cobrar seus clientes |
| **Pedido** | Venda avulsa (Pix, boleto, cartão até 12x) |
| **Plano** | Definição de assinatura recorrente |
| **Assinatura** | Vínculo ativo entre um documento (CPF/CNPJ) e um plano |
| **Acerto proporcional** | Cobrança adicional ao trocar de plano no meio do ciclo |
| **Checkout Session** (Asaas) | A pop-up hospedada pela Asaas onde o cartão é digitado |
| **Conciliação** | Reconferir status/valor/ciclo direto na Asaas quando o webhook pode ter falhado |
| **`returnUrl`** | Para onde o comprador volta depois de pagar — validado por allowlist de origem |

## Regras de negócio centrais (não repetir a lógica, só localizar)

- **Nenhuma cobrança confia em valor vindo do cliente/URL** — sempre
  puxado da API do contratante ou calculado no servidor
  (`tests/valor-vem-do-servidor.js`).
- **Idempotência por `chargeId` (pedido) / por assinatura+ciclo**
  (assinatura não tem `chargeId` no payload de origem — `API.md` §4.3.6).
- **Piso de cobrança de R$ 5,00** — imposto pela Asaas, replicado como
  validação antecipada (`valorCobradoAceitavel`, `MENSAGEM_PISO_ASAAS`).
- **Troca de plano cobra o acerto proporcional ANTES de alterar o plano**
  (fail-closed) — `src/controllers/trocaPlanoController.js`,
  `src/services/proporcionalService.js`.
- **Toda chamada de saída (para a Asaas ou para o contratante) tem
  teto de tempo** — sem isso, um contratante fora do ar travaria a fila
  de confirmação de pagamento de todos os outros.

O comportamento completo, tela por tela, está em `docs/funcional.md`
(raiz) — não duplicado aqui.

## Ambiente

- **Produção real**, domínio `sancocore.com.br` (Cloudflare DNS/Pages),
  backend na Northflank (`api.sancocore.com.br`), banco Supabase próprio
  (`San_Checkout`, `sa-east-1`).
- **Pagamento em modo sandbox da Asaas** — decisão registrada do dono,
  ver `CONSTRAINTS.md` (raiz) §3 e `PROJECT_STATE.md`. A troca para
  produção real é um gatilho explícito, ainda não puxado.
- Multi-tenant por natureza (múltiplos contratantes), dado de terceiro
  com dinheiro envolvido, vida útil longa — classificação de topo de
  rigor (`CLAUDE.md` raiz, seção "Classificação"; Lei 0 do plugin
  `san-co`, "nada aqui se dispensa por proporcionalidade").

## Contexto histórico relevante

O projeto nasceu dentro da metodologia do plugin `san-co` (esteira de
sete estações: escopo → fronteiras → fundação → contratos → construção →
prontidão → lançamento). Está na **Estação 6 (Prontidão)**, aberta desde
14/09/2026 — ver `PROJECT_STATE.md` para o que já fechou e o que falta.
`CLAUDE.md` (raiz) é o diário de bordo completo, dia a dia, com todo bug
achado e corrigido nessa estação — não reproduzido aqui; leia lá quando
precisar do histórico detalhado. Esta pasta (`.ia/`) existe porque essa
metodologia e essa memória são específicas do Claude Code (o plugin só
carrega nessa ferramenta) e o projeto agora precisa ser operável também
por Codex e Jules — ver `CONTROL_PLANE.md`.
