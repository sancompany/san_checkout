-- 0014 — vocabulário fechado no banco para status/método/ciclo
--
-- Achado numa auditoria externa (Codex, 22/09/2026): `cobrancas.status`,
-- `cobrancas.metodo_pagamento`, `assinaturas.status` e `assinaturas.ciclo`
-- são conjuntos FECHADOS — cada um tem um número finito de valores que a
-- aplicação já trata como exaustivo em vários lugares (`mapearStatusPayment`
-- em webhookController.js, `STATUS_ASSINATURA_TODOS` em
-- cobrancaConsultaController.js, `CICLOS_VALIDOS` em
-- asaasCheckoutController.js) — mas nenhum dos quatro tinha `check` no
-- banco. A migration 0009 já aplicou esse mesmo princípio em
-- `cobrancas.ambiente` (lição nº 19, "constraint no banco antes de
-- código na aplicação", skill `construir`); estas quatro colunas
-- ficaram de fora naquele momento.
--
-- ── Os quatro conjuntos, e de onde cada um veio ───────────────────────
-- `cobrancas.status`: TRÊS vocabulários somados, e a primeira versão
-- desta migration errou por confiar só no primeiro — corrigido ANTES de
-- aplicar, comparando contra os valores reais em produção
-- (`select distinct status from cobrancas`), que acusou `expirado`
-- fora do conjunto que a leitura do código sozinha tinha achado.
--   1. `mapearStatusPayment` (VOCABULÁRIO 1, Pix/Boleto direto e ciclo
--      de assinatura): pendente, confirmado, estornado,
--      estorno_solicitado, estorno_negado, vencido, em_analise,
--      recusado, chargeback.
--   2. Eventos de CHECKOUT (VOCABULÁRIO 2, pop-up de Cartão/Assinatura):
--      `CHECKOUT_PAID` → confirmado, `CHECKOUT_CANCELED` → cancelado,
--      `CHECKOUT_EXPIRED` → expirado (`processarEventoCheckout`).
--   3. Eventos de Pix Automático (VOCABULÁRIO 3): confirmado, cancelado
--      (`processarEventoPixAutomatico`) — já cobertos pelos dois acima.
-- Os onze valores abaixo são a união dos três.
--
-- `cobrancas.metodo_pagamento`: os seis valores que aparecem nos
-- pontos de escrita reais (`checkoutController.js`: pix/boleto;
-- `asaasCheckoutController.js`: cartao_credito/assinatura/
-- assinatura_pix; `cobrancaService.js`: acerto_troca, via
-- `METODO_ACERTO_TROCA`). **Não é o mesmo conjunto de
-- `pedidoService.METODOS_VALIDOS`** (`pix/boleto/cartao/assinatura/
-- assinatura_pix`) — aquele é o vocabulário de MÉTODO HABILITADO por
-- contratante (`cartao`, genérico); este é o método de fato GRAVADO
-- numa cobrança (`cartao_credito`, específico). Os dois nomes parecidos
-- e vocabulários diferentes são o próprio motivo de travar cada um no
-- banco — confundir um pelo outro seria exatamente o tipo de erro que
-- só aparece em produção.
--
-- `assinaturas.status`: os três valores de
-- `STATUS_ASSINATURA_TODOS` (cobrancaConsultaController.js).
--
-- `assinaturas.ciclo`: os sete ciclos que a Asaas aceita — TODOS eles,
-- não só os que este projeto usa hoje —, já documentados como o
-- conjunto completo em `CICLOS_VALIDOS` (asaasCheckoutController.js).
--
-- ── Por que aditivo e não recusa ampla ────────────────────────────────
-- Cada `check` só recusa um valor NOVO que ninguém previu — não muda
-- nenhuma linha existente (conferido: as colunas já só têm valores
-- dentro desses conjuntos, verificado contra o banco de produção antes
-- de escrever esta migration).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'cobrancas_status_conhecido'
  ) then
    alter table cobrancas
      add constraint cobrancas_status_conhecido
      check (status in (
        'pendente', 'confirmado', 'estornado', 'estorno_solicitado',
        'estorno_negado', 'vencido', 'em_analise', 'recusado', 'chargeback',
        'cancelado', 'expirado'
      ));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'cobrancas_metodo_pagamento_conhecido'
  ) then
    alter table cobrancas
      add constraint cobrancas_metodo_pagamento_conhecido
      check (metodo_pagamento in (
        'pix', 'boleto', 'cartao_credito', 'assinatura', 'assinatura_pix', 'acerto_troca'
      ));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'assinaturas_status_conhecido'
  ) then
    alter table assinaturas
      add constraint assinaturas_status_conhecido
      check (status in ('ativa', 'pausada', 'cancelada'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'assinaturas_ciclo_conhecido'
  ) then
    alter table assinaturas
      add constraint assinaturas_ciclo_conhecido
      check (ciclo in (
        'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'BIMONTHLY',
        'QUARTERLY', 'SEMIANNUALLY', 'YEARLY'
      ));
  end if;
end $$;

comment on constraint cobrancas_status_conhecido on cobrancas is
  'Vocabulario fechado — uniao de tres vocabularios em webhookController.js: mapearStatusPayment, processarEventoCheckout e processarEventoPixAutomatico. Valor novo aqui e sinal de status novo no codigo antes de decidir aqui.';
comment on constraint cobrancas_metodo_pagamento_conhecido on cobrancas is
  'Vocabulario fechado — NAO e o mesmo conjunto de pedidoService.METODOS_VALIDOS (aquele e metodo HABILITADO por contratante; este e o metodo GRAVADO na cobranca). NULL permitido (coluna e nullable).';
comment on constraint assinaturas_status_conhecido on assinaturas is
  'Vocabulario fechado — mesmo conjunto que STATUS_ASSINATURA_TODOS (cobrancaConsultaController.js).';
comment on constraint assinaturas_ciclo_conhecido on assinaturas is
  'Vocabulario fechado — os sete ciclos que a Asaas aceita (CICLOS_VALIDOS, asaasCheckoutController.js). Coluna e NOT NULL.';
