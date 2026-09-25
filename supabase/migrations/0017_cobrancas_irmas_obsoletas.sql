-- 0017 — o primeiro pagamento de um pedido torna as cobranças irmãs
-- obsoletas (RN-51), e dois pagamentos reais do mesmo pedido ficam
-- marcados como duplicidade (RN-52)
--
-- O PR #47 (RN-04.1) fechou a porta da FRENTE: pedido que o nosso banco
-- sabe pago não abre para uma cobrança nova. Ficou aberta a de TRÁS: o
-- comprador gera um Pix (ou boleto), não paga, volta e paga no cartão —
-- e o Pix/boleto antigo, já emitido, continua pagável fora do Checkout,
-- no app do banco, por dias. Nada do nosso lado o invalidava.
--
-- A regra: quando uma cobrança de um pedido liquida, as irmãs ainda
-- pagáveis daquele mesmo (contratante, pedido) viram OBSOLETAS — o
-- cancelador (`irmasObsoletasService.js`) exclui cada uma na Asaas e só
-- DEPOIS de a Asaas confirmar grava o status novo. Falha na Asaas não
-- é ignorada nem repetida sem fim: a tentativa fica gravada aqui, com
-- recuo e teto.
--
-- Tudo aditivo: colunas anuláveis (ou com default), e um valor a mais
-- no vocabulário fechado de `status`. Código antigo ignora as colunas.

-- Um `alter` por coluna, de propósito: o autoteste do expurgo
-- (`expurgoService.js`, checagem 0) lê as migrations procurando
-- `alter table cobrancas add column if not exists <nome>`, e um `alter`
-- com vários `add` esconderia do retrato todas menos a primeira.
alter table cobrancas add column if not exists obsoleta_por_charge_id text;
alter table cobrancas add column if not exists obsoleta_desde timestamptz;
alter table cobrancas add column if not exists cancelamento_tentativas integer not null default 0;
alter table cobrancas add column if not exists cancelamento_proxima_em timestamptz;
alter table cobrancas add column if not exists cancelamento_ultimo_erro text;
alter table cobrancas add column if not exists pagamento_duplicado_em timestamptz;
alter table cobrancas add column if not exists pagamento_duplicado_com text[];

comment on column cobrancas.obsoleta_por_charge_id is
  'charge_id da cobrança IRMÃ (mesmo contratante + pedido) cujo pagamento tornou esta obsoleta. Preenchida só enquanto esta ainda era pagável; o cancelamento na Asaas é do cancelador (RN-51).';
comment on column cobrancas.obsoleta_desde is
  'Quando esta cobrança foi marcada obsoleta por outro pagamento do mesmo pedido.';
comment on column cobrancas.cancelamento_tentativas is
  'Quantas vezes o cancelador tentou invalidar esta cobrança na Asaas. Teto em irmasObsoletasService.MAX_TENTATIVAS — esgotado, vira linha em `erros` e para de tentar.';
comment on column cobrancas.cancelamento_proxima_em is
  'Arrendamento E recuo do cancelador: a próxima tentativa só acontece a partir daqui. NULL com obsoleta_desde preenchido = esgotou (ou terminou).';
comment on column cobrancas.cancelamento_ultimo_erro is
  'Última falha ao invalidar na Asaas (mensagem da Asaas/da rede, sem dado de pagador).';
comment on column cobrancas.pagamento_duplicado_em is
  'Quando se detectou que OUTRA cobrança do mesmo pedido também liquidou (RN-52). Os dois pagamentos são reais e ficam; um deles precisa ser estornado pelo fluxo de estorno.';
comment on column cobrancas.pagamento_duplicado_com is
  'charge_id(s) das outras cobranças do mesmo pedido que também liquidaram.';

-- O cancelador lê por aqui: linhas obsoletas com tentativa vencida.
create index if not exists idx_cobrancas_cancelamento_pendente
  on cobrancas(cancelamento_proxima_em)
  where obsoleta_desde is not null and cancelamento_proxima_em is not null;

-- O status novo entra no vocabulário fechado (0014 → 0015 → aqui).
alter table cobrancas drop constraint if exists cobrancas_status_conhecido;
alter table cobrancas add constraint cobrancas_status_conhecido check (
  status in (
    'pendente', 'confirmado', 'estornado', 'estornado_parcialmente',
    'estorno_solicitado', 'estorno_negado', 'vencido', 'em_analise',
    'recusado', 'chargeback', 'cancelado', 'expirado',
    'cancelado_por_outro_pagamento'
  )
);

comment on constraint cobrancas_status_conhecido on cobrancas is
  'Vocabulario fechado — uniao dos vocabularios em webhookController.js (mapearStatusPayment, processarEventoCheckout, processarEventoPixAutomatico) e do cancelador de irmas (irmasObsoletasService.js, cancelado_por_outro_pagamento). Valor novo aqui e sinal de status novo no codigo antes de decidir aqui.';
