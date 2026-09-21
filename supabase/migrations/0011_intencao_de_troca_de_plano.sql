-- 0011 — intenção de troca de plano: o pagador aprova antes de cobrar
--
-- Decisão do dono em 20/09/2026, revertendo a de 17/09/2026 ("não
-- existe tela, quem aciona é o contratante"): quando a troca de plano
-- tem acerto a pagar (>= R$ 5,00), o pagador precisa consentir na tela
-- do Checkout ANTES de o cartão salvo ser cobrado. Desenho completo em
-- `docs/specs/2026-09-20-troca-de-plano-redireciona-pagador.md`.
--
-- ── Por que uma tabela nova, e não um campo em `assinaturas` ─────────
-- A rota de hoje (`POST /trocar-plano`) é atômica: tudo acontece numa
-- chamada HTTP do contratante. Com o redirect, a cobrança acontece numa
-- requisição DIFERENTE, do PAGADOR, minutos depois — existe agora um
-- estado que não existia: "troca pedida, ainda não aprovada, pode nunca
-- ser". `assinaturas` já tem um arrendamento de minutos (`trocando_em`,
-- migration 0010) para a operação síncrona; isto aqui é outra coisa —
-- uma intenção que sobrevive à requisição que a criou.
--
-- ── O `id` É o token ──────────────────────────────────────────────────
-- `gen_random_uuid()` já entrega 122 bits de aleatoriedade — acima do
-- piso de 128 bits que o desenho pede quando somado à imprevisibilidade
-- de gerar E consultar por ele. Não existe coluna de token separada: o
-- id da linha, opaco, é o que vai no fragmento da URL
-- (`/troca#t=<id>`), nunca em query string.
--
-- ── O retrato CONGELADO, e por que ele não é recalculado na aprovação
-- Entre a criação da intenção e a aprovação (até 15 minutos depois) o
-- plano, o ciclo ou a assinatura podem ter mudado do lado do
-- contratante ou na Asaas. A aprovação NUNCA recalcula às cegas: ela
-- revalida contra o retrato (plano ainda existe com o mesmo valor,
-- assinatura ainda no mesmo `mutation_version`) e vira `STALE` em
-- qualquer divergência — nunca cobra um valor diferente do que foi
-- mostrado ao pagador.
--
-- ── O que NÃO está aqui, de propósito (Lei 10) ───────────────────────
-- Sem IP, sem User-Agent: o consentimento é evidenciado pelo vínculo
-- com a assinatura (quem aprova só consegue porque tem o link que o
-- CONTRATANTE mandou ao assinante dele — o Checkout nunca fala com o
-- pagador por conta própria, RN-35), não por metadado de rede que este
-- projeto não coleta em nenhum outro lugar do caminho de pagamento.
-- Sem `documento`: `assinatura_id` já é a chave — persistir o documento
-- de novo seria duplicar dado pessoal que já mora em `assinaturas`.

create table if not exists intencoes_troca_plano (
  id uuid primary key default gen_random_uuid(),

  assinatura_id text not null references assinaturas(id),
  contratante_id text references contratantes(id) on delete set null,

  -- O retrato congelado — tudo que a tela mostra e que a aprovação
  -- confere, nunca recalcula.
  plano_id text not null,
  plano_novo_id text not null,
  plano_nome text not null,
  plano_novo_nome text not null,
  ciclo_atual text not null,
  ciclo_novo text not null,
  valor_atual numeric(10,2) not null,
  valor_novo numeric(10,2) not null,
  valor_pago_do_periodo numeric(10,2) not null,
  vencimento_atual timestamptz not null,
  dias_restantes integer not null,
  credito numeric(10,2) not null,
  debito numeric(10,2) not null,
  valor_acerto numeric(10,2) not null,

  -- Controle de concorrência otimista: o `mutation_version` de
  -- `assinaturas` no instante da criação. A aprovação relê o valor
  -- atual e recusa (`STALE`) se divergir — nunca sobrescreve uma
  -- mutação concorrente (cancelar/pausar/retomar/outra troca) às cegas.
  mutation_version_snapshot integer not null,

  -- A máquina de 10 estados do spec. `check` em vez de enum do Postgres:
  -- alterar um enum é operação separada e mais cara; `check` muda numa
  -- migration comum, como o resto do projeto já faz para `status`.
  status text not null default 'PENDING_APPROVAL' check (status in (
    'PENDING_APPROVAL', 'PROCESSING_PAYMENT',
    'PAYMENT_CONFIRMED', 'PAYMENT_DECLINED', 'PAYMENT_UNKNOWN',
    'APPLYING_PLAN', 'COMPLETED',
    'RECONCILIATION_REQUIRED', 'EXPIRED', 'STALE'
  )),

  -- Correlação com a cobrança do acerto — mesma tabela `cobrancas` de
  -- sempre, `metodo_pagamento = 'acerto_troca'` (já existe desde a
  -- 0010); `charge_id` aqui é o atalho para achar a linha sem procurar.
  charge_id text,

  -- Arrendamento curto, só durante a janela ativa aprovação→conclusão
  -- (mesmo papel de `assinaturas.trocando_em`, mas por intenção — duas
  -- aprovações simultâneas do MESMO link não podem cobrar duas vezes).
  aprovando_em timestamptz,

  -- Quantas vezes o sweeper tentou resolver um estado ambíguo antes de
  -- escalonar para `RECONCILIATION_REQUIRED` — ver
  -- `src/services/trocaSweeperService.js`.
  tentativas_sweeper integer not null default 0,

  criada_em timestamptz not null default now(),
  expira_em timestamptz not null,
  aprovada_em timestamptz,
  concluida_em timestamptz
);

-- O sweeper varre por status, a cada 60s — índice parcial, porque a
-- varredura nunca olha `COMPLETED`/`PAYMENT_DECLINED`/`EXPIRED`/`STALE`
-- (estados terminais, e a maioria das linhas termina num deles).
create index if not exists idx_intencoes_troca_status_pendente
  on intencoes_troca_plano(status)
  where status in ('PROCESSING_PAYMENT', 'PAYMENT_UNKNOWN', 'PAYMENT_CONFIRMED', 'APPLYING_PLAN', 'RECONCILIATION_REQUIRED');

-- `/troca/contexto` e `/troca/aprovar` já chegam com o id (o token) —
-- é chave primária, não precisa de índice extra para essas duas rotas.
-- Este índice é para a pergunta que a `assinaturaService` precisa
-- responder antes de reivindicar uma troca nova: "já existe uma
-- intenção pendente para esta assinatura?".
create index if not exists idx_intencoes_troca_assinatura_pendente
  on intencoes_troca_plano(assinatura_id)
  where status = 'PENDING_APPROVAL';

alter table intencoes_troca_plano enable row level security;
-- RLS default-deny (Lei 4): sem policy nenhuma, só o `service_role` (o
-- backend) lê e escreve — mesmo padrão das outras seis tabelas.

comment on table intencoes_troca_plano is
  'Uma troca de plano com acerto a pagar, aguardando (ou já processada) a aprovação explícita do PAGADOR na tela do Checkout. Retrato congelado no momento da criação — a aprovação revalida, nunca recalcula. Spec: docs/specs/2026-09-20-troca-de-plano-redireciona-pagador.md.';

comment on column intencoes_troca_plano.mutation_version_snapshot is
  'O mutation_version de assinaturas no instante em que a intenção foi criada. A aprovação relê o valor atual: divergência vira STALE, nunca recálculo silencioso.';

comment on column intencoes_troca_plano.aprovando_em is
  'Arrendamento curto durante a janela aprovação→conclusão — evita que dois cliques no mesmo link cobrem o acerto duas vezes. NULL é o estado normal.';

-- ── `mutation_version`: a cerca de concorrência otimista em `assinaturas`
--
-- Hoje só a troca de plano usa (via `mutation_version_snapshot` acima);
-- cancelar/pausar/retomar continuam com o desenho de sempre. É um
-- primitivo compartilhado, para adoção incremental — não uma migração
-- de tudo de uma vez (spec, "O que ficou fora da v1").
alter table assinaturas
  add column if not exists mutation_version integer not null default 0;

comment on column assinaturas.mutation_version is
  'Incrementado a cada mutação que participa de controle de concorrência otimista (hoje: só a troca de plano). UPDATE condicional por igualdade — nunca leitura-e-escrita sem comparar.';
