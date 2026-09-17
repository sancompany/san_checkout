-- 0008 — quando a cobrança foi confirmada
--
-- A métrica de sucesso é "cobranças **confirmadas** por contratante, por
-- dia" (`docs/funcional.md` §9), e a prontidão operacional exige que ela
-- responda literalmente "quantos ontem?".
--
-- ── O furo, achado em 16/09/2026 ─────────────────────────────────────
-- Não havia coluna nenhuma dizendo QUANDO a cobrança foi confirmada. As
-- duas datas existentes respondem outra pergunta:
--
--   `criado_em`     — quando a cobrança foi GERADA. Serve para uma visão
--                     de coorte ("das geradas ontem, quantas pagaram"),
--                     que é útil e não é a métrica.
--   `atualizado_em` — quando a linha mudou pela última vez, POR QUALQUER
--                     MOTIVO. Ela é tocada por correção de status, por
--                     reparo manual e até pela correção de `ciclo` que
--                     rodou em 16/09. Usá-la como data de confirmação
--                     daria um número que parece certo e anda sozinho.
--
-- Sem esta coluna, "confirmadas ontem" era inrespondível — e a rota
-- respondia "nas últimas 24 h", que é parecido e não é a mesma coisa.
--
-- ── Nulo é informação, não falta ─────────────────────────────────────
-- Linha confirmada ANTES desta migration fica com `confirmado_em` nulo,
-- de propósito: não existe o dado. Preencher com `atualizado_em` seria
-- inventar precisão — exatamente o erro que `proxima_cobranca` evitou em
-- 0006. A rota de métricas conta essas linhas à parte, num campo
-- próprio, em vez de jogá-las num dia qualquer.

alter table cobrancas add column if not exists confirmado_em timestamptz;

-- A consulta da métrica filtra por faixa de `confirmado_em`, então o
-- índice é por ela. Parcial: linha não confirmada não interessa a esta
-- consulta e não precisa ocupar o índice.
create index if not exists idx_cobrancas_confirmado_em
  on cobrancas (confirmado_em desc)
  where confirmado_em is not null;

comment on column cobrancas.confirmado_em is
  'Quando o status virou confirmado. NULL em linha confirmada antes de 16/09/2026 — o dado não existe, e inventá-lo a partir de atualizado_em daria precisão falsa.';
