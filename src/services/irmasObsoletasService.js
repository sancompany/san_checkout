/**
 * SAN CHECKOUT v2 — src/services/irmasObsoletasService.js
 *
 * O PRIMEIRO PAGAMENTO DE UM PEDIDO TORNA AS IRMÃS OBSOLETAS (RN-51) —
 * e dois pagamentos reais do mesmo pedido são DUPLICIDADE, nunca um só
 * (RN-52). Pedido do dono em 25/09/2026, depois do PR #47.
 *
 * O caso: o comprador gera um Pix (ou boleto), não paga, volta e paga no
 * cartão. O PR #47 (RN-04.1) impede que o pedido abra para uma cobrança
 * NOVA — mas o Pix/boleto antigo, já emitido, continuava pagável fora do
 * Checkout, no app do banco, por dias. Pago, seria um segundo débito
 * pelo mesmo pedido.
 *
 * ── As três peças ───────────────────────────────────────────────────
 *
 *  1. `aoLiquidarCobrancaDePedido` — chamada pelo receptor do webhook
 *     quando uma cobrança de pedido chega a `confirmado`. Local e rápida
 *     (nenhuma rede para a Asaas dentro do webhook):
 *       - DUPLICIDADE: se outra cobrança do mesmo (contratante, pedido)
 *         já liquidou, as duas são marcadas (`pagamento_duplicado_*`),
 *         os dois registros ficam como estão — são dinheiro real — e o
 *         operador é avisado em `erros` para estornar um pelo fluxo de
 *         estorno de sempre. O aviso ao contratante leva
 *         `pagamentoDuplicado`;
 *       - OBSOLETAS: as irmãs ainda pagáveis são MARCADAS
 *         (`obsoleta_*`), com a primeira tentativa vencendo agora. O
 *         status delas NÃO muda aqui: só muda depois de a Asaas
 *         confirmar que a cobrança deixou de ser pagável.
 *  2. `cancelarIrmasUmaVez` — o CANCELADOR, de minuto em minuto
 *     (`server.js`) e logo depois do webhook. Para cada irmã marcada e
 *     vencida: reivindica por CAS (arrendamento + contador), invalida na
 *     Asaas e grava `cancelado_por_outro_pagamento`. Falha vira recuo
 *     gravado, com teto; esgotado, vira linha em `erros` e para.
 *  3. A marcação DERIVADA DO ESTADO, na mesma passada: toda irmã
 *     pagável de um pedido LIQUIDADO nos últimos `DIAS_DE_JANELA` dias é
 *     marcada, venha a liquidação de onde vier (webhook, a consulta de
 *     status que reconsulta a Asaas, o reconciliador). O webhook é só o
 *     caminho rápido; a garantia é esta.
 *
 * ── O que NUNCA acontece ────────────────────────────────────────────
 *  - cancelar cobrança paga: a linha precisa estar em `STATUS_PAGAVEIS`
 *    (no SELECT, no CAS da reivindicação e no CAS da gravação) E a
 *    Asaas precisa dizer PENDING/OVERDUE antes do `DELETE`;
 *  - apagar histórico: nada é deletado do banco; a linha muda de status;
 *  - segunda chamada destrutiva para o mesmo retry: cada tentativa relê
 *    a Asaas antes de agir — cobrança já removida é só gravada;
 *  - reescrever a história: pagamento que chegar numa irmã mesmo assim
 *    (`cancelado_por_outro_pagamento → confirmado` é permitido pela
 *    máquina de estados) entra como duplicidade.
 */

import { supabase } from '../config/supabase.js';
import { ambienteAsaas } from '../config/asaas.js';
import {
  consultarPagamento,
  excluirCobranca,
  cancelarSessaoDeCheckout,
  MINUTOS_DE_SESSAO_DE_CHECKOUT
} from './asaasService.js';
import { registrarErro } from './erroService.js';

export const STATUS_CANCELADO_POR_OUTRO = 'cancelado_por_outro_pagamento';

/** O pedido está LIQUIDADO por esta cobrança: o dinheiro foi confirmado
 *  (e talvez esteja em estorno ou disputa — continua tendo sido pago).
 *  `em_analise` NÃO: o cartão ainda pode ser recusado, e cancelar o Pix
 *  por causa dele deixaria o pedido sem nenhum meio de pagamento. Se ele
 *  confirmar depois de o Pix ter sido pago, é duplicidade (RN-52). */
export const STATUS_QUE_LIQUIDAM = ['confirmado', 'estorno_solicitado', 'estornado_parcialmente', 'estorno_negado', 'chargeback'];

/** A irmã ainda pode ser paga pelo comprador. `recusado` entra porque a
 *  sessão da pop-up aceita uma nova tentativa de cartão; `em_analise`
 *  não (já foi paga, está na operadora); `expirado`/`cancelado` não
 *  (nada mais a pagar). */
export const STATUS_PAGAVEIS = ['pendente', 'vencido', 'recusado'];

/** Status da Asaas em que ainda existe algo a pagar — o único estado em
 *  que o `DELETE` é chamado. */
const STATUS_ASAAS_PAGAVEIS = ['PENDING', 'OVERDUE'];

/** Recuo entre tentativas, em minutos (a 1ª é imediata). */
export const RECUOS_MIN = [1, 5, 15, 60, 240, 720, 1440];
export const MAX_TENTATIVAS = RECUOS_MIN.length + 1;
/** O arrendamento de UMA tentativa: acima de duas chamadas à Asaas com o
 *  teto de 20 s (`TIMEOUT_ASAAS_MS`), com folga. */
const MINUTOS_DE_ARRENDAMENTO = 5;
/** Sessão de pop-up não concluída e mais velha que isto já expirou do
 *  lado da Asaas — nada mais a pagar nela. */
const MINUTOS_ATE_SESSAO_MORTA = MINUTOS_DE_SESSAO_DE_CHECKOUT + 5;

const COLUNAS = 'id, contratante_id, pedido_id, charge_id, asaas_checkout_id, metodo_pagamento, status, ambiente, criado_em, sessao_concluida_em, obsoleta_por_charge_id, obsoleta_desde, cancelamento_tentativas, cancelamento_proxima_em, pagamento_duplicado_em, pagamento_duplicado_com';

/* ------------------------------------------------------------------
   Banco
------------------------------------------------------------------ */

async function linhasDoPedido(contratanteId, pedidoId) {
  const { data, error } = await supabase.from('cobrancas').select(COLUNAS)
    .eq('contratante_id', contratanteId).eq('pedido_id', pedidoId);
  if (error) throw error;
  return data ?? [];
}

/** Marca uma irmã obsoleta — só se ela AINDA é pagável e ainda não foi
 *  marcada (idempotente: a segunda marcação não casa nada). */
async function marcarObsoleta(id, porChargeId, agora) {
  const { data, error } = await supabase.from('cobrancas')
    .update({ obsoleta_por_charge_id: porChargeId, obsoleta_desde: agora.toISOString(), cancelamento_proxima_em: agora.toISOString() })
    .eq('id', id).in('status', STATUS_PAGAVEIS).is('obsoleta_desde', null)
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length === 1;
}

/** Marca duplicidade numa linha — só na primeira vez. `true` quando ESTA
 *  chamada marcou (é quem avisa o operador). */
async function marcarDuplicidade(id, com, agora) {
  const { data, error } = await supabase.from('cobrancas')
    .update({ pagamento_duplicado_em: agora.toISOString(), pagamento_duplicado_com: com })
    .eq('id', id).is('pagamento_duplicado_em', null)
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length === 1;
}

/** A janela da marcação pelo estado: liquidações dos últimos dias. Por
 *  ESTE lado, e não pelo das pagáveis — boleto vencido e nunca pago fica
 *  `vencido` para sempre, e uma varredura "toda pagável não marcada" com
 *  teto acabaria ocupada por elas e cega para a irmã nova (revisão de
 *  25/09/2026). Liquidações por dia são poucas; três dias cobrem um
 *  webhook perdido com folga. */
export const DIAS_DE_JANELA = 3;

async function listarLiquidacoesRecentes(ambiente, desde, limite = 500) {
  const { data, error } = await supabase.from('cobrancas').select('id, contratante_id, pedido_id, charge_id, status')
    .not('pedido_id', 'is', null).in('status', STATUS_QUE_LIQUIDAM)
    .gte('confirmado_em', desde.toISOString()).eq('ambiente', ambiente)
    .order('confirmado_em', { ascending: false }).limit(limite);
  if (error) throw error;
  return data ?? [];
}

/** Irmãs pagáveis ainda não marcadas destes pedidos, com algo do lado da
 *  Asaas (uma reserva sem `charge_id` nem sessão é do reconciliador — ele
 *  a completa ou a apaga, e na passada seguinte ela entra aqui). Em
 *  lotes: cada id vai na URL do PostgREST. */
async function listarPagaveisDosPedidos(pedidoIds) {
  const linhas = [];
  for (let i = 0; i < pedidoIds.length; i += 50) {
    const { data, error } = await supabase.from('cobrancas').select(COLUNAS)
      .in('pedido_id', pedidoIds.slice(i, i + 50)).in('status', STATUS_PAGAVEIS).is('obsoleta_desde', null);
    if (error) throw error;
    linhas.push(...(data ?? []));
  }
  return linhas.filter((l) => l.charge_id || l.asaas_checkout_id);
}

async function listarVencidas(ambiente, agora, limite = 20) {
  const { data, error } = await supabase.from('cobrancas').select(COLUNAS)
    .not('obsoleta_desde', 'is', null).in('status', STATUS_PAGAVEIS)
    .lte('cancelamento_proxima_em', agora.toISOString()).eq('ambiente', ambiente)
    .order('cancelamento_proxima_em', { ascending: true }).limit(limite);
  if (error) throw error;
  return data ?? [];
}

/** Reivindica UMA tentativa: contador + arrendamento num CAS só. Quem
 *  perde (outra passada, o disparo do webhook) não chama a Asaas. */
async function reivindicarTentativa(linha, agora) {
  const tentativas = linha.cancelamento_tentativas ?? 0;
  const { data, error } = await supabase.from('cobrancas')
    .update({
      cancelamento_tentativas: tentativas + 1,
      cancelamento_proxima_em: new Date(agora.getTime() + MINUTOS_DE_ARRENDAMENTO * 60_000).toISOString()
    })
    .eq('id', linha.id).eq('cancelamento_tentativas', tentativas)
    .in('status', STATUS_PAGAVEIS).lte('cancelamento_proxima_em', agora.toISOString())
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length === 1 ? tentativas + 1 : null;
}

/** Grava o cancelamento — CAS no status LIDO: se um pagamento chegou
 *  nesta linha entre a leitura e aqui, nada é sobrescrito. */
async function gravarCancelada(linha, agora) {
  const { data, error } = await supabase.from('cobrancas')
    .update({ status: STATUS_CANCELADO_POR_OUTRO, atualizado_em: agora.toISOString(), cancelamento_proxima_em: null, cancelamento_ultimo_erro: null })
    .eq('id', linha.id).eq('status', linha.status)
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length === 1;
}

async function gravarRecuo(linha, { proximaEm, erro }) {
  const { error } = await supabase.from('cobrancas')
    .update({ cancelamento_proxima_em: proximaEm ? proximaEm.toISOString() : null, cancelamento_ultimo_erro: String(erro ?? '').slice(0, 500) || null })
    .eq('id', linha.id);
  if (error) throw error;
}

const dependenciasPadrao = {
  linhasDoPedido,
  marcarObsoleta,
  marcarDuplicidade,
  listarLiquidacoesRecentes,
  listarPagaveisDosPedidos,
  listarVencidas,
  reivindicarTentativa,
  gravarCancelada,
  gravarRecuo,
  consultarPagamento,
  excluirCobranca,
  cancelarSessaoDeCheckout,
  registrarErro,
  ambiente: ambienteAsaas,
  agora: () => new Date()
};

/* ------------------------------------------------------------------
   1. Na liquidação (chamada pelo webhook)
------------------------------------------------------------------ */

/**
 * @param {object} cobranca — a linha que acabou de chegar a `confirmado`
 *   (precisa de `id`, `contratante_id`, `pedido_id`, `charge_id`)
 * @returns {Promise<{ duplicadoCom: string[], obsoletas: number }>}
 */
export async function aoLiquidarCobrancaDePedido(cobranca, deps = dependenciasPadrao) {
  if (!cobranca?.pedido_id || !cobranca?.contratante_id) return { duplicadoCom: [], obsoletas: 0 };
  const agora = deps.agora();
  const linhas = await deps.linhasDoPedido(cobranca.contratante_id, cobranca.pedido_id);
  const eEla = (l) => (cobranca.id ? l.id === cobranca.id : l.charge_id === cobranca.charge_id);

  /* RN-52 — outra irmã JÁ liquidou: os dois pagamentos são reais. */
  const outrasPagas = linhas.filter((l) => !eEla(l) && STATUS_QUE_LIQUIDAM.includes(l.status));
  const duplicadoCom = outrasPagas.map((l) => l.charge_id).filter(Boolean);
  if (outrasPagas.length > 0) {
    const propria = linhas.find(eEla);
    const idPropria = cobranca.id ?? propria?.id;
    const marcouAgora = idPropria ? await deps.marcarDuplicidade(idPropria, duplicadoCom, agora) : false;
    for (const outra of outrasPagas) await deps.marcarDuplicidade(outra.id, [cobranca.charge_id].filter(Boolean), agora);
    if (marcouAgora) {
      await deps.registrarErro(
        new Error(
          `PAGAMENTO DUPLICADO: o pedido ${cobranca.pedido_id} (${cobranca.contratante_id}) foi pago mais de uma vez — ` +
          `${[cobranca.charge_id, ...duplicadoCom].join(' e ')}. Os dois pagamentos são reais e estão registrados; ` +
          'nenhum foi desfeito automaticamente. Estorne um deles pelo fluxo de estorno (POST /api/checkout/estornar ' +
          'ou painel da Asaas). O contratante recebeu o aviso com pagamentoDuplicado: true.'
        ),
        { contexto: 'irmasObsoletasService.duplicidade', rota: 'webhook/asaas', metodo: 'INTERNO', status: 409 }
      );
    }
  }

  /* RN-51 — as irmãs ainda pagáveis viram obsoletas (o cancelador faz o resto). */
  let obsoletas = 0;
  for (const irma of linhas) {
    if (eEla(irma) || !STATUS_PAGAVEIS.includes(irma.status) || irma.obsoleta_desde) continue;
    if (!irma.charge_id && !irma.asaas_checkout_id) continue; // reserva: do reconciliador
    if (await deps.marcarObsoleta(irma.id, cobranca.charge_id ?? null, agora)) obsoletas += 1;
  }
  return { duplicadoCom, obsoletas };
}

/* ------------------------------------------------------------------
   2. O cancelador
------------------------------------------------------------------ */

function recuoApos(tentativas, agora) {
  const minutos = RECUOS_MIN[Math.min(tentativas - 1, RECUOS_MIN.length - 1)];
  return new Date(agora.getTime() + minutos * 60_000);
}

/**
 * O que a ASAAS diz desta irmã, e o que fazer. Nunca chama nada
 * destrutivo sem ter lido o estado antes, na MESMA tentativa.
 * @returns {Promise<{ desfecho: 'cancelada'|'aguardar'|'falhou', motivo: string }>}
 */
async function invalidarNaAsaas(linha, agora, deps) {
  /* 1. A SESSÃO da pop-up, se ela ainda está aberta: é por ela que o
     comprador tenta de novo (outro cartão depois de uma recusa). Sessão
     CONCLUÍDA não se cancela — o pagamento dela já existe, e é por ele
     que se decide (passo 2). */
  if (linha.asaas_checkout_id && !linha.sessao_concluida_em) {
    let status;
    try {
      ({ status } = await deps.cancelarSessaoDeCheckout(linha.asaas_checkout_id));
    } catch (erro) {
      const idadeMin = (agora.getTime() - new Date(linha.criado_em).getTime()) / 60_000;
      // A sessão hospedada vive 60 min (`MINUTOS_DE_SESSAO_DE_CHECKOUT`):
      // não concluída e mais velha que isso, não há mais o que pagar nela.
      if (idadeMin >= MINUTOS_ATE_SESSAO_MORTA) status = 'EXPIRED';
      else return { desfecho: 'falhou', motivo: `cancelamento da sessão falhou (${erro.status ?? 'sem status'}): ${erro.message}` };
    }
    if (status === 'PAID') return { desfecho: 'aguardar', motivo: 'a sessão foi paga — o PAYMENT_* dela traz a duplicidade' };
    if (status !== 'CANCELED' && status !== 'EXPIRED') return { desfecho: 'falhou', motivo: `cancelamento da sessão devolveu ${status}` };
    if (!linha.charge_id) return { desfecho: 'cancelada', motivo: `sessão ${status} na Asaas` };
    // com uma tentativa de pagamento já criada (ex.: cartão recusado), ela também é conferida
  }

  /* 2. O PAGAMENTO, pelo id — lido ANTES de qualquer exclusão. */
  if (linha.charge_id) {
    let pagamento;
    try {
      pagamento = await deps.consultarPagamento(linha.charge_id);
    } catch (erro) {
      /* Inclusive 404: a doc diz que cobrança removida continua
         restaurável pelo mesmo id, então o esperado é `200` com
         `deleted: true` — um 404 para um id NOSSO é estado que ninguém
         mediu, e vai para o operador pelo teto de tentativas em vez de
         virar "cancelada" por palpite. */
      return { desfecho: 'falhou', motivo: `consulta falhou (${erro.status ?? 'sem status'}): ${erro.message}` };
    }
    if (pagamento.excluida) return { desfecho: 'cancelada', motivo: 'já estava removida na Asaas' };
    if (!STATUS_ASAAS_PAGAVEIS.includes(pagamento.status)) {
      // Paga, em análise, estornada… — NUNCA se exclui. Se liquidou, o
      // webhook dela traz a duplicidade; até lá, só se espera.
      return { desfecho: 'aguardar', motivo: `a Asaas diz ${pagamento.status} — não é mais pagável, não se exclui` };
    }
    try {
      const { excluida } = await deps.excluirCobranca(linha.charge_id);
      return excluida
        ? { desfecho: 'cancelada', motivo: 'excluída na Asaas' }
        : { desfecho: 'falhou', motivo: 'a Asaas respondeu sem deleted: true' };
    } catch (erro) {
      // Recusa limpa ou ambígua: a próxima tentativa relê antes de agir.
      return { desfecho: 'falhou', motivo: `exclusão falhou (${erro.status ?? 'sem status'}): ${erro.message}` };
    }
  }

  if (linha.asaas_checkout_id) {
    // O pagador concluiu a pop-up: o pagamento existe e o id dele ainda
    // não chegou (vem no PAYMENT_*). Sem id, não há o que excluir.
    return { desfecho: 'aguardar', motivo: 'sessão concluída, aguardando o id do pagamento' };
  }
  return { desfecho: 'aguardar', motivo: 'reserva sem cobrança nem sessão na Asaas' };
}

export function criarCanceladorDeIrmas(deps = dependenciasPadrao) {
  async function marcarPeloEstado(relatorio) {
    const agora = deps.agora();
    const desde = new Date(agora.getTime() - DIAS_DE_JANELA * 24 * 3600_000);
    const liquidadas = await deps.listarLiquidacoesRecentes(deps.ambiente(), desde);
    if (liquidadas.length === 0) return;
    const pagaveis = await deps.listarPagaveisDosPedidos([...new Set(liquidadas.map((l) => l.pedido_id))]);
    for (const irma of pagaveis) {
      const pagadora = liquidadas.find((l) => l.contratante_id === irma.contratante_id && l.pedido_id === irma.pedido_id && l.id !== irma.id);
      if (pagadora && await deps.marcarObsoleta(irma.id, pagadora.charge_id ?? null, agora)) relatorio.marcadas += 1;
    }
  }

  async function tentarUma(linha, relatorio) {
    const agora = deps.agora();
    const tentativa = await deps.reivindicarTentativa(linha, agora);
    if (!tentativa) return; // outra passada ficou com ela
    relatorio.tentadas += 1;

    const { desfecho, motivo } = await invalidarNaAsaas(linha, agora, deps);
    if (desfecho === 'cancelada') {
      if (await deps.gravarCancelada(linha, deps.agora())) relatorio.canceladas += 1;
      return;
    }

    if (tentativa >= MAX_TENTATIVAS) {
      await deps.gravarRecuo(linha, { proximaEm: null, erro: motivo });
      relatorio.esgotadas += 1;
      await deps.registrarErro(
        new Error(
          `cancelamento de irmã ESGOTADO: a cobrança ${linha.charge_id ?? linha.asaas_checkout_id} (${linha.metodo_pagamento}) ` +
          `do pedido ${linha.pedido_id} (${linha.contratante_id}) segue pagável na Asaas depois de ${tentativa} tentativas — ` +
          `o pedido já foi pago por ${linha.obsoleta_por_charge_id ?? 'outra cobrança'}. Último motivo: ${motivo}. ` +
          'Excluir à mão no painel da Asaas; se ela tiver sido paga, é pagamento duplicado a estornar.'
        ),
        { contexto: 'irmasObsoletasService.esgotado', rota: 'cancelador-de-irmas', metodo: 'INTERNO', status: 500 }
      );
      return;
    }
    await deps.gravarRecuo(linha, { proximaEm: recuoApos(tentativa, agora), erro: motivo });
    if (desfecho === 'falhou') relatorio.falhas += 1; else relatorio.aguardando += 1;
  }

  /** Uma passada: marca pelo estado, depois tenta as vencidas. Não lança
   *  por uma linha — o erro dela vira recuo e `erros`, e as outras seguem. */
  async function cancelarIrmasUmaVez() {
    const relatorio = { marcadas: 0, tentadas: 0, canceladas: 0, aguardando: 0, falhas: 0, esgotadas: 0 };
    await marcarPeloEstado(relatorio);
    for (const linha of await deps.listarVencidas(deps.ambiente(), deps.agora())) {
      try {
        await tentarUma(linha, relatorio);
      } catch (erro) {
        relatorio.falhas += 1;
        await deps.registrarErro(erro, { contexto: 'irmasObsoletasService.linha', rota: 'cancelador-de-irmas', metodo: 'INTERNO', status: 500 });
      }
    }
    return relatorio;
  }

  return { cancelarIrmasUmaVez };
}

export const { cancelarIrmasUmaVez } = criarCanceladorDeIrmas();

/** O disparo logo depois do webhook — fora do fluxo, sem segurar a
 *  resposta à Asaas. A passada de minuto em minuto é a garantia. */
export function dispararCancelador() {
  Promise.resolve().then(cancelarIrmasUmaVez)
    .catch((erro) => console.error('[irmas] disparo do cancelador falhou (a passada periódica refaz):', erro.message));
}

/* ------------------------------------------------------------------
   Autoteste — `node src/services/irmasObsoletasService.js`
   (o caminho inteiro, com o webhook e o banco, está em
   `tests/pagamento-de-um-pedido-invalida-as-irmas.js`)
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('irmasObsoletasService.js')) {
  const { strict: assertReal } = await import('node:assert');
  let checagens = 0;
  const assert = new Proxy(assertReal, {
    get(alvo, nome) {
      const valor = alvo[nome];
      if (typeof valor !== 'function') return valor;
      return (...args) => { checagens += 1; return valor.apply(alvo, args); };
    }
  });

  // Os conjuntos não se cruzam, e nenhum pago é pagável.
  for (const s of STATUS_PAGAVEIS) assert.ok(!STATUS_QUE_LIQUIDAM.includes(s), `${s} não pode ser pagável E liquidado`);
  assert.ok(!STATUS_PAGAVEIS.includes('em_analise'), 'em análise o pagador já pagou');
  assert.ok(!STATUS_QUE_LIQUIDAM.includes('em_analise'), 'em análise ainda pode ser recusado — não cancela o Pix por causa dele');
  assert.ok(!STATUS_QUE_LIQUIDAM.includes('estornado'), 'estorno TOTAL devolve o dinheiro: o pedido volta a poder ser pago');
  const { STATUS_FINANCEIROS } = await import('./transicoesFinanceiras.js');
  for (const s of [...STATUS_PAGAVEIS, ...STATUS_QUE_LIQUIDAM, STATUS_CANCELADO_POR_OUTRO]) assert.ok(STATUS_FINANCEIROS.includes(s), `${s} fora do vocabulário da máquina de estados`);
  assert.equal(MAX_TENTATIVAS, RECUOS_MIN.length + 1);

  // Uma irmã de cada tipo, contra uma Asaas falsa, para cada desfecho.
  const agora = new Date('2026-09-25T12:00:00Z');
  const chamadas = [];
  const asaas = (respostas) => ({
    consultarPagamento: async (id) => { chamadas.push(['GET', id]); if (respostas.get instanceof Error) throw respostas.get; return respostas.get; },
    excluirCobranca: async (id) => { chamadas.push(['DELETE', id]); if (respostas.del instanceof Error) throw respostas.del; return respostas.del; },
    cancelarSessaoDeCheckout: async (id) => { chamadas.push(['CANCEL', id]); if (respostas.cancel instanceof Error) throw respostas.cancel; return respostas.cancel; }
  });
  const erroAsaas = (status) => Object.assign(new Error(`asaas ${status}`), { status, corpoAsaas: { errors: [] } });
  const invalidar = (linha, respostas) => { chamadas.length = 0; return invalidarNaAsaas(linha, agora, asaas(respostas)); };
  const pix = { charge_id: 'pay_pix', metodo_pagamento: 'pix', criado_em: '2026-09-25T11:00:00Z' };

  let r = await invalidar(pix, { get: { status: 'PENDING', excluida: false }, del: { excluida: true } });
  assert.equal(r.desfecho, 'cancelada');
  assert.deepEqual(chamadas, [['GET', 'pay_pix'], ['DELETE', 'pay_pix']], 'lê ANTES de excluir, na mesma tentativa');

  for (const status of ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH', 'AWAITING_RISK_ANALYSIS', 'REFUNDED']) {
    r = await invalidar(pix, { get: { status, excluida: false }, del: new Error('não pode chegar aqui') });
    assert.equal(r.desfecho, 'aguardar', `${status}: não se exclui`);
    assert.ok(!chamadas.some(([m]) => m === 'DELETE'), `${status}: NENHUM DELETE sobre cobrança que não é mais pagável`);
  }

  r = await invalidar(pix, { get: { status: 'PENDING', excluida: true } });
  assert.equal(r.desfecho, 'cancelada', 'retry depois de um DELETE cuja resposta se perdeu: só grava');
  assert.ok(!chamadas.some(([m]) => m === 'DELETE'), 'e não chama DELETE de novo');

  r = await invalidar(pix, { get: erroAsaas(504) });
  assert.equal(r.desfecho, 'falhou', 'consulta ambígua: tenta de novo depois, não age');
  r = await invalidar(pix, { get: { status: 'OVERDUE', excluida: false }, del: erroAsaas(400) });
  assert.equal(r.desfecho, 'falhou', 'boleto vencido que a Asaas não deixa excluir: falha gravada, nunca "cancelada"');
  r = await invalidar(pix, { get: { status: 'PENDING', excluida: false }, del: { excluida: false } });
  assert.equal(r.desfecho, 'falhou', '200 sem deleted: true não é prova de exclusão');
  r = await invalidar(pix, { get: erroAsaas(404) });
  assert.equal(r.desfecho, 'falhou', '404 não é prova de exclusão (a doc diz que removida é restaurável): vai ao operador pelo teto');

  const sessao = { asaas_checkout_id: 'chk_1', metodo_pagamento: 'cartao_credito', criado_em: '2026-09-25T11:50:00Z', sessao_concluida_em: null };
  r = await invalidar(sessao, { cancel: { status: 'CANCELED' } });
  assert.equal(r.desfecho, 'cancelada');
  assert.deepEqual(chamadas, [['CANCEL', 'chk_1']]);
  r = await invalidar(sessao, { cancel: { status: 'PAID' } });
  assert.equal(r.desfecho, 'aguardar', 'sessão paga: é o PAYMENT_* dela que decide');
  r = await invalidar(sessao, { cancel: erroAsaas(400) });
  assert.equal(r.desfecho, 'falhou', 'sessão ainda dentro da validade e a Asaas recusou: tenta de novo');
  r = await invalidar({ ...sessao, criado_em: '2026-09-25T10:00:00Z' }, { cancel: erroAsaas(400) });
  assert.equal(r.desfecho, 'cancelada', 'sessão de 2 h, não concluída: não há mais o que pagar nela');
  r = await invalidar({ ...sessao, sessao_concluida_em: '2026-09-25T11:55:00Z' }, { cancel: new Error('não pode chegar aqui') });
  assert.equal(r.desfecho, 'aguardar', 'pop-up concluída: o pagamento existe, e sem o id dele nada se cancela');
  assert.deepEqual(chamadas, [], 'e a sessão concluída não é cancelada');

  // Pop-up RECUSADA (o cartão foi negado, a sessão ainda aceita outro): a sessão é encerrada E o pagamento conferido.
  const recusada = { ...sessao, charge_id: 'pay_recusado' };
  r = await invalidar(recusada, { cancel: { status: 'CANCELED' }, get: { status: 'PENDING', excluida: false }, del: { excluida: true } });
  assert.equal(r.desfecho, 'cancelada');
  assert.deepEqual(chamadas, [['CANCEL', 'chk_1'], ['GET', 'pay_recusado'], ['DELETE', 'pay_recusado']], 'a sessão PRIMEIRO (é por ela que o comprador tenta de novo), depois o pagamento');
  r = await invalidar(recusada, { cancel: erroAsaas(400) });
  assert.equal(r.desfecho, 'falhou', 'sessão aberta que não fecha: nada é dado como cancelado');
  assert.deepEqual(chamadas, [['CANCEL', 'chk_1']], 'e o pagamento nem é tocado');

  // O recuo cresce e o teto para.
  assert.equal(recuoApos(1, agora).getTime() - agora.getTime(), 60_000);
  assert.equal(recuoApos(99, agora).getTime() - agora.getTime(), RECUOS_MIN.at(-1) * 60_000);

  console.log(`irmasObsoletasService: ${checagens} checagens OK`);
}
