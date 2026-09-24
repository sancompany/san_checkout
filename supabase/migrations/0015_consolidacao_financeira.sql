-- =====================================================================
-- 0015 — CONSOLIDAÇÃO FINANCEIRA (24/09/2026)
--
-- Fecha os quatro CRITICAL e cinco dos HIGH da auditoria independente
-- (`docs/CODEX_CHECKOUT_AUDIT_2026-09-24.md`), confirmados em código
-- antes de construir (`docs/CHECKOUT_FINAL_CONSOLIDATION_2026-09-24.md`).
-- Rodar UMA vez, depois da 0014. Não editar depois de aplicada (Lei 6,
-- CONSTRAINTS.md §2.1) — correção é 0016.
--
-- Tudo aqui é `if not exists` / `add column if not exists`: replay é
-- seguro, o que importa para o ensaio de restauração e para o caso de a
-- migration ser aplicada duas vezes por engano.
--
-- ─────────────────────────────────────────────────────────────────────
-- 1. INBOX DO WEBHOOK (C-01) — o evento da Asaas é PERSISTIDO antes do
--    `200`, e processado a partir da linha, nunca só da requisição.
--
--    O contrato real da Asaas (docs.asaas.com, "Receba eventos do Asaas
--    no seu endpoint de Webhook", lido em 24/09/2026): "Após confirmar
--    a persistência do evento, responda HTTP/1.1 200 OK"; "Utilize o
--    `id` do evento para identificar reenvios e implementar
--    idempotência"; "O mesmo `id` pode ser entregue mais de uma vez";
--    "Após 15 falhas consecutivas, a fila do Webhook pode ser
--    interrompida". Ou seja: o `200` significa "guardei", não
--    "processei" — e quem garante o processamento é a NOSSA fila, não a
--    reentrega da Asaas. Até aqui o receptor respondia 200 mesmo com o
--    processamento estourando, e o evento sumia.
--
--    Guarda o CORPO MÍNIMO (lista branca de campos que o processamento
--    lê: ids, status, valores, datas, `refunds`) — nunca nome, e-mail,
--    documento, telefone, endereço nem cartão (Lei 10). É o suficiente
--    para reprocessar: quem precisa de dado de pessoa lê de `cobrancas`.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists webhook_inbox (
  id uuid primary key default gen_random_uuid(),
  provedor text not null default 'asaas',
  -- `id` do evento (`evt_…`) quando a Asaas manda; sem ele, a impressão
  -- digital abaixo é a chave de idempotência.
  evento_id_provedor text,
  impressao_digital text not null,
  tipo_evento text not null,
  referencia_tipo text,
  referencia_id text,
  ocorrido_em timestamptz,               -- `dateCreated` do evento, hora da Asaas
  recebido_em timestamptz not null default now(),
  status text not null default 'recebido'
    check (status in ('recebido', 'processando', 'processado', 'falhou', 'ignorado')),
  tentativas integer not null default 0,
  proxima_tentativa_em timestamptz,
  ultimo_erro text,
  processado_em timestamptz,
  corpo_hash text not null,
  corpo_minimo jsonb not null
);

create unique index if not exists idx_webhook_inbox_impressao on webhook_inbox(impressao_digital);
create index if not exists idx_webhook_inbox_pendentes
  on webhook_inbox(proxima_tentativa_em)
  where status in ('recebido', 'falhou');
create index if not exists idx_webhook_inbox_referencia on webhook_inbox(referencia_id, recebido_em desc);
create index if not exists idx_webhook_inbox_recebido on webhook_inbox(recebido_em desc);

comment on table webhook_inbox is
  'Fila persistente dos eventos da Asaas (C-01): gravado ANTES do 200, processado a partir da linha, reprocessado pelo worker quando falha. Corpo mínimo por lista branca — sem dado de pessoa.';

-- ─────────────────────────────────────────────────────────────────────
-- 2. OUTBOX Checkout → contratante (H-01) — a notificação ao MostrAí
--    deixa de morar em `setTimeout().unref()`.
--
--    Uma linha por evento de negócio, com chave de idempotência ÚNICA:
--    o mesmo fato (esta cobrança confirmou; esta assinatura foi
--    cancelada) nunca vira duas linhas, e o reenvio administrativo usa o
--    MESMO `id` — que é o `eventoId` que o contratante recebe e pelo
--    qual deduplica. Reiniciar o processo não perde nada: o worker relê
--    o que está `pendente`/`falhou` com `proxima_tentativa_em` vencida.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists outbox_notificacoes (
  id uuid primary key default gen_random_uuid(),
  contratante_id text references contratantes(id) on delete set null,
  url text not null,
  tipo text not null,                    -- pedido | assinatura
  evento text not null,                  -- confirmado, criada, cobranca_confirmada, …
  chave_idempotencia text not null,
  payload jsonb not null,
  status text not null default 'pendente'
    check (status in ('pendente', 'enviando', 'enviada', 'falhou', 'abandonada')),
  tentativas integer not null default 0,
  proxima_tentativa_em timestamptz not null default now(),
  enviando_em timestamptz,               -- arrendamento do worker (CAS)
  ultimo_erro text,
  ultimo_status_http integer,
  criado_em timestamptz not null default now(),
  enviado_em timestamptz
);

create unique index if not exists idx_outbox_chave on outbox_notificacoes(chave_idempotencia);
create index if not exists idx_outbox_pendentes
  on outbox_notificacoes(proxima_tentativa_em)
  where status in ('pendente', 'falhou');
create index if not exists idx_outbox_contratante on outbox_notificacoes(contratante_id, criado_em desc);

comment on table outbox_notificacoes is
  'Fila persistente das notificações ao contratante (H-01). Uma linha por fato de negócio (chave única); o id é o eventoId que o contratante deduplica; reenvio administrativo reusa a mesma linha.';

-- ─────────────────────────────────────────────────────────────────────
-- 3. COTAÇÃO (C-02) — o retrato do preço que a TELA mostrou.
--
--    `GET /pedido` e `GET /plano` gravam aqui o que o contratante
--    respondeu e o que a tela exibiu (totais por método). O `POST` que
--    cobra exige o id da cotação e cobra O QUE ESTÁ AQUI — se o pull
--    novo divergir do retrato, responde 409 com a cotação nova, e a tela
--    pede reconfirmação. Nunca cobra Y depois de mostrar X.
--
--    Sem dado de pessoa: o `pagador` pré-preenchido pelo contratante NÃO
--    entra no retrato (a tela o recebe e devolve no POST, onde é
--    validado). Só descrição, itens e números.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists cotacoes (
  id uuid primary key default gen_random_uuid(),
  contratante_id text not null references contratantes(id) on delete cascade,
  tipo text not null check (tipo in ('pedido', 'plano')),
  referencia_id text not null,           -- pedidoId ou planoId
  retrato jsonb not null,                -- o que o contratante respondeu (campos financeiros)
  totais jsonb not null,                 -- o que a tela mostrou, por método/parcelas
  retrato_hash text not null,
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null,
  usada_em timestamptz
);

create index if not exists idx_cotacoes_referencia on cotacoes(contratante_id, referencia_id, criado_em desc);
create index if not exists idx_cotacoes_expira on cotacoes(expira_em);

comment on table cotacoes is
  'Retrato imutável do preço mostrado ao pagador (C-02). O POST que cobra exige o id e cobra o retrato; divergência do pull vira 409, nunca cobrança silenciosa.';

-- ─────────────────────────────────────────────────────────────────────
-- 4. CLIENTE ASAAS POR DOCUMENTO (H-05) — a Asaas "permite a criação de
--    clientes duplicados" (doc oficial, POST /v3/customers), e
--    busca-então-cria é corrida. A unicidade mora AQUI: a primeira
--    requisição a gravar vence; a segunda lê o que a primeira gravou.
--    Documento em hash (Lei 10): nunca precisamos buscar por ele na
--    Asaas de novo — o que se guarda é o id do cliente.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists clientes_asaas (
  ambiente text not null check (ambiente in ('sandbox', 'producao')),
  documento_hash text not null,
  asaas_customer_id text not null,
  criado_em timestamptz not null default now(),
  primary key (ambiente, documento_hash)
);

-- ─────────────────────────────────────────────────────────────────────
-- 5. `cobrancas` — estorno parcial (H-04), carimbo de precedência (C-03),
--    cotação de origem (C-02) e as constraints de coerência (M-03).
-- ─────────────────────────────────────────────────────────────────────
alter table cobrancas add column if not exists valor_estornado numeric(10,2);
alter table cobrancas add column if not exists status_evento_em timestamptz;
alter table cobrancas add column if not exists cotacao_id uuid;

comment on column cobrancas.valor_estornado is
  'Soma dos estornos concluídos (payment.refunds com status DONE) no último evento de estorno. NULL = nunca houve estorno. Estorno parcial fica em `estornado_parcialmente` com este valor menor que valor_cobrado.';
comment on column cobrancas.status_evento_em is
  '`dateCreated` do evento da Asaas que gravou o status atual. Evento com carimbo anterior ao que já está aqui não regride o status (C-03).';
comment on column cobrancas.cotacao_id is
  'Cotação (retrato do preço mostrado) que originou esta cobrança. NULL nas linhas anteriores a 24/09/2026 e nos ciclos recorrentes/acertos, que não passam pela tela.';

-- O status novo do estorno parcial entra no vocabulário fechado da 0014.
alter table cobrancas drop constraint if exists cobrancas_status_conhecido;
alter table cobrancas add constraint cobrancas_status_conhecido check (
  status in (
    'pendente', 'confirmado', 'estornado', 'estornado_parcialmente',
    'estorno_solicitado', 'estorno_negado', 'vencido', 'em_analise',
    'recusado', 'chargeback', 'cancelado', 'expirado'
  )
);

-- M-03: valor cobrado nunca é zero nem negativo quando existe; parcelas
-- dentro do teto do próprio checkout; estorno nunca negativo nem maior
-- que o cobrado.
alter table cobrancas drop constraint if exists cobrancas_valor_cobrado_positivo;
alter table cobrancas add constraint cobrancas_valor_cobrado_positivo
  check (valor_cobrado is null or valor_cobrado > 0);
alter table cobrancas drop constraint if exists cobrancas_parcelas_no_teto;
alter table cobrancas add constraint cobrancas_parcelas_no_teto
  check (parcelas is null or (parcelas >= 1 and parcelas <= 12));
alter table cobrancas drop constraint if exists cobrancas_estorno_coerente;
alter table cobrancas add constraint cobrancas_estorno_coerente
  check (valor_estornado is null or (valor_estornado >= 0 and (valor_cobrado is null or valor_estornado <= valor_cobrado)));

-- C-04: a reserva de pop-up de ASSINATURA. `idx_cobrancas_pendente_unica`
-- (0001) só cobre pedido (`pedido_id is not null`); a assinatura reserva
-- por plano + documento. Uma sessão pendente por (contratante, plano,
-- pagador): a segunda requisição reaproveita a sessão da primeira.
create unique index if not exists idx_cobrancas_assinatura_pendente_unica
  on cobrancas(contratante_id, plano_id, documento, metodo_pagamento)
  where status = 'pendente' and plano_id is not null and pedido_id is null;

-- ─────────────────────────────────────────────────────────────────────
-- 6. `contratantes` — ciclos que ESTE contratante aceita (M-10). NULL =
--    todos os sete da Asaas (comportamento genérico do Checkout). O
--    MostrAí recebe os quatro do catálogo dele. A tradução do vocabulário
--    (mensal/trimestral/semestral/anual ↔ MONTHLY/…) mora em
--    `src/utils/ciclos.js`, e aqui fica sempre o nome da Asaas.
-- ─────────────────────────────────────────────────────────────────────
alter table contratantes add column if not exists ciclos_permitidos text[];
comment on column contratantes.ciclos_permitidos is
  'Ciclos (vocabulário Asaas) que este contratante pode vender. NULL = sem restrição. Validado em src/utils/ciclos.js na criação da assinatura e na troca de plano.';

update contratantes
   set ciclos_permitidos = array['MONTHLY', 'QUARTERLY', 'SEMIANNUALLY', 'YEARLY']
 where id = 'mostrai' and ciclos_permitidos is null;

-- RLS default-deny, como nas demais (0001/0004): só a service role passa.
alter table webhook_inbox enable row level security;
alter table outbox_notificacoes enable row level security;
alter table cotacoes enable row level security;
alter table clientes_asaas enable row level security;
