-- 0006 — ciclo de assinatura gravado na criação, não relaiado por webhook
--
-- Achado em 15/09/2026, verificando o reparo manual da cobrança órfã do
-- mostrai: a assinatura ficou gravada como MONTHLY quando o plano é
-- QUARTERLY. Causa: o código lia `payment.cycle`/`payment.nextDueDate` —
-- campos que, medido no payload real, NÃO EXISTEM em nenhum webhook da
-- Asaas (nem CHECKOUT_PAID, nem PAYMENT_CONFIRMED).
--
-- A correção não foi trocar de campo dentro do webhook — foi parar de
-- depender de webhook pra isto. `ciclo` já é conhecido, validado, no
-- momento em que `criarCheckoutAssinatura` cria a sessão (é o mesmo
-- valor mandado pra Asaas em `subscription.cycle`). `cobrancas.ciclo`
-- grava esse valor ali, na criação — antes de existir qualquer sessão
-- na Asaas, portanto antes de qualquer webhook poder chegar. Zero
-- corrida de ordem entre eventos.
--
-- `proxima_cobranca` fica reservada, mas SEM mecanismo que a preencha
-- nesta migration: o "nextDueDate" que mandamos pra Asaas na criação é
-- a data de HOJE (a cobrança é imediata), não uma projeção real da
-- próxima cobrança — gravar isso seria pior que deixar null, porque
-- pareceria preciso sem ser. Residual declarado, não corrigido
-- (docs/pendencias.md).

alter table cobrancas
  add column if not exists ciclo text,
  add column if not exists proxima_cobranca timestamptz;

comment on column cobrancas.ciclo is
  'Ciclo da assinatura (MONTHLY/QUARTERLY/...), gravado na CRIAÇÃO do checkout (criarCheckoutAssinatura), não por webhook — nenhum evento da Asaas confiavelmente o traz de volta. Lido por webhookController.amarrarAssinaturaACobranca ao criar a linha em assinaturas.';
comment on column cobrancas.proxima_cobranca is
  'Reservada. Sem fonte confiável hoje — não populada por este mecanismo. Ver docs/pendencias.md.';
