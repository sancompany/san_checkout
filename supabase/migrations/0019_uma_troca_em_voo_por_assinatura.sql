-- =====================================================================
-- 0019 — UMA TROCA DE PLANO EM VOO POR ASSINATURA (25/09/2026)
--
-- SEC-010 da remediação da Estação 6
-- (`docs/SECURITY_STATION_6_REMEDIATION_2026-09-25.md`).
--
-- O furo: nada no banco impedia duas intenções de troca da MESMA
-- assinatura de estarem, ao mesmo tempo, num estado com dinheiro em
-- trânsito. O arrendamento `assinaturas.trocando_em` protege só cinco
-- minutos; um acerto ambíguo (timeout na cobrança do cartão salvo) dura
-- mais que isso. Com o arrendamento vencido, uma segunda aprovação —
-- outro link, ou o contratante pedindo a troca de novo — cobrava um
-- SEGUNDO acerto, e o `PAYMENT_CONFIRMED` do primeiro chegava a uma
-- intenção que não o conhecia.
--
-- A regra: no máximo UMA intenção por assinatura nos estados em que o
-- acerto pode estar sendo cobrado, esperando veredito, aplicando, ou
-- parado à espera de um humano (`RECONCILIATION_REQUIRED` entra: até
-- alguém decidir, ninguém cobra outro acerto dessa assinatura). Links
-- `PENDING_APPROVAL` não entram — nada foi cobrado, e o assinante que
-- mudou de ideia pode receber outro link; é a APROVAÇÃO (a passagem para
-- `PROCESSING_PAYMENT`) que o índice barra, e o código transforma a
-- violação em `STALE` (`trocaIntencaoService.reivindicarProcessamento`).
--
-- Seguro de aplicar: conferido em produção antes (25/09/2026) — zero
-- linhas em `intencoes_troca_plano`, então nenhuma violação pré-existente.
-- `if not exists`: replay é seguro (ensaio de restauração).
-- =====================================================================

create unique index if not exists idx_intencao_troca_uma_em_voo
  on intencoes_troca_plano(assinatura_id)
  where status in ('PROCESSING_PAYMENT', 'PAYMENT_UNKNOWN', 'PAYMENT_CONFIRMED', 'APPLYING_PLAN', 'RECONCILIATION_REQUIRED');

comment on index idx_intencao_troca_uma_em_voo is
  'SEC-010: no máximo uma intenção de troca por assinatura com dinheiro em trânsito. A violação na aprovação vira STALE (nada cobrado).';
