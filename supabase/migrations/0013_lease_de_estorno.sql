-- 0013 — `estornando_em`: a guarda contra estornar a mesma cobrança
-- duas vezes, e contra estornar o que não está confirmado
--
-- Achado numa auditoria externa (Codex, 22/09/2026, sem acesso a este
-- repositório), confirmado lendo o código: `refundController.estornar`
-- ia direto de `buscarCobrancaPorPedido` para `estornarCobranca` na
-- Asaas, sem checar `status` nenhum. Duas consequências reais:
--
--   1. Duas chamadas simultâneas de `POST /estornar` para o mesmo
--      pedido leriam as duas a mesma cobrança `confirmado` e as DUAS
--      chamariam a Asaas pra estornar — o mesmo dinheiro devolvido
--      duas vezes, ou uma segunda chamada batendo num estado que a
--      Asaas já mudou por baixo.
--   2. Nada impedia estornar uma cobrança que não está `confirmado`:
--      `pendente` (nunca foi paga), `estornado` (já estornada) ou
--      `estorno_solicitado` (estorno de boleto já em andamento) —
--      todas aceitas do mesmo jeito, porque `buscarCobrancaPorPedido`
--      devolve a linha mais recente sem filtro de status.
--
-- Mesmo padrão já usado em `assinaturas.trocando_em` (migration 0010):
-- um `update` condicional é atômico no Postgres, então só uma chamada
-- encontra linha pra atualizar — a outra recebe zero linhas e sabe que
-- perdeu a corrida, sem ter chamado a Asaas. A condição
-- `status = 'confirmado'` no MESMO update fecha os dois problemas de
-- uma vez: reivindicar exige que a cobrança esteja no único estado que
-- pode ser estornado.
--
-- Prazo curto (mesmos 5 minutos de `trocando_em`) pela mesma razão: um
-- processo que morra entre reivindicar e chamar a Asaas não pode
-- trancar a cobrança pra sempre — depois do prazo, uma nova tentativa
-- reivindica de novo.
alter table cobrancas
  add column if not exists estornando_em timestamptz;

comment on column cobrancas.estornando_em is
  'Arrendamento (lease) contra estornar a mesma cobrança duas vezes — ver refundController.js e cobrancaService.reivindicarEstorno. NULL = livre.';
