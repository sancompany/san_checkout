-- 0018 — `estornos`: cada pedido de estorno é uma OPERAÇÃO durável,
-- gravada ANTES da chamada à Asaas (SEC-002, Estação 6)
--
-- O furo: `POST /estornar` não tinha identidade de operação. O
-- arrendamento `cobrancas.estornando_em` (0013) serializa chamadas
-- SIMULTÂNEAS, mas uma repetição SEQUENCIAL — exatamente o que o
-- `API.md` §5.4 mandava fazer "numa falha de rede sua" — era
-- indistinguível de um segundo estorno parcial legítimo. Cobrança de
-- R$ 100, estorno de R$ 30, resposta perdida no caminho, o contratante
-- repete: o restante é R$ 70, o arrendamento está livre, e a Asaas
-- devolve mais R$ 30 de verdade.
--
-- A Asaas não documenta chave de idempotência no estorno (doc oficial
-- "Estornar cobrança", lida em 25/09/2026 — não se inventa cabeçalho).
-- O que ela documenta é `description` no pedido e em cada item de
-- `GET /v3/payments/{id}/refunds`. Então a identidade mora aqui, e viaja
-- para lá dentro da `description` (`marcador`): um resultado AMBÍGUO
-- (timeout, 5xx, queda do processo no meio da chamada) é resolvido
-- procurando o marcador na lista de estornos da própria cobrança — nunca
-- chamando de novo às cegas.
--
-- Estados (`src/services/estornoService.js` é quem transita):
--   PENDING                  gravada, Asaas ainda não chamada
--   CALLING_PROVIDER         reivindicada, chamada em curso (`chamando_em` é o arrendamento)
--   UNKNOWN_PROVIDER_RESULT  a chamada pode ter sido processada; só a reconciliação decide
--   CONFIRMED                a Asaas aceitou (boleto: pedido aceito, dinheiro depois)
--   FAILED_RETRYABLE         provado que NADA foi estornado; a mesma chave pode tentar de novo
--   FAILED_FINAL             não há mais o que estornar para esta operação
--
-- `unique (contratante_id, chave_idempotencia)`: a mesma chave é a mesma
-- operação — repetir devolve o resultado gravado, sem segunda chamada.
-- Sem dado de pessoa: ids, valores, estados e o marcador.

create table if not exists estornos (
  id uuid primary key default gen_random_uuid(),
  cobranca_id uuid not null references cobrancas(id),
  contratante_id text not null references contratantes(id),
  charge_id text not null,
  chave_idempotencia text not null check (length(chave_idempotencia) between 1 and 128),
  valor_centavos bigint not null check (valor_centavos > 0),
  total boolean not null default false,
  estado text not null default 'PENDING' check (estado in (
    'PENDING', 'CALLING_PROVIDER', 'UNKNOWN_PROVIDER_RESULT',
    'CONFIRMED', 'FAILED_RETRYABLE', 'FAILED_FINAL'
  )),
  marcador text not null,
  chamando_em timestamptz,
  tentativas integer not null default 0,
  status_resultado text,
  valor_estornado_depois numeric(12, 2),
  ultimo_erro text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint estornos_chave_unica unique (contratante_id, chave_idempotencia)
);

create index if not exists idx_estornos_cobranca on estornos(cobranca_id);
create index if not exists idx_estornos_em_aberto
  on estornos(estado)
  where estado in ('PENDING', 'CALLING_PROVIDER', 'UNKNOWN_PROVIDER_RESULT');

alter table estornos enable row level security;
revoke all on table estornos from anon, authenticated;

comment on table estornos is
  'Cada pedido de estorno como operação durável, gravada antes da chamada à Asaas (SEC-002). A mesma chave de idempotência é a mesma operação; resultado ambíguo é reconciliado pelo marcador em GET /v3/payments/{id}/refunds, nunca repetido às cegas. Ver src/services/estornoService.js.';
