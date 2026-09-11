/**
 * SAN CHECKOUT v2 — src/services/pedidoService.js
 * O coração do modelo pull (ver INTEGRACAO.md seção 3): o checkout
 * nunca guarda catálogo — liga de volta pra API do próprio contratante
 * pra saber o que está sendo vendido e por quanto.
 */

import { supabase } from '../config/supabase.js';

const TIMEOUT_MS = 45000; // calibrado pro pior cold start de hospedagem gratuita

/**
 * `assinatura_pix` (Pix Automático) entrou depois e NÃO está no default
 * do `create table` — então contratante já cadastrado fica sem ele até
 * alguém marcar no admin. Isso é de propósito: o recurso depende de a
 * Asaas ter habilitado Pix Automático na conta, então tem que ser
 * opt-in consciente, não algo que liga sozinho e falha na cara do
 * comprador.
 */
export const METODOS_VALIDOS = ['pix', 'boleto', 'cartao', 'assinatura', 'assinatura_pix'];

/** `metodos_habilitados` nulo (linha antiga, antes da migração) libera
 *  tudo — mesmo default do `create table` novo, só reforçado aqui pra
 *  não travar contratante nenhum silenciosamente. */
function metodoHabilitado(contratante, metodo) {
  const lista = contratante.metodos_habilitados;
  if (!Array.isArray(lista)) return true;
  return lista.includes(metodo);
}

function exigirMetodoHabilitado(contratante, metodoRequerido) {
  if (!metodoRequerido) return;
  if (metodoHabilitado(contratante, metodoRequerido)) return;
  const erro = new Error(`Este contratante não aceita pagamento por ${metodoRequerido}.`);
  erro.status = 403;
  throw erro;
}

/**
 * Menor tamanho aceito pra um id só de dígitos. Abaixo disso o id é
 * sequencial na prática, e sequencial é enumerável.
 *
 * O motivo: a rota que resolve um pedido é PÚBLICA por necessidade — o
 * comprador precisa dela antes de existir qualquer autenticação. Se o
 * contratante usar id `1`, `2`, `3`, qualquer pessoa varre
 * `?c=parceiro&pedido=N` e lê valor, itens e os dados do pagador que
 * vierem pré-preenchidos. A defesa não pode ser a rota (ela tem que ser
 * aberta), então é o id: precisa ser impossível de adivinhar.
 *
 * Id longo só de dígitos (timestamp, por exemplo) passa; qualquer id
 * com letra passa. `INTEGRACAO.md` registra isso como obrigação do
 * contratante.
 */
const MINIMO_DIGITOS_ID = 8;

function exigirIdImprevisivel(id, rotulo) {
  const texto = String(id ?? '');
  const soDigitos = /^\d+$/.test(texto);
  if (!soDigitos || texto.length >= MINIMO_DIGITOS_ID) return;

  const erro = new Error(
    `O ${rotulo} "${texto}" é sequencial e por isso adivinhável — o checkout recusa ids assim. ` +
    'Use um identificador imprevisível (UUID, hash ou similar). Ver INTEGRACAO.md, seção 2.'
  );
  erro.status = 400;
  throw erro;
}

/** Busca o cadastro do contratante no Supabase (nunca por API pública). */
export async function buscarContratante(contratanteId) {
  const { data, error } = await supabase
    .from('contratantes')
    .select('*')
    .eq('id', contratanteId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Busca o contratante pela api_key — usado pra autenticar o /estornar. */
export async function buscarContratantePorChave(apiKey) {
  const { data, error } = await supabase
    .from('contratantes')
    .select('*')
    .eq('api_key', apiKey)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Liga pra API do contratante e busca os dados reais do pedido.
 * @returns {Promise<object>} o pedido, como veio da API do contratante
 * @throws {Error} com .status 404/502/504 conforme a falha
 */
export async function resolverPedido(contratanteId, pedidoId, { metodoRequerido } = {}) {
  exigirIdImprevisivel(pedidoId, 'pedidoId');

  const contratante = await buscarContratante(contratanteId);
  if (!contratante) {
    const erro = new Error('Contratante não encontrado.');
    erro.status = 404;
    throw erro;
  }
  exigirMetodoHabilitado(contratante, metodoRequerido);

  const controlador = new AbortController();
  const timeoutId = setTimeout(() => controlador.abort(), TIMEOUT_MS);

  let resposta;
  try {
    resposta = await fetch(`${contratante.api_base_url}/pedido/${pedidoId}`, {
      method: 'GET',
      headers: { 'X-Checkout-Key': contratante.api_key },
      signal: controlador.signal
    });
  } catch (erroFetch) {
    const erro = new Error('Não foi possível carregar os dados do pedido, tente novamente.');
    erro.status = 504;
    throw erro;
  } finally {
    clearTimeout(timeoutId);
  }

  if (resposta.status === 404) {
    const erro = new Error('Pedido não encontrado.');
    erro.status = 404;
    throw erro;
  }

  if (!resposta.ok) {
    const erro = new Error('Não foi possível carregar os dados do pedido, tente novamente.');
    erro.status = 502;
    throw erro;
  }

  const pedido = await resposta.json();

  if (pedido.status === 'pago' || pedido.status === 'cancelado') {
    const erro = new Error(`Este pedido já está com status "${pedido.status}".`);
    erro.status = 409;
    erro.pedido = pedido;
    throw erro;
  }

  if (pedido.expiraEm && new Date(pedido.expiraEm) < new Date()) {
    const erro = new Error('Este pedido expirou.');
    erro.status = 409;
    erro.pedido = pedido;
    throw erro;
  }

  return { contratante, pedido };
}

/**
 * Equivalente a `resolverPedido`, mas pra Assinatura — ver
 * INTEGRACAO.md seção 6.1. Sem conceito de status/expiraEm (plano não
 * é um pedido com ciclo de vida, é só a definição de um produto
 * recorrente).
 */
export async function resolverPlano(contratanteId, planoId, { metodoRequerido } = {}) {
  exigirIdImprevisivel(planoId, 'planoId');

  const contratante = await buscarContratante(contratanteId);
  if (!contratante) {
    const erro = new Error('Contratante não encontrado.');
    erro.status = 404;
    throw erro;
  }
  exigirMetodoHabilitado(contratante, metodoRequerido);

  const controlador = new AbortController();
  const timeoutId = setTimeout(() => controlador.abort(), TIMEOUT_MS);

  let resposta;
  try {
    resposta = await fetch(`${contratante.api_base_url}/plano/${planoId}`, {
      method: 'GET',
      headers: { 'X-Checkout-Key': contratante.api_key },
      signal: controlador.signal
    });
  } catch {
    const erro = new Error('Não foi possível carregar os dados do plano, tente novamente.');
    erro.status = 504;
    throw erro;
  } finally {
    clearTimeout(timeoutId);
  }

  if (resposta.status === 404) {
    const erro = new Error('Plano não encontrado.');
    erro.status = 404;
    throw erro;
  }

  if (!resposta.ok) {
    const erro = new Error('Não foi possível carregar os dados do plano, tente novamente.');
    erro.status = 502;
    throw erro;
  }

  const plano = await resposta.json();
  return { contratante, plano };
}

/* ------------------------------------------------------------------
   Autoteste — `node src/services/pedidoService.js`
   Só a parte pura (sem rede/banco): a regra de id imprevisível, que
   RECUSA requisição, e a de método habilitado.

   Precisa de um .env presente (mesmo com valores falsos): este módulo
   importa o cliente do Supabase no topo, e ele exige as variáveis pra
   ser construído — nada aqui chega a consultar o banco.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('pedidoService.js')) {
  const { strict: assert } = await import('node:assert');

  const recusa = (id) => {
    try { exigirIdImprevisivel(id, 'pedidoId'); return false; } catch { return true; }
  };

  // sequencial curto = enumerável = recusado
  assert.ok(recusa('1'), 'id 1');
  assert.ok(recusa('42'), 'id 42');
  assert.ok(recusa('1234567'), '7 dígitos ainda é pouco');

  // longo só de dígitos passa (timestamp, id interno grande)
  assert.ok(!recusa('12345678'), '8 dígitos passa');
  assert.ok(!recusa('1789023226000'), 'timestamp passa');

  // qualquer coisa com letra passa — não dá pra varrer
  assert.ok(!recusa('abc123'), 'alfanumérico passa');
  assert.ok(!recusa('550e8400-e29b-41d4-a716-446655440000'), 'uuid passa');
  assert.ok(!recusa('master'), 'slug passa');
  assert.ok(!recusa('PED-0001'), 'com prefixo passa');

  // vazio/nulo não é tratado aqui (a rota do Express nem casa sem o
  // parâmetro) — só não pode explodir
  assert.ok(!recusa(undefined), 'undefined não estoura');

  // método habilitado: lista ausente libera tudo (contratante antigo)
  assert.ok(metodoHabilitado({}, 'pix'), 'sem lista libera');
  assert.ok(metodoHabilitado({ metodos_habilitados: ['pix'] }, 'pix'), 'na lista libera');
  assert.ok(!metodoHabilitado({ metodos_habilitados: ['pix'] }, 'boleto'), 'fora da lista bloqueia');

  console.log('pedidoService: 13 checagens OK');
}
