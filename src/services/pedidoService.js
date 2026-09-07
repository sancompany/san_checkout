/**
 * SAN CHECKOUT v2 — src/services/pedidoService.js
 * O coração do modelo pull (ver INTEGRACAO.md seção 3): o checkout
 * nunca guarda catálogo — liga de volta pra API do próprio contratante
 * pra saber o que está sendo vendido e por quanto.
 */

import { supabase } from '../config/supabase.js';

const TIMEOUT_MS = 45000; // calibrado pro pior cold start de hospedagem gratuita

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

/** Grava o id da pasta do Drive na primeira vez que ela é criada —
 *  usado só pelo fluxo de nota fiscal (VISAO_COMPLETA.md seção 8). */
export async function atualizarDriveFolderId(contratanteId, driveFolderId) {
  const { error } = await supabase
    .from('contratantes')
    .update({ drive_folder_id: driveFolderId })
    .eq('id', contratanteId);

  if (error) console.error('[pedidoService.atualizarDriveFolderId]', error.message);
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
export async function resolverPedido(contratanteId, pedidoId) {
  const contratante = await buscarContratante(contratanteId);
  if (!contratante) {
    const erro = new Error('Contratante não encontrado.');
    erro.status = 404;
    throw erro;
  }

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
export async function resolverPlano(contratanteId, planoId) {
  const contratante = await buscarContratante(contratanteId);
  if (!contratante) {
    const erro = new Error('Contratante não encontrado.');
    erro.status = 404;
    throw erro;
  }

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
