/**
 * SAN CHECKOUT v2 — src/services/webhookInboxService.js
 *
 * A INBOX do webhook da Asaas (C-01 da auditoria de 24/09/2026; tabela
 * `webhook_inbox`, migration 0015).
 *
 * O contrato real da Asaas ("Receba eventos do Asaas no seu endpoint de
 * Webhook", docs.asaas.com, lido em 24/09/2026):
 *
 *   "Receber evento → Persistir em fila → Responder HTTP 200 →
 *    Processar regras de negócio."
 *   "Utilize o `id` do evento para identificar reenvios e implementar
 *    idempotência. O mesmo `id` pode ser entregue mais de uma vez."
 *   "Após 15 falhas consecutivas, a fila do Webhook pode ser
 *    interrompida."
 *
 * Então o `200` passa a significar "guardei", e o processamento sai da
 * linha, nunca só da requisição. Se guardar falhar (banco fora), o
 * receptor responde 503 — é o ÚNICO caso em que a reentrega da Asaas é
 * o mecanismo de recuperação, e ela existe para isso. Se processar
 * falhar, a linha fica `falhou` com `proxima_tentativa_em`, e o worker
 * (`reprocessarPendentes`, `server.js`) tenta de novo com recuo — sem
 * depender de a Asaas reenviar e sem a fila dela contar falha.
 *
 * O que fica na linha é o CORPO MÍNIMO: só os campos que o processamento
 * lê. Nada de nome, e-mail, documento, telefone, endereço ou cartão
 * (Lei 10) — o `webhook_eventos` (auditoria, 0002) já fez essa escolha e
 * ela vale aqui pela mesma razão.
 */

import { createHash } from 'node:crypto';
import { supabase } from '../config/supabase.js';

/** Recuo entre tentativas de reprocessamento, em segundos. Depois da
 *  última, a linha fica `falhou` com `proxima_tentativa_em` nulo — visível
 *  no painel, sem tentar para sempre. */
export const RECUOS_S = [30, 120, 600, 1800, 3600, 4 * 3600, 12 * 3600, 24 * 3600];

/**
 * Lista branca do corpo mínimo. Chaves de primeiro nível e, dentro de
 * cada objeto, as chaves que o `webhookController` lê hoje ou que a
 * reconciliação precisa (ids, status, valores, datas, referências).
 * `refunds` entra inteiro (só tem status/valor/data — sem pessoa).
 */
const CORPO_MINIMO = {
  raiz: ['id', 'event', 'dateCreated'],
  payment: [
    'id', 'status', 'value', 'netValue', 'originalValue', 'billingType',
    'subscription', 'checkoutSession', 'externalReference', 'installment',
    'installmentNumber', 'dueDate', 'paymentDate', 'confirmedDate',
    'clientPaymentDate', 'dateCreated', 'deleted', 'refunds', 'cycle', 'nextDueDate'
  ],
  checkout: ['id', 'status', 'externalReference', 'minutesToExpire', 'subscription'],
  subscription: ['id', 'status', 'value', 'cycle', 'nextDueDate', 'deleted', 'externalReference', 'checkoutSession'],
  account: ['id', 'ownerId', 'status', 'general', 'commercialInfo', 'bankAccountInfo', 'documentation'],
  authorization: ['id', 'status', 'externalReference', 'reason', 'subscription'],
  recurring: ['id', 'status', 'externalReference', 'reason']
};

const TETO_TEXTO = 200;

function podar(objeto, permitidas) {
  if (!objeto || typeof objeto !== 'object' || Array.isArray(objeto)) return undefined;
  const saida = {};
  for (const chave of permitidas) {
    if (!(chave in objeto)) continue;
    const valor = objeto[chave];
    if (valor === undefined) continue;
    if (chave === 'refunds' && Array.isArray(valor)) {
      saida.refunds = valor.slice(0, 50).map((r) => ({
        status: texto(r?.status),
        value: numero(r?.value),
        dateCreated: texto(r?.dateCreated)
      }));
      continue;
    }
    if (chave === 'subscription' && valor && typeof valor === 'object') {
      // `checkout.subscription` é objeto ({cycle, nextDueDate}); em
      // `payment.subscription` é o id (string). Os dois cabem.
      saida.subscription = { cycle: texto(valor.cycle), nextDueDate: texto(valor.nextDueDate) };
      continue;
    }
    if (chave === 'externalReference') {
      // Só as referências que NÓS geramos (`reserva-<uuid>`, `troca:<id>`).
      // Cobranças anteriores a 22/09/2026 levavam `<documento>-<timestamp>`
      // — o CPF do pagador —, e um estorno tardio delas gravaria isso aqui.
      if (typeof valor === 'string' && /^(reserva-[0-9a-f-]{36}|troca:[A-Za-z0-9_-]{1,80})$/i.test(valor)) saida[chave] = valor;
      continue;
    }
    if (valor === null || ['string', 'number', 'boolean'].includes(typeof valor)) {
      saida[chave] = typeof valor === 'string' ? valor.slice(0, TETO_TEXTO) : valor;
    }
  }
  return saida;
}

const texto = (v) => (typeof v === 'string' ? v.slice(0, TETO_TEXTO) : null);
const numero = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** O corpo mínimo, redigido por lista branca, pronto para gravar e para
 *  reprocessar. Nunca contém dado de pessoa. */
export function extrairCorpoMinimo(corpo) {
  if (!corpo || typeof corpo !== 'object') return {};
  const saida = podar(corpo, CORPO_MINIMO.raiz) ?? {};
  for (const secao of ['payment', 'checkout', 'subscription', 'account', 'authorization', 'recurring']) {
    const podado = podar(corpo[secao], CORPO_MINIMO[secao]);
    if (podado && Object.keys(podado).length > 0) saida[secao] = podado;
  }
  return saida;
}

/**
 * A chave de idempotência do evento. Com `id` (`evt_…`), é ele; sem, é o
 * hash de (evento + referência + dateCreated + corpo mínimo) — dois
 * envios idênticos colidem, dois eventos diferentes não.
 */
export function impressaoDigitalDoEvento(corpo, corpoMinimo = extrairCorpoMinimo(corpo)) {
  const id = typeof corpo?.id === 'string' && corpo.id ? corpo.id : null;
  if (id) return `asaas:${id}`;
  return `hash:${createHash('sha256').update(JSON.stringify(corpoMinimo)).digest('hex')}`;
}

export function hashDoCorpo(corpoMinimo) {
  return createHash('sha256').update(JSON.stringify(corpoMinimo)).digest('hex');
}

function ocorridoEm(corpo) {
  const bruto = corpo?.dateCreated;
  if (typeof bruto !== 'string') return null;
  // A Asaas manda "2026-09-24 14:03:11" (hora de Brasília, sem fuso) em
  // alguns eventos e ISO em outros. Sem fuso, assume América/São_Paulo
  // (UTC-3) — o que importa aqui é ORDEM entre eventos da mesma origem,
  // e todos vêm no mesmo formato.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(bruto) ? `${bruto.replace(' ', 'T')}-03:00` : bruto;
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? null : data.toISOString();
}

/**
 * Grava o evento. Devolve `{ id, duplicado: false }` na primeira vez e
 * `{ id, duplicado: true }` quando a impressão digital já existia —
 * reentrega da Asaas, que recebe 200 e não é processada de novo.
 * Lança quando o banco recusa (é o que vira 503 no receptor).
 */
export async function registrarNaInbox(corpo, { referenciaTipo, referenciaId } = {}) {
  const corpoMinimo = extrairCorpoMinimo(corpo);
  const impressao = impressaoDigitalDoEvento(corpo, corpoMinimo);

  const { data, error } = await supabase
    .from('webhook_inbox')
    .insert({
      provedor: 'asaas',
      evento_id_provedor: typeof corpo?.id === 'string' ? corpo.id.slice(0, 120) : null,
      impressao_digital: impressao,
      tipo_evento: String(corpo?.event ?? 'DESCONHECIDO').slice(0, 120),
      referencia_tipo: referenciaTipo ?? null,
      referencia_id: referenciaId ?? null,
      ocorrido_em: ocorridoEm(corpo),
      status: 'recebido',
      // O worker (60 s) só olha esta linha se o processamento INLINE não
      // a fechar antes — senão os dois disputam a mesma linha nova.
      proxima_tentativa_em: new Date(Date.now() + FOLGA_INLINE_S * 1000).toISOString(),
      corpo_hash: hashDoCorpo(corpoMinimo),
      corpo_minimo: corpoMinimo
    })
    .select('id')
    .single();

  if (error?.code === '23505') {
    const { data: existente } = await supabase
      .from('webhook_inbox')
      .select('id')
      .eq('impressao_digital', impressao)
      .maybeSingle();
    return { id: existente?.id ?? null, duplicado: true };
  }
  if (error) throw error;
  return { id: data.id, duplicado: false };
}

/** Quanto tempo o processamento inline tem antes de o worker poder
 *  disputar uma linha recém-gravada. */
const FOLGA_INLINE_S = 60;
/** Arrendamento de `processando`: passado isso sem desfecho, o processo
 *  morreu no meio e a linha volta a ser reivindicável. Sem isto uma
 *  queda entre reivindicar e gravar o desfecho deixava a linha
 *  `processando` para sempre — e a reentrega da Asaas recebia 200
 *  como "duplicado" (revisão de 24/09/2026). */
export const MINUTOS_DE_ARRENDAMENTO_INBOX = 5;

/**
 * Reivindica a linha para processar (CAS). Sai de:
 *   - `recebido` — linha nova (o processamento inline do receptor) ou
 *     devolvida à fila de propósito; a qualquer hora;
 *   - `falhou` — SÓ quando o recuo venceu (`proxima_tentativa_em` ≤
 *     agora). Sem esta condição (SEC-023), duas passadas do worker que
 *     listaram a mesma linha se atropelavam: a primeira falhava e agendava
 *     o recuo, a segunda — com a lista velha na mão — reivindicava na hora
 *     e queimava a tentativa seguinte sem recuo nenhum. Linha esgotada
 *     (`proxima_tentativa_em` nulo) nunca é reivindicada: `null ≤ agora`
 *     é falso no Postgres;
 *   - `processando` cujo arrendamento venceu (o processo morreu no meio).
 * `proxima_tentativa_em` faz o papel do arrendamento enquanto a linha está
 * `processando`. Devolve a linha quando esta chamada é a dona; `null`
 * quando outra já pegou ou a linha não está pendente.
 */
export async function reivindicarProcessamento(id, agora = new Date()) {
  const arrendamento = new Date(agora.getTime() + MINUTOS_DE_ARRENDAMENTO_INBOX * 60_000).toISOString();
  const instante = agora.toISOString();
  const { data, error } = await supabase
    .from('webhook_inbox')
    .update({ status: 'processando', proxima_tentativa_em: arrendamento })
    .eq('id', id)
    .or(`status.eq.recebido,and(status.eq.falhou,proxima_tentativa_em.lte.${instante}),and(status.eq.processando,proxima_tentativa_em.lte.${instante})`)
    .select('*');

  if (error) throw error;
  return Array.isArray(data) && data.length === 1 ? data[0] : null;
}

/**
 * A REENTREGA de um evento que FALHOU (SEC-024, 25/09/2026). A Asaas só
 * reenvia o mesmo `id` quando o nosso `200` não chegou — ou quando o
 * operador manda reenviar pelo painel dela, que é exatamente o gesto de
 * quem viu um evento sem efeito e quer recuperá-lo. Até aqui as duas
 * caíam em "duplicado, 200" e a linha `falhou` (esgotada ou no recuo)
 * seguia morta. Agora a reentrega devolve a linha à fila com as
 * tentativas zeradas; quem processa é o receptor, inline, na mesma
 * requisição. Linha `processado`/`ignorado`/`processando` não é tocada:
 * reprocessar o que deu certo não recupera nada.
 * `true` quando reabriu.
 */
export async function reabrirSeFalhou(id) {
  if (!id) return false;
  const { data, error } = await supabase
    .from('webhook_inbox')
    .update({ status: 'recebido', tentativas: 0, proxima_tentativa_em: new Date(Date.now() + FOLGA_INLINE_S * 1000).toISOString() })
    .eq('id', id)
    .eq('status', 'falhou')
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length === 1;
}

/**
 * Os eventos de PAGAMENTO que esgotaram as tentativas — o sinal mais
 * forte de que uma cobrança divergiu da Asaas (JULES-004). Só os dos
 * últimos 14 dias: esgotado mais velho que isso já passou por um humano
 * (está em `erros` desde o dia em que esgotou).
 */
export async function listarEsgotadasDePagamento({ dias = 14, limite = 50 } = {}) {
  const corte = new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('webhook_inbox')
    .select('id, referencia_id')
    .eq('status', 'falhou')
    .is('proxima_tentativa_em', null)
    .eq('referencia_tipo', 'payment')
    .like('tipo_evento', 'PAYMENT_%')
    .gte('recebido_em', corte)
    .order('recebido_em', { ascending: true })
    .limit(limite);
  if (error) throw error;
  return (data ?? []).filter((l) => l.referencia_id).map((l) => ({ id: l.id, chargeId: l.referencia_id }));
}

/**
 * Fecha as linhas esgotadas cuja cobrança o reconciliador acabou de pôr
 * de acordo com a Asaas. Viram `processado` com a nota no `ultimo_erro` —
 * o evento em si nunca foi aplicado, e o painel precisa mostrar isso.
 */
export async function marcarReconciladas(ids) {
  const lista = (Array.isArray(ids) ? ids : []).filter(Boolean);
  if (lista.length === 0) return 0;
  const { data, error } = await supabase
    .from('webhook_inbox')
    .update({ status: 'processado', processado_em: new Date().toISOString(), proxima_tentativa_em: null, ultimo_erro: 'esgotado; cobrança reconciliada pelo estado da Asaas (reconciliador dirigido)' })
    .in('id', lista)
    .eq('status', 'falhou')
    .select('id');
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
}

export async function marcarProcessado(id) {
  const { error } = await supabase
    .from('webhook_inbox')
    .update({ status: 'processado', processado_em: new Date().toISOString(), ultimo_erro: null, proxima_tentativa_em: null })
    .eq('id', id);
  if (error) console.error('[webhookInbox.marcarProcessado]', error.message);
}

/** Evento reconhecido mas sem ramo (`nao_mapeado`): não é falha, não se
 *  reprocessa. */
export async function marcarIgnorado(id) {
  const { error } = await supabase
    .from('webhook_inbox')
    .update({ status: 'ignorado', processado_em: new Date().toISOString(), proxima_tentativa_em: null })
    .eq('id', id);
  if (error) console.error('[webhookInbox.marcarIgnorado]', error.message);
}

/** Falha de processamento: agenda a próxima tentativa pelo recuo, ou
 *  esgota (fica `falhou` sem próxima) depois da última. */
export async function marcarFalha(id, tentativasAtuais, mensagem) {
  const tentativas = (Number(tentativasAtuais) || 0) + 1;
  const recuo = RECUOS_S[tentativas - 1];
  const { error } = await supabase
    .from('webhook_inbox')
    .update({
      status: 'falhou',
      tentativas,
      ultimo_erro: String(mensagem ?? 'erro').slice(0, 500),
      proxima_tentativa_em: recuo === undefined ? null : new Date(Date.now() + recuo * 1000).toISOString()
    })
    .eq('id', id);
  if (error) console.error('[webhookInbox.marcarFalha]', error.message);
  return { tentativas, esgotou: recuo === undefined };
}

/** As linhas cuja hora de tentar chegou — ordem de recebimento, para
 *  preservar a sequência que a Asaas garantiu (`SEQUENTIALLY`). */
export async function listarParaReprocessar({ limite = 50 } = {}) {
  const { data, error } = await supabase
    .from('webhook_inbox')
    .select('*')
    .in('status', ['recebido', 'falhou', 'processando'])
    .lte('proxima_tentativa_em', new Date().toISOString())
    .order('recebido_em', { ascending: true })
    .limit(limite);
  if (error) throw error;
  return data ?? [];
}

/** Painel: as últimas linhas, com filtro opcional por status. */
export async function listarInbox({ limite = 50, status } = {}) {
  let consulta = supabase
    .from('webhook_inbox')
    .select('id, evento_id_provedor, tipo_evento, referencia_tipo, referencia_id, ocorrido_em, recebido_em, status, tentativas, proxima_tentativa_em, ultimo_erro, processado_em')
    .order('recebido_em', { ascending: false })
    .limit(Math.min(Number(limite) || 50, 200));
  if (status) consulta = consulta.eq('status', status);
  const { data, error } = await consulta;
  if (error) throw error;
  return data ?? [];
}

/** Reenfileira TODAS as linhas de uma referência (charge/sessão), inclusive
 *  as já processadas — para quando a linha de `cobrancas` que faltava
 *  acabou de aparecer (reconciliador) e os eventos consumidos antes dela
 *  precisam ser reaplicados. Idempotente por desenho: reprocessar um
 *  evento já aplicado cai em "mesmo status". */
export async function reenfileirarPorReferencia(referenciaId) {
  if (!referenciaId) return 0;
  const { data, error } = await supabase
    .from('webhook_inbox')
    // tentativas zeradas: devolver à fila com o contador cheio esgotava na 1ª falha (SEC-024)
    .update({ status: 'recebido', tentativas: 0, proxima_tentativa_em: new Date().toISOString(), ultimo_erro: null })
    .eq('referencia_id', referenciaId)
    .in('status', ['processado', 'ignorado', 'falhou'])
    .select('id');
  if (error) throw error;
  return Array.isArray(data) ? data.length : 0;
}

/** Sinal operacional para `/api/saude`: quantas linhas estão falhando e
 *  quantas esgotaram. */
export async function resumoInbox() {
  const [{ count: pendentes }, { count: esgotadas }] = await Promise.all([
    supabase.from('webhook_inbox').select('id', { count: 'exact', head: true }).in('status', ['recebido', 'falhou', 'processando']).not('proxima_tentativa_em', 'is', null),
    supabase.from('webhook_inbox').select('id', { count: 'exact', head: true }).eq('status', 'falhou').is('proxima_tentativa_em', null)
  ]);
  return { pendentes: pendentes ?? 0, esgotadas: esgotadas ?? 0 };
}

/** Reenvio administrativo: volta a linha (mesmo id, mesmo corpo) para a
 *  fila, com as tentativas ZERADAS (SEC-024). Sem zerar, a linha que
 *  esgotou as oito voltava com `tentativas = 8`, e a primeira falha do
 *  reprocessamento caía além do fim da tabela de recuos: esgotava na hora,
 *  e o reenvio do painel era uma tentativa só, não uma fila nova. */
export async function reenfileirar(id) {
  const { data, error } = await supabase
    .from('webhook_inbox')
    .update({ status: 'recebido', tentativas: 0, proxima_tentativa_em: new Date().toISOString(), ultimo_erro: null })
    .eq('id', id)
    .in('status', ['falhou', 'ignorado', 'processado'])
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length === 1;
}

/** Expurgo: linhas processadas/ignoradas com mais de 90 dias saem. As
 *  `falhou` esgotadas ficam até alguém olhar. */
export async function expurgarInbox({ dias = 90 } = {}) {
  const corte = new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();
  const { error } = await supabase
    .from('webhook_inbox')
    .delete()
    .in('status', ['processado', 'ignorado'])
    .lt('recebido_em', corte);
  if (error) console.error('[webhookInbox.expurgar]', error.message);
}

/* ------------------------------------------------------------------
   Autoteste — `node src/services/webhookInboxService.js`
   Só a parte pura: lista branca, impressão digital, recuos.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('webhookInboxService.js')) {
  const { strict: assertReal } = await import('node:assert');
  let checagens = 0;
  const assert = new Proxy(assertReal, {
    get(alvo, nome) {
      const valor = alvo[nome];
      if (typeof valor !== 'function') return valor;
      return (...args) => { checagens += 1; return valor.apply(alvo, args); };
    }
  });

  const real = {
    id: 'evt_abc&123', event: 'PAYMENT_CONFIRMED', dateCreated: '2026-09-24 14:03:11',
    payment: {
      id: 'pay_1', status: 'CONFIRMED', value: 99.9, subscription: 'sub_1', checkoutSession: 'chk_1',
      externalReference: 'reserva-0f6b3f1e-9d3c-4b1a-8c6e-2a7d5f9e1b3c', dateCreated: '2026-09-24',
      customer: 'cus_1', description: 'Plano', invoiceUrl: 'https://…',
      creditCard: { creditCardNumber: '1234', creditCardBrand: 'VISA', creditCardToken: 'tok' },
      refunds: [{ status: 'DONE', value: 10, dateCreated: '2026-09-24', extra: 'x' }]
    },
    account: { id: 'acc_1', ownerId: 'own' }
  };
  const minimo = extrairCorpoMinimo(real);

  // o que o processamento lê está lá
  assert.equal(minimo.id, 'evt_abc&123');
  assert.equal(minimo.event, 'PAYMENT_CONFIRMED');
  assert.equal(minimo.payment.id, 'pay_1');
  assert.equal(minimo.payment.subscription, 'sub_1');
  assert.equal(minimo.payment.checkoutSession, 'chk_1');
  assert.equal(minimo.payment.externalReference, 'reserva-0f6b3f1e-9d3c-4b1a-8c6e-2a7d5f9e1b3c');
  // referência que NÃO é nossa (cobrança anterior a 22/09 levava `<documento>-<timestamp>`): fica de fora
  const legado = extrairCorpoMinimo({ event: 'PAYMENT_REFUNDED', payment: { id: 'pay_l', externalReference: '52998224725-1726000000000' } });
  assert.equal(legado.payment.externalReference, undefined, 'CPF numa referência legada nunca entra na inbox');
  assert.equal(extrairCorpoMinimo({ event: 'X', payment: { id: 'p', externalReference: 'troca:int_abc-1' } }).payment.externalReference, 'troca:int_abc-1');
  assert.deepEqual(minimo.payment.refunds, [{ status: 'DONE', value: 10, dateCreated: '2026-09-24' }]);

  // o que é de pessoa ou de cartão NÃO está — nem como chave
  const serializado = JSON.stringify(minimo);
  for (const proibido of ['creditCard', '1234', 'VISA', 'tok', 'customer', 'cus_1', 'invoiceUrl', 'description']) {
    assert.ok(!serializado.includes(proibido), `corpo mínimo vazou "${proibido}"`);
  }
  // controle positivo da varredura acima: o mesmo teste sobre o corpo
  // cru TEM de acusar, senão a checagem não checa nada
  assert.ok(JSON.stringify(real).includes('creditCardNumber'));

  // checkout: subscription é objeto, externalReference fica
  const chk = extrairCorpoMinimo({ event: 'CHECKOUT_PAID', checkout: { id: 'chk_1', status: 'PAID', externalReference: 'reserva-0f6b3f1e-9d3c-4b1a-8c6e-2a7d5f9e1b3c', subscription: { cycle: 'MONTHLY', nextDueDate: '2026-10-01' }, customerData: { cpfCnpj: '123' } } });
  assert.equal(chk.checkout.externalReference, 'reserva-0f6b3f1e-9d3c-4b1a-8c6e-2a7d5f9e1b3c');
  assert.deepEqual(chk.checkout.subscription, { cycle: 'MONTHLY', nextDueDate: '2026-10-01' });
  assert.ok(!JSON.stringify(chk).includes('123'));

  // impressão digital: id vence; sem id, hash do corpo mínimo; dois envios iguais colidem
  assert.equal(impressaoDigitalDoEvento(real), 'asaas:evt_abc&123');
  const semId = { event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_2' } };
  assert.equal(impressaoDigitalDoEvento(semId), impressaoDigitalDoEvento({ ...semId }));
  assert.notEqual(impressaoDigitalDoEvento(semId), impressaoDigitalDoEvento({ event: 'PAYMENT_REFUNDED', payment: { id: 'pay_2' } }));
  assert.ok(impressaoDigitalDoEvento(semId).startsWith('hash:'));
  // corpo com pessoa diferente mas mesmo mínimo → mesma impressão (a
  // pessoa não faz parte da identidade do evento)
  assert.equal(impressaoDigitalDoEvento({ ...semId, payment: { ...semId.payment, customer: 'a' } }), impressaoDigitalDoEvento(semId));

  // corpos degenerados não estouram
  assert.deepEqual(extrairCorpoMinimo(null), {});
  assert.deepEqual(extrairCorpoMinimo('x'), {});
  assert.deepEqual(extrairCorpoMinimo({ payment: 'nao-objeto' }), {});
  assert.equal(extrairCorpoMinimo({ event: 'x'.repeat(1000) }).event.length, TETO_TEXTO);

  // recuos: crescentes e finitos
  for (let i = 1; i < RECUOS_S.length; i += 1) assert.ok(RECUOS_S[i] > RECUOS_S[i - 1]);
  assert.ok(RECUOS_S.length >= 6, 'pelo menos um dia de tentativas');

  console.log(`webhookInboxService: ${checagens} checagens OK`);
}
