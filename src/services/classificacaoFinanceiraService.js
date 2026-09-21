/**
 * SAN CHECKOUT v2 — src/services/classificacaoFinanceiraService.js
 * O classificador financeiro CANÔNICO para a aprovação de troca de
 * plano (`docs/specs/2026-09-20-troca-de-plano-redireciona-pagador.md`).
 *
 * ── Por que um arquivo novo, e não uma terceira lista ────────────────
 * Já existem DUAS fontes que classificam pagamento: `STATUS_ACERTO_PAGO`
 * (`asaasService.js`, resposta síncrona do `POST /v3/payments`) e
 * `mapearStatusPayment` (`webhookController.js`, evento assíncrono).
 * Uma terceira lista aqui seria a mesma falha que `CONSTRAINTS.md` §2.2
 * existe para impedir — duas cópias do mesmo conjunto fechado que
 * podem desincronizar. Este módulo não lista nada: ele CHAMA as duas
 * fontes existentes e devolve um veredito comum.
 *
 * ── O terceiro veredito é o que muda a rota de hoje ──────────────────
 * A rota síncrona de troca de plano (`trocaPlanoController.js`, até
 * 18/09/2026) trata "qualquer status que não seja `CONFIRMED`/
 * `RECEIVED`" como recusa definitiva, na hora. Isso supõe que a
 * resposta síncrona de um cartão recusado É distinguível de "ainda
 * processando" — e essa suposição nunca foi medida por escrito.
 *
 * ⚠️ `nao-conferido`: consultada a documentação pública da Asaas em
 * 21/09/2026 (via busca assistida, não pela leitura direta que este
 * projeto normalmente faz). O enum documentado de `status` de pagamento
 * (`PaymentGetResponsePaymentStatus`) NÃO tem nenhum valor do tipo
 * `REFUSED`/`DECLINED`. Isso é compatível com a recusa síncrona vindo
 * como algo ambíguo (ex.: `PENDING`) até o webhook confirmar o
 * resultado real — mas não foi medido ao vivo contra o sandbox com um
 * cartão de teste de recusa. Conferir antes de relaxar a regra abaixo
 * ("nunca `DECLINED_FINAL` a partir de status síncrono sozinho"); não
 * bloqueia esta construção porque o desenho não depende de relaxá-la.
 *
 * Por isso o veredito default é **`UNKNOWN`**, nunca `DECLINED_FINAL` —
 * quem chama trata isso como "ainda não sei", não como "recusado". É o
 * que dirige a máquina de estados da intenção de troca para
 * `PAYMENT_UNKNOWN` em vez de fechar em `PAYMENT_DECLINED` cedo demais.
 */

import { STATUS_ACERTO_PAGO } from './asaasService.js';
import { mapearStatusPayment } from '../controllers/webhookController.js';

/**
 * @param {{ status?: string|null, evento?: string|null }} sinal
 *   `status` é o campo `status` de uma resposta síncrona de
 *   `POST /v3/payments` (ex.: `cobrarNoCartaoSalvo`). `evento` é o
 *   `event` de um webhook da Asaas. Os dois podem vir juntos (o
 *   chamador sabe qual tem prioridade); nenhum dos dois é obrigatório.
 * @returns {'PAID'|'DECLINED_FINAL'|'UNKNOWN'}
 */
export function classificarPagamentoDoAcerto({ status = null, evento = null } = {}) {
  if (status && STATUS_ACERTO_PAGO.includes(status)) return 'PAID';

  if (evento) {
    const local = mapearStatusPayment(evento);
    if (local === 'confirmado') return 'PAID';
    /* Só o evento de recusa DEFINITIVA vira DECLINED_FINAL — não
       `em_analise` (ainda em curso) nem `chargeback`/`estorno_*`
       (o dinheiro já tinha sido confirmado antes; não é o caso de uma
       aprovação de troca que ainda está tentando confirmar). */
    if (local === 'recusado') return 'DECLINED_FINAL';
  }

  return 'UNKNOWN';
}

/* ------------------------------------------------------------------
   Autoteste — `node src/services/classificacaoFinanceiraService.js`
   Puro: não toca rede nem banco. O que se trava aqui é o VEREDITO, não
   os enums de origem (cada um já tem o autoteste dele).
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('classificacaoFinanceiraService.js')) {
  const { strict: assert } = await import('node:assert');
  let checagens = 0;
  const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

  conferir(classificarPagamentoDoAcerto({ status: 'CONFIRMED' }) === 'PAID', 'status CONFIRMED é PAID');
  conferir(classificarPagamentoDoAcerto({ status: 'RECEIVED' }) === 'PAID', 'status RECEIVED é PAID');
  conferir(classificarPagamentoDoAcerto({ evento: 'PAYMENT_CONFIRMED' }) === 'PAID', 'evento PAYMENT_CONFIRMED é PAID');
  conferir(classificarPagamentoDoAcerto({ evento: 'PAYMENT_RECEIVED' }) === 'PAID', 'evento PAYMENT_RECEIVED é PAID');

  conferir(
    classificarPagamentoDoAcerto({ evento: 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED' }) === 'DECLINED_FINAL',
    'evento de captura recusada é DECLINED_FINAL'
  );
  conferir(
    classificarPagamentoDoAcerto({ evento: 'PAYMENT_REPROVED_BY_RISK_ANALYSIS' }) === 'DECLINED_FINAL',
    'evento de reprovação por antifraude é DECLINED_FINAL'
  );

  /* O CORAÇÃO DA MUDANÇA: status síncrono que não é PAID nunca vira
     DECLINED_FINAL sozinho — o furo pré-existente que este módulo
     corrige era tratar isto como recusa na hora. */
  for (const status of ['PENDING', 'AWAITING_RISK_ANALYSIS', 'OVERDUE', null, undefined, 'ALGO_INEDITO']) {
    conferir(
      classificarPagamentoDoAcerto({ status }) === 'UNKNOWN',
      `status "${status}" sozinho, sem evento, é UNKNOWN — nunca recusa definitiva por suposição`
    );
  }

  /* PAYMENT_AUTHORIZED é o evento de captura MANUAL (com CVV) — este
     projeto não tem esse fluxo (CONSTRAINTS.md §1.1/§1.2). Se chegar
     por engano de configuração, tratar como recusa seria pior que
     tratar como ambíguo — por isso cai no default, não numa lista de
     recusa. */
  conferir(
    classificarPagamentoDoAcerto({ evento: 'PAYMENT_AUTHORIZED' }) === 'UNKNOWN',
    'PAYMENT_AUTHORIZED (captura manual, sem uso neste projeto) é UNKNOWN, nunca DECLINED_FINAL'
  );

  conferir(
    classificarPagamentoDoAcerto({ evento: 'PAYMENT_AWAITING_RISK_ANALYSIS' }) === 'UNKNOWN',
    'em análise não é recusa nem confirmação — fica UNKNOWN'
  );
  conferir(
    classificarPagamentoDoAcerto({ evento: 'PAYMENT_REFUNDED' }) === 'UNKNOWN',
    'estorno não é o veredito desta função — quem decide o que fazer com isso é quem chama'
  );
  conferir(classificarPagamentoDoAcerto() === 'UNKNOWN', 'sem status nem evento nenhum: UNKNOWN, nunca PAID por omissão');
  conferir(classificarPagamentoDoAcerto({}) === 'UNKNOWN', 'objeto vazio: UNKNOWN');

  /* status ganha de evento quando os dois vêm juntos e o status já
     confirma — não precisa olhar o evento. */
  conferir(
    classificarPagamentoDoAcerto({ status: 'CONFIRMED', evento: 'PAYMENT_CREATED' }) === 'PAID',
    'status PAID decide sozinho, mesmo com evento não mapeado junto'
  );

  console.log(`classificacaoFinanceiraService: ${checagens} checagens OK`);
}
