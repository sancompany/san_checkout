-- 0010 — de qual plano a assinatura veio, e quando trocou
--
-- A troca de plano (`POST /api/checkout/trocar-plano`, autorizada pelo
-- dono em 17/09/2026) reescreve três campos da linha de `assinaturas`:
-- `plano_id`, `valor` e `ciclo`. Reescrita sem rastro é o problema que
-- estas duas colunas resolvem.
--
-- ── Por que não bastava a cobrança do acerto ─────────────────────────
-- A troca PARA CIMA deixa rastro sozinha: gera uma cobrança de acerto em
-- `cobrancas`, com data, valor e `plano_id`. A troca PARA BAIXO não
-- gera cobrança nenhuma — por decisão do dono, rebaixamento não cobra e
-- não devolve, só muda o preço no vencimento. Sem estas colunas, esse
-- caso troca o plano de um assinante e não deixa NADA: nem quando, nem
-- de onde veio. Em caminho de dinheiro isso é o suficiente para não
-- conseguir responder "por que este assinante paga R$ 30 num plano de
-- R$ 45", que é a pergunta que chega do contratante.
--
-- ── O que cada uma guarda ────────────────────────────────────────────
-- `plano_anterior_id` — o plano imediatamente anterior, não a cadeia
--   inteira. Duas trocas seguidas sobrescrevem a primeira, e isso é
--   deliberado: o histórico completo, quando for preciso, sai das
--   cobranças; aqui o que se responde é "de onde esta assinatura veio
--   agora". Guardar a cadeia num array pediria uma tabela de histórico,
--   e ninguém pediu por ela ainda.
-- `trocado_em` — quando. NULL significa "nunca trocou de plano", não
--   falta de dado: toda assinatura nasce assim.
--
-- Sem índice: as duas são lidas junto com a linha que já foi localizada
-- pelo índice `idx_assinaturas_contratante_plano_documento`, nunca como
-- filtro de busca.

-- ── `trocando_em`: a guarda contra cobrar o acerto duas vezes ────────
-- A troca cobra dinheiro ANTES de alterar o plano (o acerto confirma, e
-- só então o plano muda — se a ordem fosse a inversa, uma recusa de
-- cartão deixaria o assinante com o plano caro sem ter pagado). Duas
-- chamadas simultâneas da rota, porém, leriam as duas o mesmo estado
-- "não trocou ainda" e cobrariam DUAS vezes o mesmo acerto.
--
-- Esta coluna é o arrendamento (lease) que fecha essa janela: quem vai
-- trocar a reivindica num `update` condicional, que é atômico no
-- Postgres — a segunda chamada não encontra linha para atualizar e
-- recebe 409 sem ter cobrado nada. O prazo é curto (minutos) para que
-- um processo que morra no meio não tranque a assinatura para sempre.
--
-- Guarda de ordem, não dado de negócio: NULL é o estado normal.

alter table assinaturas
  add column if not exists plano_anterior_id text,
  add column if not exists trocado_em timestamptz,
  add column if not exists trocando_em timestamptz;

comment on column assinaturas.plano_anterior_id is
  'Plano imediatamente anterior a uma troca (POST /trocar-plano). NULL = nunca trocou. Guarda só o anterior, não a cadeia — o histórico completo sai de cobrancas.';

comment on column assinaturas.trocado_em is
  'Quando a última troca de plano aconteceu. NULL = nunca trocou; é ausência de evento, não dado faltando.';

comment on column assinaturas.trocando_em is
  'Arrendamento da troca em andamento (POST /trocar-plano): impede que duas chamadas simultâneas cobrem o mesmo acerto duas vezes. NULL é o estado normal.';
