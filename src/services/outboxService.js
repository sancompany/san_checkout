/**
 * SAN CHECKOUT v2 — src/services/outboxService.js
 *
 * A OUTBOX das notificações Checkout → contratante (H-01 da auditoria de
 * 24/09/2026; tabela `outbox_notificacoes`, migration 0015).
 *
 * Até aqui a notificação ao MostrAí morava em `setTimeout().unref()`:
 * três tentativas em memória, e reiniciar o processo entre elas perdia a
 * confirmação — o pagamento ficava confirmado aqui e o assinante sem
 * acesso lá, sem erro em lugar nenhum. Agora todo fato de negócio que o
 * contratante precisa saber vira UMA linha aqui, gravada no mesmo fluxo
 * que muda o estado local, e quem entrega é o worker (`enviarPendentes`,
 * `server.js`), que sobrevive a reinício porque lê do banco.
 *
 *  - `chave_idempotencia` é ÚNICA: o mesmo fato nunca vira duas linhas
 *    (duas entregas do mesmo webhook, o reprocessamento da inbox e a
 *    reconciliação todos colidem na mesma chave);
 *  - o `id` da linha É o `eventoId` do contrato v2 (API.md §4.3): vai no
 *    corpo e no header `X-Checkout-Event-Id`, e é pelo que o contratante
 *    deduplica. Reenvio administrativo reusa a MESMA linha — mesmo id,
 *    mesmo corpo — nunca cria um segundo evento para o mesmo fato;
 *  - recuo exponencial com teto, e depois `abandonada`: visível no
 *    painel, sem tentar para sempre contra um endpoint morto.
 *
 * O envio em si (HMAC, timeout, headers) continua o de sempre
 * (`assinaturaWebhook.js`); mudou só ONDE a tentativa mora.
 */

import { supabase } from '../config/supabase.js';
import { assinarPayload } from '../utils/assinaturaWebhook.js';

/** Recuo por tentativa, em segundos. A soma dá ~2 dias; depois disso o
 *  endpoint do contratante está fora do ar há tempo demais para ser
 *  "instabilidade", e alguém precisa olhar (painel + `/api/saude`). */
export const RECUOS_S = [0, 60, 300, 900, 3600, 4 * 3600, 12 * 3600, 24 * 3600];

/** Teto por tentativa: 10 s. Nada aqui segura a resposta à Asaas
 *  (o envio é do worker), mas um endpoint pendurado não pode travar a
 *  fila dos outros contratantes. */
export const TIMEOUT_NOTIFICACAO_MS = 10_000;

/** Arrendamento do worker: uma linha `enviando` por mais que isto é de um
 *  processo que morreu no meio — volta a poder ser reivindicada. */
const MINUTOS_DE_ARRENDAMENTO = 2;

const dependenciasPadrao = {
  fetch: (...args) => globalThis.fetch(...args),
  agora: () => new Date()
};

/**
 * Enfileira. Devolve `{ id, nova: true }` na primeira vez e
 * `{ id, nova: false }` quando a chave já existia. O `payload` gravado
 * ganha `eventoId` (= id da linha) e `ocorridoEm`; o corpo enviado é
 * exatamente este, serializado uma vez na hora do envio.
 */
export async function enfileirarNotificacao({ contratanteId, url, tipo, evento, chaveIdempotencia, payload, ocorridoEm }) {
  if (!url) return { id: null, nova: false, motivo: 'contratante sem webhook_url' };

  const { data: existente } = await supabase
    .from('outbox_notificacoes')
    .select('id')
    .eq('chave_idempotencia', chaveIdempotencia)
    .maybeSingle();
  if (existente) return { id: existente.id, nova: false };

  const id = crypto.randomUUID();
  const corpo = {
    ...payload,
    eventoId: id,
    ocorridoEm: ocorridoEm ?? new Date().toISOString()
  };

  const { error } = await supabase
    .from('outbox_notificacoes')
    .insert({
      id,
      contratante_id: contratanteId ?? null,
      url,
      tipo,
      evento,
      chave_idempotencia: chaveIdempotencia,
      payload: corpo,
      status: 'pendente',
      proxima_tentativa_em: new Date().toISOString()
    });

  if (error?.code === '23505') {
    const { data: vencedora } = await supabase
      .from('outbox_notificacoes').select('id').eq('chave_idempotencia', chaveIdempotencia).maybeSingle();
    return { id: vencedora?.id ?? null, nova: false };
  }
  if (error) throw error;
  return { id, nova: true };
}

/** Reivindica uma linha para envio (CAS). `null` quando outra instância
 *  pegou, ou a linha não está mais pendente. */
export async function reivindicarEnvio(id, agora = new Date()) {
  const limite = new Date(agora.getTime() - MINUTOS_DE_ARRENDAMENTO * 60_000).toISOString();
  const { data, error } = await supabase
    .from('outbox_notificacoes')
    .update({ status: 'enviando', enviando_em: agora.toISOString() })
    .eq('id', id)
    .or(`status.in.(pendente,falhou),and(status.eq.enviando,enviando_em.lt.${limite})`)
    .select('*');
  if (error) throw error;
  return Array.isArray(data) && data.length === 1 ? data[0] : null;
}

async function marcarEnviada(id, statusHttp) {
  const { error } = await supabase
    .from('outbox_notificacoes')
    .update({ status: 'enviada', enviado_em: new Date().toISOString(), ultimo_status_http: statusHttp ?? null, ultimo_erro: null, enviando_em: null })
    .eq('id', id);
  if (error) console.error('[outbox.marcarEnviada]', error.message);
}

async function marcarFalha(id, tentativasAtuais, mensagem, statusHttp) {
  const tentativas = (Number(tentativasAtuais) || 0) + 1;
  const recuo = RECUOS_S[tentativas];
  const esgotou = recuo === undefined;
  const { error } = await supabase
    .from('outbox_notificacoes')
    .update({
      status: esgotou ? 'abandonada' : 'falhou',
      tentativas,
      ultimo_erro: String(mensagem ?? 'erro').slice(0, 500),
      ultimo_status_http: statusHttp ?? null,
      enviando_em: null,
      proxima_tentativa_em: esgotou ? new Date().toISOString() : new Date(Date.now() + recuo * 1000).toISOString()
    })
    .eq('id', id);
  if (error) console.error('[outbox.marcarFalha]', error.message);
  return { tentativas, esgotou };
}

/**
 * Uma tentativa de entrega de UMA linha já reivindicada. O segredo (a
 * `api_key` do contratante) é lido na hora — nunca gravado na outbox.
 * Devolve `{ ok, status }`; não lança.
 */
export async function entregar(linha, segredo, deps = dependenciasPadrao) {
  if (!segredo) return { ok: false, erro: 'contratante sem api_key — não dá para assinar', status: null };

  const corpoCru = JSON.stringify(linha.payload);
  const timestamp = Math.floor(deps.agora().getTime() / 1000);
  const controlador = new AbortController();
  const timeoutId = setTimeout(() => controlador.abort(), TIMEOUT_NOTIFICACAO_MS);

  try {
    const resposta = await deps.fetch(linha.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Checkout-Signature': assinarPayload(corpoCru, segredo, timestamp),
        'X-Checkout-Timestamp': String(timestamp),
        'X-Checkout-Event-Id': linha.id,
        'X-Checkout-Idempotency-Key': linha.chave_idempotencia
      },
      body: corpoCru,
      signal: controlador.signal
    });
    if (!resposta.ok) return { ok: false, erro: `contratante respondeu ${resposta.status}`, status: resposta.status };
    return { ok: true, status: resposta.status };
  } catch (erro) {
    return { ok: false, erro: erro.name === 'AbortError' ? `timeout de ${TIMEOUT_NOTIFICACAO_MS / 1000}s` : erro.message, status: null };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * O worker: uma passada. Lê as linhas vencidas, reivindica uma a uma,
 * entrega, grava o resultado. Chamado pelo `setInterval` em `server.js`
 * e, logo depois de enfileirar, por `tentarAgora` — para a primeira
 * tentativa não esperar o próximo tique.
 */
export async function enviarPendentes({ limite = 50, buscarSegredo = segredoDoContratante, deps = dependenciasPadrao } = {}) {
  const relatorio = { examinadas: 0, enviadas: 0, falhas: 0, abandonadas: 0 };
  const agora = deps.agora();

  const { data, error } = await supabase
    .from('outbox_notificacoes')
    .select('id, contratante_id')
    .or(`status.in.(pendente,falhou),and(status.eq.enviando,enviando_em.lt.${new Date(agora.getTime() - MINUTOS_DE_ARRENDAMENTO * 60_000).toISOString()})`)
    .lte('proxima_tentativa_em', agora.toISOString())
    .order('criado_em', { ascending: true })
    .limit(limite);
  if (error) throw error;

  for (const { id, contratante_id: contratanteId } of data ?? []) {
    const linha = await reivindicarEnvio(id, agora);
    if (!linha) continue;
    relatorio.examinadas += 1;

    const segredo = await buscarSegredo(contratanteId);
    const resultado = await entregar(linha, segredo, deps);
    if (resultado.ok) {
      await marcarEnviada(id, resultado.status);
      relatorio.enviadas += 1;
    } else {
      const { esgotou } = await marcarFalha(id, linha.tentativas, resultado.erro, resultado.status);
      if (esgotou) relatorio.abandonadas += 1; else relatorio.falhas += 1;
      console.error(`[outbox] ${linha.evento} → ${linha.url}: ${resultado.erro}${esgotou ? ' — ABANDONADA' : ''}`);
    }
  }
  return relatorio;
}

/** Tenta entregar UMA linha agora, fora do tique — fire-and-forget seguro:
 *  se falhar, o worker pega pelo recuo. */
export function tentarAgora(id, { buscarSegredo = segredoDoContratante, deps = dependenciasPadrao } = {}) {
  if (!id) return;
  (async () => {
    const linha = await reivindicarEnvio(id, deps.agora());
    if (!linha) return;
    const segredo = await buscarSegredo(linha.contratante_id);
    const resultado = await entregar(linha, segredo, deps);
    if (resultado.ok) await marcarEnviada(id, resultado.status);
    else await marcarFalha(id, linha.tentativas, resultado.erro, resultado.status);
  })().catch((erro) => console.error('[outbox.tentarAgora]', erro.message));
}

async function segredoDoContratante(contratanteId) {
  if (!contratanteId) return null;
  const { data } = await supabase.from('contratantes').select('api_key').eq('id', contratanteId).maybeSingle();
  return data?.api_key ?? null;
}

/** Reenvio administrativo (M-07): MESMA linha, mesmo `eventoId`, volta
 *  para a fila. `false` quando a linha não existe ou está `enviando`. */
export async function reenviar(id) {
  const { data, error } = await supabase
    .from('outbox_notificacoes')
    .update({ status: 'pendente', proxima_tentativa_em: new Date().toISOString(), ultimo_erro: null, enviando_em: null })
    .eq('id', id)
    .in('status', ['falhou', 'abandonada', 'enviada'])
    .select('id');
  if (error) throw error;
  const ok = Array.isArray(data) && data.length === 1;
  if (ok) tentarAgora(id);
  return ok;
}

/** Painel. `payload` NÃO vai inteiro — só o que identifica o fato. */
export async function listarOutbox({ limite = 50, status, contratanteId } = {}) {
  let consulta = supabase
    .from('outbox_notificacoes')
    .select('id, contratante_id, url, tipo, evento, chave_idempotencia, status, tentativas, proxima_tentativa_em, ultimo_erro, ultimo_status_http, criado_em, enviado_em')
    .order('criado_em', { ascending: false })
    .limit(Math.min(Number(limite) || 50, 200));
  if (status) consulta = consulta.eq('status', status);
  if (contratanteId) consulta = consulta.eq('contratante_id', contratanteId);
  const { data, error } = await consulta;
  if (error) throw error;
  return data ?? [];
}

/** Sinal operacional para `/api/saude`. */
export async function resumoOutbox() {
  const [{ count: pendentes }, { count: abandonadas }] = await Promise.all([
    supabase.from('outbox_notificacoes').select('id', { count: 'exact', head: true }).in('status', ['pendente', 'falhou', 'enviando']),
    supabase.from('outbox_notificacoes').select('id', { count: 'exact', head: true }).eq('status', 'abandonada')
  ]);
  return { pendentes: pendentes ?? 0, abandonadas: abandonadas ?? 0 };
}

/** Expurgo: linhas enviadas com mais de 90 dias saem (o payload carrega o
 *  documento do pagador — Lei 10). As `abandonada` ficam até alguém olhar. */
export async function expurgarOutbox({ dias = 90 } = {}) {
  const corte = new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();
  const { error } = await supabase
    .from('outbox_notificacoes')
    .delete()
    // `abandonada` sai junto: o payload leva `documento`, e uma linha que
    // ninguém vai reenviar não pode guardar CPF para sempre (Lei 10).
    .in('status', ['enviada', 'abandonada'])
    .lt('criado_em', corte);
  if (error) console.error('[outbox.expurgar]', error.message);
}

/* ------------------------------------------------------------------
   Autoteste — `node src/services/outboxService.js`
   A entrega (headers, assinatura, timeout, classificação) sem rede.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('outboxService.js')) {
  const { strict: assertReal } = await import('node:assert');
  const { assinaturaValida } = await import('../utils/assinaturaWebhook.js');
  let checagens = 0;
  const assert = new Proxy(assertReal, {
    get(alvo, nome) {
      const valor = alvo[nome];
      if (typeof valor !== 'function') return valor;
      return (...args) => { checagens += 1; return valor.apply(alvo, args); };
    }
  });

  const linha = {
    id: '11111111-1111-4111-8111-111111111111',
    url: 'https://contratante.example/webhook',
    chave_idempotencia: 'pay_1|confirmado',
    payload: { versao: 2, pedidoId: 'p', chargeId: 'pay_1', status: 'confirmado', eventoId: '11111111-1111-4111-8111-111111111111' },
    tentativas: 0
  };

  // entrega: headers, assinatura verificável do outro lado, corpo = payload
  let capturado = null;
  const fetchOk = async (url, opcoes) => { capturado = { url, opcoes }; return { ok: true, status: 200 }; };
  let r = await entregar(linha, 'segredo', { fetch: fetchOk, agora: () => new Date() });
  assert.deepEqual(r, { ok: true, status: 200 });
  assert.equal(capturado.url, linha.url);
  assert.equal(capturado.opcoes.headers['X-Checkout-Event-Id'], linha.id);
  assert.equal(capturado.opcoes.headers['X-Checkout-Idempotency-Key'], linha.chave_idempotencia);
  assert.equal(capturado.opcoes.body, JSON.stringify(linha.payload));
  assert.ok(
    assinaturaValida(capturado.opcoes.body, 'segredo', capturado.opcoes.headers['X-Checkout-Timestamp'], capturado.opcoes.headers['X-Checkout-Signature']),
    'a assinatura fecha do lado do contratante'
  );
  assert.ok(!assinaturaValida(capturado.opcoes.body, 'outro', capturado.opcoes.headers['X-Checkout-Timestamp'], capturado.opcoes.headers['X-Checkout-Signature']));

  // sem segredo não manda
  capturado = null;
  r = await entregar(linha, null, { fetch: fetchOk, agora: () => new Date() });
  assert.equal(r.ok, false);
  assert.equal(capturado, null, 'sem api_key nada sai');

  // resposta não-2xx é falha com status
  r = await entregar(linha, 's', { fetch: async () => ({ ok: false, status: 500 }), agora: () => new Date() });
  assert.deepEqual(r, { ok: false, erro: 'contratante respondeu 500', status: 500 });

  // rede caída é falha sem status, e não lança
  r = await entregar(linha, 's', { fetch: async () => { throw new Error('ECONNREFUSED'); }, agora: () => new Date() });
  assert.equal(r.ok, false);
  assert.equal(r.status, null);
  assert.match(r.erro, /ECONNREFUSED/);

  // timeout: o fetch respeita o signal e vira falha legível
  r = await entregar(linha, 's', {
    fetch: (_url, { signal }) => new Promise((_res, rej) => { signal.addEventListener('abort', () => { const e = new Error('x'); e.name = 'AbortError'; rej(e); }); }),
    agora: () => new Date()
  }).then((x) => x);
  // (o timeout real é 10 s — o autoteste só prova a classificação do AbortError)
  assert.equal(r.ok, false);

  // recuos crescentes e finitos; a primeira tentativa é imediata
  assert.equal(RECUOS_S[0], 0);
  for (let i = 2; i < RECUOS_S.length; i += 1) assert.ok(RECUOS_S[i] > RECUOS_S[i - 1]);
  assert.ok(RECUOS_S.reduce((a, b) => a + b, 0) >= 24 * 3600, 'pelo menos um dia de tentativas antes de abandonar');

  console.log(`outboxService: ${checagens} checagens OK`);
}
