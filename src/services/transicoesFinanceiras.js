/**
 * SAN CHECKOUT v2 — src/services/transicoesFinanceiras.js
 *
 * A MÁQUINA DE ESTADOS FINANCEIRA de uma cobrança (C-03 da auditoria de
 * 24/09/2026). Até aqui, `processarEventoPayment` fazia `if (status ===
 * novo) return; update(novo)` — qualquer evento diferente do atual
 * sobrescrevia, inclusive um `PAYMENT_CONFIRMED` atrasado em cima de um
 * `estornado`, ou um `CASH_UNDONE` em cima de um `chargeback`. Com a
 * Asaas configurada em `SEQUENTIALLY` (medido em 24/09) isso é raro na
 * entrega normal — mas o reprocessamento da inbox, um reenvio manual
 * pelo painel dela e uma reconciliação por `GET` todos podem trazer o
 * passado de volta.
 *
 * O que decide aqui é SEMÂNTICA, não ordem de chegada:
 *
 *  - de cada estado, só sai para o que faz sentido no mundo (uma
 *    cobrança estornada por inteiro não volta a `confirmado`; uma
 *    `chargeback` não vira `vencido`);
 *  - reversão LEGÍTIMA do PSP continua possível: `CASH_UNDONE`
 *    (`confirmado` → `pendente`), estorno negado (volta a
 *    `confirmado`), estorno parcial depois de confirmado;
 *  - o carimbo do evento (`dateCreated`, hora da Asaas) desempata: um
 *    evento mais antigo que o que gravou o status atual não regride
 *    nada, mesmo que a transição fosse permitida.
 *
 * Quem grava é `cobrancaService.aplicarTransicao`, por UPDATE condicional
 * (`where status = <de>`) — dois eventos concorrentes nunca gravam os
 * dois; o perdedor relê e reavalia.
 */

export const STATUS_FINANCEIROS = [
  'pendente', 'em_analise', 'confirmado', 'recusado', 'vencido',
  'cancelado', 'expirado',
  'estorno_solicitado', 'estorno_negado', 'estornado_parcialmente', 'estornado',
  'chargeback',
  // RN-51 (25/09/2026): o pedido foi pago por OUTRA cobrança, e esta foi
  // excluída na Asaas pelo cancelador de irmãs (`irmasObsoletasService`).
  'cancelado_por_outro_pagamento'
];

/** Estados dos quais NADA sai por evento de pagamento. `cancelado` é de
 *  sessão de pop-up abandonada (a cobrança nunca existiu). `expirado`
 *  NÃO está aqui: o prazo local de 65 min pode vencer antes de a
 *  pop-up pagar (a Asaas não nos avisa do `CHECKOUT_EXPIRED` sempre), e
 *  o `PAYMENT_CONFIRMED` que vier depois tem de valer. */
export const STATUS_TERMINAIS = ['estornado', 'cancelado'];

/**
 * De cada estado, para quais outros um evento da Asaas pode levar.
 * `*` não existe de propósito: tudo que não está listado é recusado.
 */
const TRANSICOES = {
  pendente:               ['em_analise', 'confirmado', 'recusado', 'vencido', 'cancelado', 'expirado', 'cancelado_por_outro_pagamento'],
  em_analise:             ['confirmado', 'recusado', 'pendente'],
  confirmado:             ['estorno_solicitado', 'estornado_parcialmente', 'estornado', 'chargeback', 'pendente'],
  recusado:               ['confirmado', 'em_analise', 'cancelado_por_outro_pagamento'], // nova tentativa de captura na mesma cobrança
  vencido:                ['confirmado', 'pendente', 'cancelado_por_outro_pagamento'],   // boleto pago depois do vencimento; prazo estendido
  cancelado:              [],
  expirado:               ['confirmado'],                            // o prazo LOCAL (65 min) venceu, mas a pop-up ainda pagou
  estorno_solicitado:     ['estornado', 'estornado_parcialmente', 'estorno_negado', 'chargeback'],
  estorno_negado:         ['confirmado', 'estorno_solicitado', 'estornado', 'estornado_parcialmente', 'chargeback'], // negado = o pagamento continua válido
  estornado_parcialmente: ['estornado', 'estorno_solicitado', 'chargeback'],
  estornado:              [],
  chargeback:             ['confirmado', 'estornado'],               // disputa vencida devolve ao pago; perdida vira estorno
  /* Só o DINHEIRO sai daqui: se a Asaas ainda assim liquidar esta
     cobrança (o pagador pagou no mesmo instante em que ela era
     excluída), o `PAYMENT_CONFIRMED` tem de valer — é pagamento real, e
     vira duplicidade (RN-52), nunca evento perdido. `CHECKOUT_*` e
     `PAYMENT_OVERDUE` atrasados não passam. */
  cancelado_por_outro_pagamento: ['confirmado']
};

/** A transição `de → para` é permitida pela semântica? Mesmo estado é
 *  "nada a fazer" (idempotente), não erro. */
export function transicaoPermitida(de, para) {
  if (!STATUS_FINANCEIROS.includes(para)) return false;
  if (de === para) return true;
  const saidas = TRANSICOES[de];
  if (!saidas) return false; // status desconhecido no banco: não mexe
  return saidas.includes(para);
}

/**
 * Decide o que fazer com um evento sobre uma cobrança.
 *
 * @param {{ status: string, status_evento_em?: string|null }} cobranca — linha atual
 * @param {string} novoStatus — status local mapeado do evento
 * @param {string|Date|null} ocorridoEm — `dateCreated` do evento
 * @returns {{ acao: 'aplicar'|'ignorar', motivo?: string }}
 */
export function decidirTransicao(cobranca, novoStatus, ocorridoEm = null) {
  const atual = cobranca?.status;
  if (atual === novoStatus) return { acao: 'ignorar', motivo: 'mesmo status (reentrega)' };

  if (!transicaoPermitida(atual, novoStatus)) {
    return { acao: 'ignorar', motivo: `transição ${atual} → ${novoStatus} não é permitida` };
  }

  const carimboAtual = paraData(cobranca?.status_evento_em);
  const carimboNovo = paraData(ocorridoEm);
  if (carimboAtual && carimboNovo && carimboNovo < carimboAtual) {
    return { acao: 'ignorar', motivo: `evento de ${carimboNovo.toISOString()} é anterior ao que gravou "${atual}" (${carimboAtual.toISOString()})` };
  }

  return { acao: 'aplicar' };
}

function paraData(valor) {
  if (!valor) return null;
  const data = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data;
}

/* ------------------------------------------------------------------
   Autoteste — `node src/services/transicoesFinanceiras.js`
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('transicoesFinanceiras.js')) {
  const { strict: assertReal } = await import('node:assert');
  let checagens = 0;
  const assert = new Proxy(assertReal, {
    get(alvo, nome) {
      const valor = alvo[nome];
      if (typeof valor !== 'function') return valor;
      return (...args) => { checagens += 1; return valor.apply(alvo, args); };
    }
  });

  // todo status listado tem linha na matriz, e a matriz só cita status que existem
  for (const s of STATUS_FINANCEIROS) assert.ok(Array.isArray(TRANSICOES[s]), `matriz sem linha para ${s}`);
  for (const [de, paras] of Object.entries(TRANSICOES)) {
    assert.ok(STATUS_FINANCEIROS.includes(de), `matriz cita status desconhecido: ${de}`);
    for (const p of paras) assert.ok(STATUS_FINANCEIROS.includes(p), `matriz cita destino desconhecido: ${p}`);
  }
  for (const t of STATUS_TERMINAIS) assert.deepEqual(TRANSICOES[t], [], `terminal ${t} não pode ter saída`);
  assert.deepEqual(TRANSICOES.expirado, ['confirmado'], 'expirado (prazo LOCAL) ainda aceita a confirmação tardia da pop-up — e só ela');
  assert.ok(transicaoPermitida('estorno_negado', 'confirmado'), 'estorno negado devolve a cobrança a confirmado — não é beco sem saída');

  // o caminho feliz
  assert.ok(transicaoPermitida('pendente', 'confirmado'));
  assert.ok(transicaoPermitida('confirmado', 'estornado'));
  assert.ok(transicaoPermitida('confirmado', 'estornado_parcialmente'));
  assert.ok(transicaoPermitida('estornado_parcialmente', 'estornado'));
  assert.ok(transicaoPermitida('confirmado', 'chargeback'));

  // C-03: o passado não volta
  assert.ok(!transicaoPermitida('estornado', 'confirmado'), 'CONFIRMED atrasado depois de REFUNDED');
  assert.ok(!transicaoPermitida('chargeback', 'pendente'), 'CASH_UNDONE depois de chargeback');
  assert.ok(!transicaoPermitida('estornado', 'pendente'));
  assert.ok(!transicaoPermitida('cancelado', 'confirmado'));
  assert.ok(!transicaoPermitida('expirado', 'estornado'), 'expirado só sai para confirmado (pop-up que pagou depois do prazo local)');

  // reversões legítimas do PSP continuam possíveis
  assert.ok(transicaoPermitida('confirmado', 'pendente'), 'baixa manual desfeita');
  assert.ok(transicaoPermitida('estorno_solicitado', 'estorno_negado'));
  assert.ok(transicaoPermitida('estorno_negado', 'estornado'));
  assert.ok(transicaoPermitida('chargeback', 'confirmado'), 'disputa vencida');
  assert.ok(transicaoPermitida('vencido', 'confirmado'), 'boleto pago depois do vencimento');
  assert.ok(transicaoPermitida('recusado', 'confirmado'), 'nova captura');

  // RN-51: a irmã cancelada só sai para o dinheiro que chegou mesmo assim
  assert.ok(transicaoPermitida('pendente', 'cancelado_por_outro_pagamento'));
  assert.ok(transicaoPermitida('cancelado_por_outro_pagamento', 'confirmado'), 'pagamento real depois da exclusão não se perde');
  assert.ok(!transicaoPermitida('cancelado_por_outro_pagamento', 'vencido'), 'PAYMENT_OVERDUE atrasado não ressuscita a irmã');
  assert.ok(!transicaoPermitida('cancelado_por_outro_pagamento', 'cancelado'), 'CHECKOUT_CANCELED atrasado não troca o motivo');
  assert.ok(!transicaoPermitida('cancelado_por_outro_pagamento', 'pendente'));
  assert.ok(!transicaoPermitida('confirmado', 'cancelado_por_outro_pagamento'), 'NUNCA se cancela cobrança paga');
  assert.ok(!transicaoPermitida('em_analise', 'cancelado_por_outro_pagamento'), 'em análise o pagador já pagou: se confirmar, é duplicidade');

  // idempotência e desconhecidos
  assert.ok(transicaoPermitida('confirmado', 'confirmado'));
  assert.ok(!transicaoPermitida('confirmado', 'pago'), 'destino fora do vocabulário');
  assert.ok(!transicaoPermitida('inventado', 'confirmado'), 'origem fora do vocabulário');

  // decidirTransicao: matriz + carimbo
  assert.deepEqual(decidirTransicao({ status: 'confirmado' }, 'confirmado'), { acao: 'ignorar', motivo: 'mesmo status (reentrega)' });
  assert.equal(decidirTransicao({ status: 'estornado', status_evento_em: null }, 'confirmado').acao, 'ignorar');
  assert.equal(decidirTransicao({ status: 'pendente', status_evento_em: null }, 'confirmado').acao, 'aplicar');
  assert.equal(
    decidirTransicao({ status: 'confirmado', status_evento_em: '2026-09-24T12:00:00Z' }, 'pendente', '2026-09-24T11:59:59Z').acao,
    'ignorar', 'CASH_UNDONE mais antigo que o CONFIRMED que está gravado não regride'
  );
  assert.equal(
    decidirTransicao({ status: 'confirmado', status_evento_em: '2026-09-24T12:00:00Z' }, 'pendente', '2026-09-24T12:00:01Z').acao,
    'aplicar', 'CASH_UNDONE mais novo aplica'
  );
  assert.equal(
    decidirTransicao({ status: 'confirmado', status_evento_em: null }, 'estornado', null).acao,
    'aplicar', 'sem carimbo de nenhum lado, a matriz decide sozinha'
  );
  assert.equal(
    decidirTransicao({ status: 'confirmado', status_evento_em: 'lixo' }, 'estornado', 'lixo').acao,
    'aplicar', 'carimbo ilegível não trava a transição permitida'
  );

  console.log(`transicoesFinanceiras: ${checagens} checagens OK`);
}
