/**
 * public/js/modules/assinaturaHandler.js
 * Modelo pull pra assinatura — ver INTEGRACAO.md seção 6.1.
 * Link: ?c=CONTRATANTE_ID&assinatura=PLANO_ID (em vez de ?pedido=).
 */

import { get } from '../utils/api.js';

let contextoResolvido = null;

const ROTULOS_CICLO = {
  MONTHLY: 'mensal',
  QUARTERLY: 'trimestral',
  SEMIANNUALLY: 'semestral',
  YEARLY: 'anual'
};

export function lerParametrosAssinatura() {
  const parametros = new URLSearchParams(window.location.search);
  const contratanteId = parametros.get('c');
  const planoId = parametros.get('assinatura');
  if (!contratanteId || !planoId) return null;
  return { contratanteId, planoId };
}

export async function resolverAssinatura() {
  const ids = lerParametrosAssinatura();
  if (!ids) return null;

  try {
    const plano = await get(`/api/checkout/plano/${ids.contratanteId}/${ids.planoId}`);
    contextoResolvido = { ...ids, plano };
    return { ids, plano };
  } catch (erro) {
    return { ids, erro: erro.message || 'Não foi possível carregar o plano.' };
  }
}

export function obterIdsAssinaturaResolvidos() {
  if (!contextoResolvido) return null;
  return { contratanteId: contextoResolvido.contratanteId, planoId: contextoResolvido.planoId };
}

export function obterPagadorPreenchidoAssinatura() {
  return contextoResolvido?.plano?.pagador ?? null;
}

export function rotularCiclo(ciclo) {
  return ROTULOS_CICLO[ciclo] ?? String(ciclo ?? '').toLowerCase();
}
