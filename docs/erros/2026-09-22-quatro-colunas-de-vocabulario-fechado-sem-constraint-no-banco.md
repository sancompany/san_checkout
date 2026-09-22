# Quatro colunas de vocabulário fechado sem `check` no banco — e a primeira versão da correção quase reabriu produção

**Quando:** 22/09/2026, achado numa auditoria técnica externa (Codex,
sem acesso a este repositório).
**Onde:** `cobrancas.status`, `cobrancas.metodo_pagamento`,
`assinaturas.status`, `assinaturas.ciclo`.

## O que aconteceu

As quatro colunas são vocabulários fechados — um número finito de
valores que o código já trata como exaustivo em vários lugares
(`mapearStatusPayment`, `STATUS_ASSINATURA_TODOS`, `CICLOS_VALIDOS`) —
mas nenhuma tinha `check` no banco. A migration 0009 já tinha aplicado
esse mesmo princípio em `cobrancas.ambiente` (lição nº 19); estas quatro
ficaram de fora.

## A correção — e o erro que ela quase cometeu

A primeira versão desta migration enumerou `cobrancas.status` lendo só
`mapearStatusPayment` (webhookController.js) — nove valores. Antes de
aplicar, uma checagem contra o banco de produção
(`select distinct status from cobrancas`) acusou **`expirado`**, um
valor que não estava em lugar nenhum da minha leitura.

A causa: `cobrancas.status` não é escrito só por `mapearStatusPayment`
— existem MAIS DOIS vocabulários no mesmo arquivo (`processarEvento
Checkout`, os eventos de pop-up: `CHECKOUT_PAID`/`CHECKOUT_CANCELED`/
`CHECKOUT_EXPIRED` → confirmado/cancelado/expirado; e
`processarEventoPixAutomatico`, os eventos de autorização recorrente).
Se a migration tivesse sido aplicada como estava, `ALTER TABLE ...
ADD CONSTRAINT` teria validado as linhas existentes e **falhado na
hora** (a linha com `status='expirado'` já violava o `check`) — ou,
pior, se por acaso não houvesse nenhuma linha `expirado` no momento
exato da aplicação, teria passado e só quebrado depois, na primeira
pop-up expirada em produção: `atualizarStatusPorCheckoutId(id,
'expirado')` teria lançado um erro do Postgres, sem sintoma nenhum até
alguém abrir uma pop-up e deixá-la expirar.

Corrigido antes de aplicar: os onze valores reais de `cobrancas.status`
são a união dos três vocabulários. As outras três colunas foram
verificadas do mesmo jeito — `select distinct` contra produção,
comparado com a enumeração do código — e bateram.

## Verificação

Antes de `ALTER TABLE`, uma consulta por coluna contando quantas linhas
violariam cada `check` proposto (as quatro deram zero, depois da
correção do `status`). Depois de aplicar, `npm run check` (46 suítes) e
uma releitura de `pg_constraint` confirmando as quatro novas
constraints.

## Lição

Enumerar um vocabulário "fechado" lendo só a função mais óbvia que o
produz é a mesma classe de erro que "escrever contra payload
imaginado" — a leitura do código é uma HIPÓTESE sobre o conjunto real,
não o conjunto real. A diferença entre esta vez e as duas de 15/09/2026
(`docs/erros/2026-09-15-confiei-que-o-checkout-paid-traria-o-id-do-
pagamento.md`, `docs/erros/2026-09-15-ciclo-de-assinatura-nao-vinha-
de-webhook-nenhum.md`) é que desta vez a hipótese foi CONFERIDA contra
o banco real antes de virar `ALTER TABLE` — um `select distinct` custa
segundos e teria evitado as duas vezes anteriores também.
