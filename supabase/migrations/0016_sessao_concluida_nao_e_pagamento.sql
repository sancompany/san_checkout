-- 0016 — `sessao_concluida_em`: a sessão da pop-up fechou, o dinheiro
-- ainda não
--
-- Primeiro pagamento real de assinatura (25/09/2026, 01:26 UTC). A
-- Asaas mandou `CHECKOUT_PAID` e o receptor gravou a cobrança como
-- `confirmado`, com `confirmado_em`. A primeira cobrança da assinatura
-- (`pay_v6f2xr6j98reaxb9`) estava `PENDING` — o cartão NÃO tinha sido
-- cobrado. A tela do checkout mostrou "Assinatura Ativa ✓" e a métrica
-- de sucesso contaria R$ 10,00 que não entraram.
--
-- `CHECKOUT_PAID` diz que o pagador CONCLUIU a sessão hospedada (cartão
-- digitado, assinatura criada) — não que o dinheiro foi capturado. Quem
-- diz isso é `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED`. Por isso a sessão
-- concluída deixa de mexer em `status` e ganha coluna própria: a linha
-- continua `pendente` até o evento de pagamento, e a tela pode dizer
-- "processando" sem mentir "pago".
--
-- Aditiva e anulável: código antigo ignora a coluna. Nulo é "a sessão
-- não foi concluída (ou não é de pop-up)".
alter table cobrancas
  add column if not exists sessao_concluida_em timestamptz;

comment on column cobrancas.sessao_concluida_em is
  'Quando a Asaas avisou CHECKOUT_PAID (sessão da pop-up concluída). NÃO é confirmação financeira — essa é status=confirmado, vinda de PAYMENT_CONFIRMED/RECEIVED. Ver docs/erros/2026-09-25-primeiro-pagamento-real-pix-sem-chave-e-assinatura-com-vencimento-utc.md.';
