/**
 * SAN CHECKOUT v2 — src/services/estornoService.js
 * A IDENTIDADE DURÁVEL DO ESTORNO (SEC-002, Estação 6, 25/09/2026).
 *
 * O furo que isto fecha: `POST /estornar` não tinha identidade de
 * operação. Cobrança de R$ 100, estorno parcial de R$ 30, a resposta se
 * perde no caminho, o contratante repete — como o `API.md` §5.4 mandava
 * fazer. O restante era R$ 70, o arrendamento da cobrança estava livre,
 * e a Asaas devolvia mais R$ 30 de verdade. Uma repetição sequencial era
 * indistinguível de um segundo parcial legítimo, e SÓ o contratante sabe
 * qual das duas é: por isso a chave de idempotência vem dele.
 *
 * O que vale aqui, na ordem:
 *
 *  1. A operação é gravada ANTES de chamar a Asaas (`estornos`, migration
 *     0018). A mesma chave é a mesma operação: repetir devolve o
 *     resultado gravado, sem segunda chamada. A mesma chave com outro
 *     pedido (outra cobrança, outro valor) é recusada — nunca
 *     reinterpretada.
 *  2. A identidade viaja para a Asaas no único campo que ela documenta e
 *     devolve: `description` (doc "Estornar cobrança" e "Listar estornos
 *     de uma cobrança", lidas em 25/09/2026 — nenhuma das duas cita chave
 *     de idempotência, e cabeçalho não se inventa).
 *  3. Resultado AMBÍGUO (timeout, 5xx, 429, queda do processo no meio)
 *     nunca é repetido às cegas. Vira UNKNOWN_PROVIDER_RESULT, e só a
 *     reconciliação decide: o marcador na lista de estornos da cobrança
 *     prova que aconteceu; na falta do marcador, o delta EXATO do valor
 *     estornado na Asaas prova (com uma operação em aberto só); ausência
 *     só vale como prova depois de `MINUTOS_ATE_PROVAR_AUSENCIA`.
 *  4. O acumulado nunca passa do elegível: o que está em voo (PENDING,
 *     CALLING_PROVIDER, UNKNOWN) CONTA como já estornado na hora de
 *     calcular o restante, porque pode ter acontecido. E o já estornado
 *     é o maior entre o que a cobrança registra e o que o próprio
 *     registro de operações confirmou — um webhook perdido não reabre
 *     dinheiro que já saiu.
 */
import { randomUUID } from 'node:crypto';
import { supabase } from '../config/supabase.js';
import { emCentavos, emReais } from '../utils/dinheiro.js';
import { estornarCobranca, listarEstornosDaCobranca, consultarPagamento, foiRecusaLimpaDaAsaas } from './asaasService.js';
import { registrarEstorno } from './cobrancaService.js';
import { registrarErro } from './erroService.js';

export const ESTADOS_EM_ABERTO = ['PENDING', 'CALLING_PROVIDER', 'UNKNOWN_PROVIDER_RESULT'];
/** Arrendamento de uma chamada em curso. A chamada à Asaas tem teto de
 *  20 s (`TIMEOUT_ASAAS_MS`); dois minutos só vencem se o processo morreu. */
export const MINUTOS_DE_CHAMADA = 2;
/** Quanto esperar, depois de uma chamada ambígua, antes de afirmar "a
 *  Asaas não estornou" pela ausência do marcador e do valor. */
export const MINUTOS_ATE_PROVAR_AUSENCIA = 15;
/** Depois disto em aberto, a operação vira alerta em `erros` (Lei 8). */
export const MINUTOS_ATE_ALERTAR = 60;

/** Status da Asaas que dizem "o estorno deste boleto foi aceito". */
const STATUS_ASAAS_BOLETO_EM_ESTORNO = ['REFUND_REQUESTED', 'REFUND_IN_PROGRESS', 'REFUNDED'];

export function marcadorDoEstorno(id) {
  return `san-estorno:${id}`;
}

/* ---------------------------------------------------------------- banco */

async function buscarOperacao(contratanteId, chave) {
  const { data, error } = await supabase.from('estornos').select('*')
    .eq('contratante_id', contratanteId).eq('chave_idempotencia', chave).maybeSingle();
  if (error) throw error;
  return data;
}

/** @returns {Promise<{operacao: object}|{conflito: true}>} */
async function inserirOperacao(linha) {
  const { data, error } = await supabase.from('estornos').insert(linha).select('*').single();
  if (error?.code === '23505') return { conflito: true };
  if (error) throw error;
  return { operacao: data };
}

/** CAS: só transita se a operação ainda está num dos estados `de`. */
async function transitar(id, de, campos) {
  const { data, error } = await supabase.from('estornos')
    .update({ ...campos, atualizado_em: new Date().toISOString() })
    .eq('id', id).in('estado', de)
    .select('*');
  if (error) throw error;
  return Array.isArray(data) && data.length === 1 ? data[0] : null;
}

async function operacoesDaCobranca(cobrancaId) {
  const { data, error } = await supabase.from('estornos').select('id, estado, valor_centavos')
    .eq('cobranca_id', cobrancaId);
  if (error) throw error;
  return data ?? [];
}

async function operacoesParaReconciliar(limite = 20) {
  const { data, error } = await supabase.from('estornos').select('*')
    .in('estado', ESTADOS_EM_ABERTO)
    .order('criado_em', { ascending: true })
    .limit(limite);
  if (error) throw error;
  return data ?? [];
}

async function buscarCobrancaDaOperacao(cobrancaId) {
  const { data, error } = await supabase.from('cobrancas')
    .select('id, charge_id, metodo_pagamento, status, valor_cobrado, valor_estornado')
    .eq('id', cobrancaId).maybeSingle();
  if (error) throw error;
  return data;
}

const dependenciasPadrao = {
  buscarOperacao, inserirOperacao, transitar, operacoesDaCobranca, operacoesParaReconciliar,
  buscarCobrancaDaOperacao, estornarCobranca, listarEstornosDaCobranca, consultarPagamento,
  foiRecusaLimpaDaAsaas, registrarErro,
  /* A reconciliação grava o estado confirmado também na cobrança — sem
     soltar o arrendamento, que pode ser de outra requisição viva. */
  registrarNaCobrancaSemSoltar: (chargeId, dados) => registrarEstorno(chargeId, dados, { liberarArrendamento: false }),
  novoId: () => randomUUID(),
  agora: () => Date.now()
};

/* ----------------------------------------------------------- aritmética */

/**
 * Quanto ainda PODE ser estornado desta cobrança, em centavos, contando
 * como estornado tudo que está em voo — a garantia de "acumulado ≤
 * elegível" mesmo quando uma chamada anterior ficou sem resposta.
 * `excetoId` tira da conta a própria operação (numa nova tentativa dela).
 */
export function restanteEstornavel(cobranca, operacoes, excetoId = null) {
  const cobrado = emCentavos(cobranca.valor_cobrado);
  if (cobrado == null) return null;
  const naCobranca = emCentavos(cobranca.valor_estornado) ?? 0;
  const outras = (operacoes ?? []).filter((o) => o.id !== excetoId);
  const confirmadas = outras.filter((o) => o.estado === 'CONFIRMED').reduce((s, o) => s + Number(o.valor_centavos), 0);
  const emVoo = outras.filter((o) => ESTADOS_EM_ABERTO.includes(o.estado)).reduce((s, o) => s + Number(o.valor_centavos), 0);
  return { restante: cobrado - Math.max(naCobranca, confirmadas) - emVoo, emVoo, cobrado, jaEstornado: Math.max(naCobranca, confirmadas) };
}

function mesmoPedido(op, { cobrancaId, total, valorCentavos }) {
  if (op.cobranca_id !== cobrancaId) return false;
  if (Boolean(op.total) !== Boolean(total)) return false;
  return total || Number(op.valor_centavos) === valorCentavos;
}

function respostaDaOperacao(op, { replay = false } = {}) {
  return {
    http: 200,
    corpo: {
      chargeId: op.charge_id,
      status: op.status_resultado,
      valorEstornado: op.valor_estornado_depois == null ? null : Number(op.valor_estornado_depois),
      estornoParcial: op.status_resultado === 'estornado_parcialmente',
      operacaoId: op.id,
      ...(replay ? { repetido: true } : {})
    }
  };
}

/* ------------------------------------------------------- reconciliação */

/**
 * Decide o destino de UMA operação em aberto olhando a Asaas — nunca
 * chamando o estorno de novo. Devolve a operação atualizada (ou a mesma,
 * se ainda não dá para decidir).
 */
export async function reconciliarOperacao(op, deps = dependenciasPadrao) {
  const idadeMin = (deps.agora() - new Date(op.chamando_em ?? op.atualizado_em ?? op.criado_em).getTime()) / 60_000;

  /* PENDING nunca chegou a chamar a Asaas: quem chama reivindica
     (CALLING_PROVIDER) ANTES de ir à rede. Parado assim além do
     arrendamento, é processo que morreu entre gravar e reivindicar. */
  if (op.estado === 'PENDING') {
    if (idadeMin < MINUTOS_DE_CHAMADA) return op;
    return (await deps.transitar(op.id, ['PENDING'], { estado: 'FAILED_RETRYABLE', ultimo_erro: 'processo encerrou antes de chamar a Asaas' })) ?? op;
  }
  // Chamada em curso e dentro do prazo: é de outra requisição viva.
  if (op.estado === 'CALLING_PROVIDER' && idadeMin < MINUTOS_DE_CHAMADA) return op;

  const cobranca = await deps.buscarCobrancaDaOperacao(op.cobranca_id);
  if (!cobranca) return op;

  if (cobranca.metodo_pagamento === 'boleto') {
    /* Boleto: o estorno é um pedido assíncrono, e a lista de estornos da
       Asaas não é documentada para ele. O status do pagamento é o que
       diz se o pedido foi aceito. */
    const { status } = await deps.consultarPagamento(op.charge_id);
    if (STATUS_ASAAS_BOLETO_EM_ESTORNO.includes(status)) {
      const confirmada = await deps.transitar(op.id, ESTADOS_EM_ABERTO, { estado: 'CONFIRMED', status_resultado: 'estorno_solicitado', valor_estornado_depois: null, chamando_em: null });
      if (confirmada) await deps.registrarNaCobrancaSemSoltar(op.charge_id, { status: 'estorno_solicitado' });
      return confirmada ?? op;
    }
    if (idadeMin >= MINUTOS_ATE_PROVAR_AUSENCIA) {
      return (await deps.transitar(op.id, ESTADOS_EM_ABERTO, { estado: 'FAILED_RETRYABLE', chamando_em: null, ultimo_erro: `reconciliado: pagamento ${status ?? '?'} na Asaas, sem estorno` })) ?? op;
    }
    return op;
  }

  const estornos = await deps.listarEstornosDaCobranca(op.charge_id);
  const validos = (estornos ?? []).filter((e) => e && e.status !== 'CANCELLED');
  const cobrado = emCentavos(cobranca.valor_cobrado);
  const totalNaAsaas = validos.reduce((s, e) => s + (emCentavos(e.value) ?? 0), 0);

  const comMarcador = validos.find((e) => typeof e.description === 'string' && e.description.includes(op.marcador));
  const operacoes = await deps.operacoesDaCobranca(op.cobranca_id);
  const conhecido = restanteEstornavel(cobranca, operacoes, op.id);
  const outrasEmAberto = operacoes.filter((o) => o.id !== op.id && ESTADOS_EM_ABERTO.includes(o.estado)).length;
  const delta = totalNaAsaas - (conhecido?.jaEstornado ?? 0);

  let provou = null;
  if (comMarcador) provou = 'marcador';
  else if (outrasEmAberto === 0 && delta === Number(op.valor_centavos)) provou = 'valor';

  if (provou) {
    const depois = Math.min(cobrado ?? totalNaAsaas, totalNaAsaas);
    const statusDepois = cobrado != null && depois >= cobrado ? 'estornado' : 'estornado_parcialmente';
    const confirmada = await deps.transitar(op.id, ESTADOS_EM_ABERTO, {
      estado: 'CONFIRMED', status_resultado: statusDepois, valor_estornado_depois: emReais(depois),
      chamando_em: null, ultimo_erro: provou === 'valor' ? 'reconciliado pelo valor (o marcador não voltou na lista da Asaas)' : null
    });
    /* A cobrança também passa a dizer o que a Asaas fez — o webhook do
       estorno provavelmente já fez isso, e a gravação é CAS e só sobe o
       valor (`registrarEstorno`): repetir não desfaz nada. */
    if (confirmada) await deps.registrarNaCobrancaSemSoltar(op.charge_id, { status: statusDepois, valorEstornado: emReais(depois) });
    return confirmada ?? op;
  }

  if (delta === 0 && idadeMin >= MINUTOS_ATE_PROVAR_AUSENCIA) {
    return (await deps.transitar(op.id, ESTADOS_EM_ABERTO, {
      estado: 'FAILED_RETRYABLE', chamando_em: null,
      ultimo_erro: `reconciliado: nenhum estorno com o marcador nem valor novo na Asaas depois de ${Math.floor(idadeMin)} min`
    })) ?? op;
  }

  if (idadeMin >= MINUTOS_ATE_ALERTAR) {
    await deps.registrarErro(
      new Error(`estorno ${op.id} (cobrança ${op.charge_id}) em ${op.estado} há ${Math.floor(idadeMin)} min e a Asaas não permite decidir: ` +
        `delta de ${delta} centavos para uma operação de ${op.valor_centavos}, ${outrasEmAberto} outra(s) em aberto. Conferir na Asaas antes de qualquer ação.`),
      { contexto: 'estornoService.reconciliar', rota: 'worker/estornos', metodo: 'WORKER' }
    );
  }
  return op;
}

/** Uma passada do reconciliador de estornos (worker). Idempotente por CAS. */
export async function reconciliarEstornosUmaVez(deps = dependenciasPadrao) {
  const relatorio = { examinadas: 0, confirmadas: 0, liberadas: 0, aguardando: 0, falhas: 0 };
  for (const op of await deps.operacoesParaReconciliar()) {
    relatorio.examinadas += 1;
    try {
      const depois = await reconciliarOperacao(op, deps);
      if (depois.estado === 'CONFIRMED') relatorio.confirmadas += 1;
      else if (depois.estado === 'FAILED_RETRYABLE') relatorio.liberadas += 1;
      else relatorio.aguardando += 1;
    } catch (erro) {
      relatorio.falhas += 1;
      console.error(`[estornos] reconciliação de ${op.id} falhou:`, erro.message);
    }
  }
  return relatorio;
}

/* ------------------------------------------------------------ execução */

/**
 * Executa (ou devolve) UM pedido de estorno.
 *
 * @param {object} p
 * @param {object} p.contratante
 * @param {object} p.cobranca  a linha escolhida (estornável)
 * @param {string} p.chave     chave de idempotência (do contratante, ou derivada no total)
 * @param {number|null} p.valorCentavos  null = total (o que faltar)
 * @param {object} gancho      { reivindicar, liberar, registrarNaCobranca } — o arrendamento
 *                             da cobrança e a gravação do estado nela (refundController)
 * @returns {Promise<{http:number, corpo:object, efeito?: object}>}
 */
export async function executarEstorno({ contratante, cobranca, chave, valorCentavos }, gancho, deps = dependenciasPadrao) {
  const total = valorCentavos == null;
  const pedido = { cobrancaId: cobranca.id, total, valorCentavos };

  let op = await deps.buscarOperacao(contratante.id, chave);
  if (op) {
    if (!mesmoPedido(op, pedido)) {
      return { http: 409, corpo: { codigo: 'chave_idempotencia_reutilizada', erro: 'Esta chaveIdempotencia já foi usada num estorno diferente (outra cobrança ou outro valor). Use uma chave nova para um estorno novo.' } };
    }
    if (op.estado === 'CONFIRMED') return respostaDaOperacao(op, { replay: true });
    if (op.estado === 'FAILED_FINAL') {
      return { http: 409, corpo: { codigo: 'estorno_impossivel', erro: op.ultimo_erro ?? 'Este estorno não pode mais ser feito.' } };
    }
    if (ESTADOS_EM_ABERTO.includes(op.estado)) {
      op = await reconciliarOperacao(op, deps);
      if (op.estado === 'CONFIRMED') return respostaDaOperacao(op, { replay: true });
      if (op.estado !== 'FAILED_RETRYABLE') {
        return { http: 409, corpo: { codigo: 'estorno_em_reconciliacao', erro: 'Um estorno com esta chave está em andamento ou sem confirmação da Asaas. Consulte de novo em alguns minutos — ele não será repetido às cegas.' } };
      }
    }
    // FAILED_RETRYABLE: provado que nada foi estornado — a mesma chave tenta de novo.
  }

  if (!(await gancho.reivindicar(cobranca.charge_id))) {
    return { http: 409, corpo: { erro: 'Esta cobrança não pode ser estornada agora — já foi estornada, ainda não foi confirmada, ou um estorno já está em andamento.' } };
  }

  let chamou = false;
  try {
    /* Relida DEPOIS do arrendamento: a linha que o controlador carregou
       pode ter mudado (um webhook de estorno no meio). Com o arrendamento
       na mão, nenhum outro estorno NOSSO desta cobrança anda em paralelo. */
    const atual = (await deps.buscarCobrancaDaOperacao(cobranca.id)) ?? cobranca;
    const operacoes = await deps.operacoesDaCobranca(cobranca.id);
    const conta = restanteEstornavel(atual, operacoes, op?.id ?? null);
    if (!conta) {
      await gancho.liberar(cobranca.charge_id);
      return { http: 400, corpo: { erro: 'Esta cobrança não tem valor cobrado registrado — estorno indisponível.' } };
    }
    const valor = total ? conta.restante : valorCentavos;
    if (valor <= 0 || valor > conta.restante) {
      await gancho.liberar(cobranca.charge_id);
      if (op) await deps.transitar(op.id, ['FAILED_RETRYABLE'], { estado: 'FAILED_FINAL', ultimo_erro: 'o restante estornável da cobrança já não comporta este estorno' });
      if (conta.emVoo > 0) {
        return { http: 409, corpo: { codigo: 'estorno_anterior_em_reconciliacao', erro: `Há estorno anterior desta cobrança ainda sem confirmação da Asaas (R$ ${emReais(conta.emVoo).toFixed(2)}) — o restante só é conhecido depois dele. Tente em alguns minutos.` } };
      }
      return { http: 400, corpo: { erro: total ? 'Não há valor restante a estornar nesta cobrança.' : `valor do estorno (R$ ${emReais(valor).toFixed(2)}) maior que o restante estornável (R$ ${emReais(conta.restante).toFixed(2)}).` } };
    }

    if (!op) {
      // O id nasce aqui para o marcador nascer certo já no INSERT.
      const id = deps.novoId();
      const ins = await deps.inserirOperacao({
        id, cobranca_id: cobranca.id, contratante_id: contratante.id, charge_id: cobranca.charge_id,
        chave_idempotencia: chave, valor_centavos: valor, total, estado: 'PENDING', marcador: marcadorDoEstorno(id)
      });
      if (ins.conflito) {
        // A mesma chave, em paralelo: a outra requisição é a dona.
        await gancho.liberar(cobranca.charge_id);
        return { http: 409, corpo: { codigo: 'estorno_em_reconciliacao', erro: 'Um estorno com esta chave já está em andamento.' } };
      }
      op = ins.operacao;
    }

    const marcador = marcadorDoEstorno(op.id);
    const reivindicada = await deps.transitar(op.id, ['PENDING', 'FAILED_RETRYABLE'], {
      estado: 'CALLING_PROVIDER', chamando_em: new Date(deps.agora()).toISOString(),
      tentativas: Number(op.tentativas ?? 0) + 1, marcador, valor_centavos: valor
    });
    if (!reivindicada) {
      await gancho.liberar(cobranca.charge_id);
      return { http: 409, corpo: { codigo: 'estorno_em_reconciliacao', erro: 'Um estorno com esta chave já está em andamento.' } };
    }
    op = reivindicada;

    chamou = true;
    let assincrono;
    try {
      ({ assincrono } = await deps.estornarCobranca(cobranca.charge_id, {
        metodoPagamento: cobranca.metodo_pagamento,
        valor: total ? null : emReais(valor),
        descricao: marcador
      }));
    } catch (erroAsaas) {
      if (deps.foiRecusaLimpaDaAsaas(erroAsaas)) {
        await deps.transitar(op.id, ['CALLING_PROVIDER'], { estado: 'FAILED_RETRYABLE', chamando_em: null, ultimo_erro: `recusa da Asaas: ${erroAsaas.message}` });
        await gancho.liberar(cobranca.charge_id);
      } else {
        await deps.transitar(op.id, ['CALLING_PROVIDER'], { estado: 'UNKNOWN_PROVIDER_RESULT', ultimo_erro: erroAsaas.message });
        await deps.registrarErro(
          new Error(`estorno ${op.id}: chamada à Asaas AMBÍGUA para a cobrança ${cobranca.charge_id} — NÃO SE SABE se o estorno foi processado. ` +
            `A operação ficou em UNKNOWN_PROVIDER_RESULT e só a reconciliação (marcador "${marcador}" em GET /v3/payments/{id}/refunds) decide; ` +
            `repetir com a mesma chave não estorna de novo: ${erroAsaas.message}`),
          { contexto: 'refundController.estornar', rota: 'checkout/estornar', metodo: 'POST' }
        );
      }
      throw erroAsaas;
    }

    const acumulado = conta.jaEstornado + valor;
    const statusLocal = assincrono ? 'estorno_solicitado' : (acumulado >= conta.cobrado ? 'estornado' : 'estornado_parcialmente');
    const valorEstornadoDepois = assincrono ? null : emReais(Math.min(acumulado, conta.cobrado));
    const confirmada = await deps.transitar(op.id, ['CALLING_PROVIDER'], {
      estado: 'CONFIRMED', chamando_em: null, status_resultado: statusLocal, valor_estornado_depois: valorEstornadoDepois
    });
    await gancho.registrarNaCobranca(cobranca.charge_id, { status: statusLocal, valorEstornado: assincrono ? undefined : valorEstornadoDepois });

    const final = confirmada ?? { ...op, estado: 'CONFIRMED', status_resultado: statusLocal, valor_estornado_depois: valorEstornadoDepois };
    return { ...respostaDaOperacao(final), efeito: { statusLocal, valorEstornadoDepois, assincrono } };
  } catch (erro) {
    // Falha ANTES de ir à Asaas (banco): nada saiu, o arrendamento volta.
    if (!chamou) await gancho.liberar(cobranca.charge_id).catch(() => {});
    throw erro;
  }
}
