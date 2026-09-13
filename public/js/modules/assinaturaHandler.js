/**
 * public/js/modules/assinaturaHandler.js
 * Modelo pull pra assinatura — ver INTEGRACAO.md seção 6.1.
 * Link: ?c=CONTRATANTE_ID&assinatura=PLANO_ID (em vez de ?pedido=).
 */

import { get } from '../utils/api.js';

let contextoResolvido = null;

/**
 * TODOS os ciclos que a Asaas aceita — os sete, não só os que o projeto
 * da vez usa.
 *
 * Essa lista já esteve incompleta duas vezes: nasceu só com MONTHLY, e
 * a Vitrina (planos B2B) obrigou a adicionar QUARTERLY/SEMIANNUALLY/
 * YEARLY. WEEKLY, BIWEEKLY e BIMONTHLY continuavam faltando — um plano
 * semanal mostrava "weekly", em inglês, pro comprador brasileiro.
 *
 * A regra que evita a terceira vez: onde a Asaas define um conjunto
 * fechado, o checkout conhece o conjunto INTEIRO. Espelhado no backend
 * em `src/controllers/asaasCheckoutController.js` (CICLOS_VALIDOS) —
 * mexeu aqui, mexe lá.
 */
const ROTULOS_CICLO = {
  WEEKLY: 'semanal',
  BIWEEKLY: 'quinzenal',
  MONTHLY: 'mensal',
  BIMONTHLY: 'bimestral',
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

    /* Plano sem valor utilizável não vira tela de assinar.

       O `app.js` renderiza o total com `formatarMoeda(plano.valor)`, e
       `formatarMoeda` faz `Number(valor ?? 0)` — sem este guarda, plano
       com `valor` ausente, zero ou texto vira **"R$ 0,00" na tela**,
       com o botão de assinar ligado. É literalmente o erro de
       `docs/erros/2026-09-11-total-ausente-virou-zero-na-tela.md`,
       que foi corrigido no caminho do pedido e nunca chegou aqui.

       A regra é a mesma do backend (`valorValido`: maior que zero e até
       100.000) e a mesma do pedido: ausência de total não vira zero,
       vira estado indisponível — aqui, `erro`, que o `app.js` já trata
       deixando o total em `R$ —` e recusando o clique. */
    const valor = Number(plano?.valor);
    if (!Number.isFinite(valor) || valor <= 0 || valor > 100000) {
      return { ids, erro: 'Este plano está sem valor definido. Peça um link novo ao vendedor.' };
    }

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

/** Métodos que este contratante pode cobrar — vem em `_checkout` na
 *  resposta do plano (o resto do objeto é do contratante). `null` = sem
 *  restrição, contratante cadastrado antes da migração v3. */
export function obterMetodosDoPlano() {
  return contextoResolvido?.plano?._checkout?.metodosHabilitados ?? null;
}
