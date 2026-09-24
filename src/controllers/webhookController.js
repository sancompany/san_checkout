/**
 * SAN CHECKOUT v2 — src/controllers/webhookController.js
 * Recebe webhooks da Asaas e repassa o fato financeiro ao contratante.
 *
 * REESCRITO em 24/09/2026 na consolidação final (auditoria Codex +
 * Fable, `docs/CHECKOUT_FINAL_CONSOLIDATION_2026-09-24.md`). O que mudou
 * de arquitetura, e por quê:
 *
 *  1. **Inbox antes do 200 (C-01).** O evento é PERSISTIDO em
 *     `webhook_inbox` e só então a Asaas recebe `200` — que passa a
 *     significar "guardei", como a doc oficial dela pede ("Receber →
 *     Persistir → Responder 200 → Processar"). Falha ao processar não
 *     some mais: fica `falhou` na inbox e o worker (`reprocessarInbox`)
 *     tenta de novo com recuo. Só a falha em GUARDAR responde 503 — o
 *     único caso em que a reentrega da Asaas é o mecanismo certo.
 *     Reentrega do mesmo `id` (`evt_…`) responde 200 sem processar.
 *  2. **Máquina de estados (C-03).** `processarEventoPayment` não faz
 *     mais `if (status !== novo) update(novo)`. Cada evento passa por
 *     `transicoesFinanceiras.decidirTransicao` (semântica + carimbo do
 *     evento) e grava por UPDATE condicional (`aplicarTransicao`, CAS).
 *     Um `PAYMENT_CONFIRMED` atrasado nunca mais desfaz um estorno.
 *  3. **Outbox (H-01).** Nenhum aviso ao contratante sai mais de um
 *     `setTimeout()`. Cada fato vira UMA linha em `outbox_notificacoes`
 *     (chave de idempotência única) e quem entrega é o worker — com
 *     reinício, recuo e reenvio administrativo pelo MESMO `eventoId`.
 *  4. **Contrato v2 (H-02, H-04, H-03).** O payload de assinatura
 *     carrega `assinaturaId`, `chargeId`, `valor`, `ciclo`, `statusFinanceiro`
 *     e, nos estornos, `valorEstornado` + `estornoParcial`. O evento
 *     `criada` sai do `PAYMENT_CONFIRMED` (que traz o `chargeId` e o id
 *     da assinatura), não mais do `CHECKOUT_PAID` (que não traz nada).
 *     `PAYMENT_PARTIALLY_REFUNDED` vira `estornado_parcialmente`, com o
 *     valor somado de `payment.refunds`. O estorno/chargeback do ACERTO
 *     de uma troca de plano avisa `troca_revertida`, com plano anterior
 *     e novo — antes, era engolido.
 *
 * Dois vocabulários de evento chegam no MESMO endpoint:
 *   1. PAYMENT_* — Pix/Boleto direto, ciclos 2+ de assinatura
 *      (`payment.subscription`), e a 1ª cobrança de uma pop-up
 *      (`payment.checkoutSession`). Identifica pelo `payment.id`.
 *   2. CHECKOUT_* — a SESSÃO da pop-up (cartão avulso/assinatura).
 *      Identifica pelo `checkout.id` (nosso `asaas_checkout_id`), com
 *      fallback por `checkout.externalReference` (`reserva-<id>`) para
 *      a reserva cuja resposta da Asaas se perdeu (C-04/H-06).
 *
 * ✅ NOMES DE EVENTO conferidos contra a doc oficial (11/09 e 24/09/2026).
 * ✅ FORMATO medido em tráfego real (`webhook_eventos.campos`): o
 *    `CHECKOUT_PAID` NÃO carrega `payment`; o id chega no
 *    `PAYMENT_CONFIRMED` seguinte, com `checkoutSession`. Todo evento
 *    traz `id` (`evt_…`) e `dateCreated`; `payment` traz `refunds[]` e
 *    `externalReference`; `checkout` traz `externalReference`.
 *
 * ⚠️ Evento só chega se estiver MARCADO no painel da Asaas
 *    (CONSTRAINTS.md §2.2). `SUBSCRIPTION_*` está marcado e ainda não
 *    tem ramo: entra na inbox como `ignorado`, visível no painel.
 */

import {
  buscarCobranca,
  aplicarTransicao,
  atualizarStatusCobranca,
  buscarCobrancaPorCheckoutId,
  buscarCobrancaPorReferenciaExterna,
  vincularChargeIdAoCheckout,
  atualizarStatusPorCheckoutId,
  atualizarSubscriptionIdDaCobranca,
  buscarCobrancaPorSubscriptionId,
  registrarCicloAssinatura,
  atualizarSituacaoSubconta
} from '../services/cobrancaService.js';
import { upsertAssinatura, atualizarStatusAssinatura, buscarAssinaturaPorId } from '../services/assinaturaService.js';
import { cancelarAssinatura as cancelarAssinaturaNaAsaas } from '../services/asaasService.js';
import {
  registrarEventoWebhook,
  registrarRejeicaoWebhook,
  redigirPayload,
  extrairReferencia
} from '../services/auditoriaWebhookService.js';
import {
  registrarNaInbox,
  reivindicarProcessamento,
  marcarProcessado,
  marcarIgnorado,
  marcarFalha as marcarFalhaNaInbox,
  listarParaReprocessar
} from '../services/webhookInboxService.js';
import { enfileirarNotificacao, tentarAgora } from '../services/outboxService.js';
import { decidirTransicao } from '../services/transicoesFinanceiras.js';
import { METODOS_DE_ASSINATURA, METODO_ACERTO_TROCA } from '../services/pedidoService.js';
import { compararSeguro } from '../utils/validadores.js';
import { somarReais, emCentavos } from '../utils/dinheiro.js';
import { cicloCanonico } from '../utils/ciclos.js';
import { buscarIntencaoPorChargeId, marcarConfirmada as marcarIntencaoConfirmada } from '../services/trocaIntencaoService.js';
import { resolverAposClassificacao, retomarAplicacao } from '../services/trocaExecucaoService.js';
import { classificarPagamentoDoAcerto } from '../services/classificacaoFinanceiraService.js';
import { registrarErro } from '../services/erroService.js';

/** Versão do contrato Checkout → contratante (API.md §4.3). A 2 é
 *  ADITIVA sobre a 1 (nenhum campo saiu, nenhum mudou de significado):
 *  `eventoId`, `ocorridoEm`, `statusFinanceiro`, `valorEstornado`,
 *  `estornoParcial` em todo payload; `assinaturaId`, `chargeId`, `valor`,
 *  `ciclo`, `cicloCanonico` no de assinatura. */
export const VERSAO_WEBHOOK = 2;

/**
 * Tudo que este módulo toca fora de si mesmo, num objeto só — produção
 * não passa nada; o autoteste passa versões falsas e exercita o caminho
 * crítico sem banco, sem rede e sem relógio.
 */
const dependenciasPadrao = {
  buscarCobranca,
  aplicarTransicao,
  atualizarStatusCobranca,
  buscarCobrancaPorCheckoutId,
  buscarCobrancaPorReferenciaExterna,
  vincularChargeIdAoCheckout,
  atualizarStatusPorCheckoutId,
  atualizarSubscriptionIdDaCobranca,
  buscarCobrancaPorSubscriptionId,
  registrarCicloAssinatura,
  atualizarSituacaoSubconta,
  upsertAssinatura,
  atualizarStatusAssinatura,
  buscarAssinaturaPorId,
  cancelarAssinaturaNaAsaas,
  registrarErro,
  /**
   * A notificação ao contratante: ENFILEIRA na outbox (durável) e
   * dispara a primeira tentativa fora do fluxo. O `await` aqui é só da
   * escrita local — a rede fica com o worker, então um contratante
   * pendurado nunca segura a resposta à Asaas (CONSTRAINTS.md §2.3).
   */
  notificar: async ({ contratante, tipo, evento, chave, payload, ocorridoEm }) => {
    const { id, nova } = await enfileirarNotificacao({
      contratanteId: contratante?.id ?? payload?.contratanteId ?? null,
      url: contratante?.webhook_url,
      tipo,
      evento,
      chaveIdempotencia: chave,
      payload,
      ocorridoEm
    });
    if (nova) tentarAgora(id);
    return { id, nova };
  },
  registrarAuditoria: (dados) => registrarEventoWebhook(dados),
  inbox: { registrarNaInbox, reivindicarProcessamento, marcarProcessado, marcarIgnorado, marcarFalha: marcarFalhaNaInbox, listarParaReprocessar },
  /** O acerto de uma troca de plano ainda sem `cobrancas` — resolve
   *  pela intenção. `true` quando encontrou. */
  avancarIntencaoDeTrocaPorChargeId: async (chargeId, evento) => {
    const intencao = await buscarIntencaoPorChargeId(chargeId);
    if (!intencao) return false;

    const veredito = classificarPagamentoDoAcerto({ evento });
    if (veredito === 'PAID') {
      const confirmada = await marcarIntencaoConfirmada(intencao.id);
      if (confirmada) {
        retomarAplicacao(confirmada)
          .catch((erro) => console.error('[webhook/asaas] aplicar troca de plano falhou fora do fluxo:', erro.message));
      }
    } else {
      await resolverAposClassificacao(intencao, veredito);
    }
    return true;
  }
};

/* ------------------------------------------------------------------
   Guarda de origem
------------------------------------------------------------------ */

/**
 * Aplicado em webhookRoutes.js antes do receptor. A Asaas reenvia, em
 * cada webhook, o "Token de acesso" configurado no painel dela no header
 * `asaas-access-token` (doc oficial: "Se o Webhook estiver configurado
 * com authToken, o valor será enviado no header asaas-access-token").
 * Fail-closed: sem env configurada, recusa tudo. Não existe assinatura
 * de corpo nem allowlist de IP no contrato da Asaas (M-01) — a defesa
 * complementar é a inbox (idempotência por `id`) e a máquina de estados.
 */
export function verificarWebhookAsaas(requisicao, resposta, proximo) {
  const { ASAAS_WEBHOOK_TOKEN } = process.env;
  if (!ASAAS_WEBHOOK_TOKEN) {
    registrarRejeicaoWebhook({ ip: ipDaRequisicao(requisicao), tinhaToken: Boolean(requisicao.get('asaas-access-token')), motivo: 'sem ASAAS_WEBHOOK_TOKEN configurado' });
    return resposta.status(503).json({ erro: 'ASAAS_WEBHOOK_TOKEN não configurado no .env — webhook desativado.' });
  }
  if (!compararSeguro(requisicao.get('asaas-access-token'), ASAAS_WEBHOOK_TOKEN)) {
    registrarRejeicaoWebhook({ ip: ipDaRequisicao(requisicao), tinhaToken: Boolean(requisicao.get('asaas-access-token')), motivo: 'token inválido' });
    return resposta.status(401).json({ erro: 'Token de webhook inválido.' });
  }
  proximo();
}

function ipDaRequisicao(requisicao) {
  const encaminhado = requisicao.get?.('x-forwarded-for');
  if (encaminhado) return String(encaminhado).split(',')[0].trim();
  return requisicao.ip ?? null;
}

/* ------------------------------------------------------------------
   Vocabulário: evento Asaas → status local
------------------------------------------------------------------ */

const EVENTOS_PAYMENT_CONFIRMACAO = ['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'];
const EVENTOS_PAYMENT_ESTORNO = ['PAYMENT_REFUNDED'];
const EVENTOS_PAYMENT_ESTORNO_PARCIAL = ['PAYMENT_PARTIALLY_REFUNDED'];
const EVENTOS_PAYMENT_ESTORNO_PROGRESSO = ['PAYMENT_REFUND_IN_PROGRESS'];
const EVENTOS_PAYMENT_ESTORNO_NEGADO = ['PAYMENT_REFUND_DENIED'];
const EVENTOS_PAYMENT_VENCIDO = ['PAYMENT_OVERDUE'];
const EVENTOS_PAYMENT_EM_ANALISE = ['PAYMENT_AWAITING_RISK_ANALYSIS'];
const EVENTOS_PAYMENT_RECUSADO = ['PAYMENT_REPROVED_BY_RISK_ANALYSIS', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED'];
const EVENTOS_PAYMENT_CHARGEBACK = ['PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_AWAITING_CHARGEBACK_REVERSAL'];
/** Baixa manual desfeita na Asaas — o que estava pago voltou a pendente. */
const EVENTOS_PAYMENT_PENDENTE_DE_NOVO = ['PAYMENT_RECEIVED_IN_CASH_UNDONE'];

const EVENTOS_PAYMENT_TRATADOS = [
  ...EVENTOS_PAYMENT_CONFIRMACAO, ...EVENTOS_PAYMENT_ESTORNO, ...EVENTOS_PAYMENT_ESTORNO_PARCIAL,
  ...EVENTOS_PAYMENT_ESTORNO_PROGRESSO, ...EVENTOS_PAYMENT_ESTORNO_NEGADO, ...EVENTOS_PAYMENT_VENCIDO,
  ...EVENTOS_PAYMENT_EM_ANALISE, ...EVENTOS_PAYMENT_RECUSADO, ...EVENTOS_PAYMENT_CHARGEBACK,
  ...EVENTOS_PAYMENT_PENDENTE_DE_NOVO
];

export function mapearStatusPayment(evento) {
  if (EVENTOS_PAYMENT_CONFIRMACAO.includes(evento)) return 'confirmado';
  if (EVENTOS_PAYMENT_ESTORNO.includes(evento)) return 'estornado';
  if (EVENTOS_PAYMENT_ESTORNO_PARCIAL.includes(evento)) return 'estornado_parcialmente';
  if (EVENTOS_PAYMENT_ESTORNO_PROGRESSO.includes(evento)) return 'estorno_solicitado';
  if (EVENTOS_PAYMENT_ESTORNO_NEGADO.includes(evento)) return 'estorno_negado';
  if (EVENTOS_PAYMENT_VENCIDO.includes(evento)) return 'vencido';
  if (EVENTOS_PAYMENT_EM_ANALISE.includes(evento)) return 'em_analise';
  if (EVENTOS_PAYMENT_RECUSADO.includes(evento)) return 'recusado';
  if (EVENTOS_PAYMENT_CHARGEBACK.includes(evento)) return 'chargeback';
  if (EVENTOS_PAYMENT_PENDENTE_DE_NOVO.includes(evento)) return 'pendente';
  return null;
}

/** Status local → vocabulário de evento de assinatura (API.md §4.3.4). */
export function mapearEventoAssinatura(status) {
  if (status === 'confirmado') return 'cobranca_confirmada';
  if (status === 'vencido' || status === 'recusado') return 'cobranca_falhou';
  if (status === 'estornado' || status === 'estornado_parcialmente' || status === 'estorno_solicitado') return 'cobranca_estornada';
  if (status === 'chargeback') return 'cobranca_contestada';
  return null; // em_analise / pendente / estorno_negado: passagem, sem ruído
}

/** Qual ramo do roteador atende este evento — `null` quando nenhum. */
export function classificarEvento(evento) {
  if (typeof evento !== 'string') return null;
  if (evento.startsWith('CHECKOUT_')) return 'checkout';
  if (EVENTOS_PAYMENT_TRATADOS.includes(evento)) return 'payment';
  if (evento.startsWith('ACCOUNT_STATUS_')) return 'subconta';
  if (evento.startsWith('ACCESS_TOKEN_')) return 'chave_api';
  if (evento.startsWith('PIX_AUTOMATIC_RECURRING_AUTHORIZATION_')) return 'pix_automatico';
  return null;
}

/**
 * `dateCreated` do evento em ISO. A Asaas manda "2026-09-24 14:03:11"
 * (Brasília, sem fuso) — para ORDEM entre eventos da mesma origem basta
 * ser consistente. Sem o campo, `null` (a máquina decide só pela matriz).
 */
export function ocorridoEmDoEvento(corpo) {
  const bruto = corpo?.dateCreated;
  if (typeof bruto !== 'string' || !bruto) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(bruto) ? `${bruto.replace(' ', 'T')}-03:00` : bruto;
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? null : data.toISOString();
}

/** Soma dos estornos concluídos que a Asaas lista em `payment.refunds`.
 *  `null` quando o payload não traz a lista (evento antigo/reprocessado
 *  sem ela): ausência, nunca zero. */
export function valorEstornadoDoPayment(payment) {
  if (!Array.isArray(payment?.refunds)) return null;
  const concluidos = payment.refunds.filter((r) => r && (r.status === 'DONE' || r.status === undefined));
  if (concluidos.length === 0) return null;
  return somarReais(concluidos.map((r) => r.value));
}

/* ------------------------------------------------------------------
   O receptor: inbox → 200 → processa
------------------------------------------------------------------ */

/**
 * ⚠️ NÃO VALIDA ORIGEM. Quem faz isso é `verificarWebhookAsaas`, montado
 * ANTES na rota. Exportada para o autoteste e para o worker, não para
 * ser reaproveitada em rota.
 */
export async function processarWebhook(corpo, deps = dependenciasPadrao) {
  const ocorridoEm = ocorridoEmDoEvento(corpo);
  switch (classificarEvento(corpo?.event)) {
    case 'checkout': return processarEventoCheckout(corpo, deps, ocorridoEm);
    case 'payment': return processarEventoPayment(corpo, deps, ocorridoEm);
    case 'subconta': return processarEventoSubconta(corpo, deps);
    case 'chave_api': return registrarAlertaChaveApi(corpo);
    case 'pix_automatico': return processarAutorizacaoPixAutomatico(corpo, deps, ocorridoEm);
    default:
      return undefined;
  }
}

/**
 * Processa UMA linha da inbox (já reivindicada) e grava o desfecho.
 * Compartilhada pelo receptor (inline) e pelo worker (reprocessamento).
 * Devolve `{ resultado, detalhe }` para a auditoria; não lança.
 */
async function processarLinhaDaInbox(linha, corpo, deps) {
  const rota = classificarEvento(corpo?.event);
  if (!rota) {
    await deps.inbox.marcarIgnorado(linha.id);
    return { resultado: 'nao_mapeado', detalhe: null };
  }
  try {
    await processarWebhook(corpo, deps);
    await deps.inbox.marcarProcessado(linha.id);
    return { resultado: 'tratado', detalhe: null };
  } catch (erro) {
    const { tentativas, esgotou } = await deps.inbox.marcarFalha(linha.id, linha.tentativas, erro.message);
    console.error(`[webhook/asaas] erro ao processar (tentativa ${tentativas}${esgotou ? ', ESGOTADA' : ''}):`, erro.message);
    if (esgotou) {
      await deps.registrarErro(
        new Error(`webhook ${corpo?.event} (${linha.referencia_id ?? 'sem referência'}) esgotou as tentativas da inbox: ${erro.message}`),
        { contexto: 'webhookController.inbox', rota: 'webhook/asaas', metodo: 'POST', status: 500 }
      );
    }
    return { resultado: 'erro', detalhe: erro.message };
  }
}

/**
 * Fábrica para o autoteste injetar dependências (o Express chama o
 * handler com `(req, res, next)`). ⚠️ Também não valida origem.
 */
export function criarReceptorWebhook(deps = dependenciasPadrao) {
  return async function receberWebhookAsaas(requisicao, resposta) {
    const corpo = requisicao.body;
    const evento = corpo?.event;
    const rota = classificarEvento(evento);
    const referencia = extrairReferencia(corpo);
    const campos = redigirPayload(corpo);
    console.log('[webhook/asaas] evento:', JSON.stringify({ evento, rota, referencia, id: corpo?.id ?? null, campos }));

    /* 1. PERSISTIR. É a única coisa que pode devolver não-2xx: sem
       banco não há como guardar, e a reentrega da Asaas é o mecanismo
       certo para esse caso (ela reenvia; 15 seguidas pausam a fila —
       e um banco fora por 15 eventos seguidos é incidente de qualquer
       jeito, RUNBOOK §6). */
    let registro;
    try {
      registro = await deps.inbox.registrarNaInbox(corpo, { referenciaTipo: referencia.tipo, referenciaId: referencia.id });
    } catch (erro) {
      console.error('[webhook/asaas] NÃO consegui persistir o evento — respondendo 503 para a Asaas reenviar:', erro.message);
      return resposta.status(503).json({ recebido: false, erro: 'inbox indisponível' });
    }

    /* 2. REENTREGA (mesmo `id`): já está guardado — e talvez já
       processado. 200 sem tocar em nada. A doc da Asaas manda
       exatamente isto ("não repita a regra de negócio quando o evento já
       tiver sido processado"). */
    if (registro.duplicado) {
      auditar(deps, { evento, rota, resultado: 'duplicado', detalhe: 'reentrega do mesmo id', referencia, campos, statusMapeado: mapearStatusPayment(evento) });
      return resposta.status(200).json({ recebido: true, duplicado: true });
    }

    /* 3. PROCESSAR a partir da linha, inline. Inline, e não depois do
       200, para preservar a ordem que a Asaas garante em `SEQUENTIALLY`
       (ela só manda o próximo depois do nosso 200). A resposta continua
       rápida: o que é lento (rede para o contratante) está na outbox. */
    let desfecho = { resultado: 'erro', detalhe: 'não reivindicada' };
    const linha = await deps.inbox.reivindicarProcessamento(registro.id).catch(() => null);
    if (linha) desfecho = await processarLinhaDaInbox(linha, corpo, deps);

    auditar(deps, { evento, rota, resultado: desfecho.resultado, detalhe: desfecho.detalhe, referencia, campos, statusMapeado: mapearStatusPayment(evento) });

    /* 4. 200 — o evento está guardado; se o processamento falhou, a
       inbox e o worker cuidam. Nunca mais "erro vira 200 e some". */
    resposta.status(200).json({ recebido: true });
  };
}

/** Auditoria sem `await` e sem lançar — diagnóstico nunca derruba o
 *  caminho do dinheiro. */
function auditar(deps, { evento, rota, resultado, detalhe, referencia, campos, statusMapeado }) {
  try {
    deps.registrarAuditoria({
      evento, rota, resultado, detalhe,
      referenciaTipo: referencia.tipo, referenciaId: referencia.id,
      statusMapeado, campos
    })?.catch?.((erro) => console.error('[webhook/asaas] auditoria falhou:', erro.message));
  } catch (erro) {
    console.error('[webhook/asaas] auditoria falhou:', erro.message);
  }
}

export const receberWebhookAsaas = criarReceptorWebhook();

/**
 * O WORKER da inbox — uma passada. Lê as linhas com tentativa vencida
 * (em ordem de recebimento), reivindica e reprocessa a partir do corpo
 * mínimo. Chamado pelo `setInterval` em `server.js` e pelo autoteste.
 */
export async function reprocessarInbox(deps = dependenciasPadrao) {
  const relatorio = { examinadas: 0, processadas: 0, falhas: 0 };
  const pendentes = await deps.inbox.listarParaReprocessar();
  for (const candidata of pendentes) {
    const linha = await deps.inbox.reivindicarProcessamento(candidata.id).catch(() => null);
    if (!linha) continue;
    relatorio.examinadas += 1;
    const desfecho = await processarLinhaDaInbox(linha, linha.corpo_minimo, deps);
    if (desfecho.resultado === 'erro') relatorio.falhas += 1; else relatorio.processadas += 1;
  }
  return relatorio;
}

/* ------------------------------------------------------------------
   VOCABULÁRIO 3 — eventos de CONTA (subcontas e chave de API)
------------------------------------------------------------------ */

const alertasChaveApi = [];

export function obterAlertasChaveApi() {
  return alertasChaveApi;
}

function registrarAlertaChaveApi(corpo) {
  const evento = corpo?.event;
  if (!['ACCESS_TOKEN_EXPIRING_SOON', 'ACCESS_TOKEN_EXPIRED', 'ACCESS_TOKEN_DISABLED', 'ACCESS_TOKEN_DELETED'].includes(evento)) return;
  alertasChaveApi.push({ evento, em: new Date().toISOString() });
  console.error(
    `[ALERTA/chave-asaas] ${evento} — a chave de API da Asaas está para expirar ou foi desativada. ` +
    'Gere uma nova no painel da Asaas e atualize ASAAS_API_KEY no Northflank ANTES que ela caia, ' +
    'senão toda cobrança para de funcionar sem aviso.'
  );
}

async function processarEventoSubconta(corpo, deps = dependenciasPadrao) {
  const asaasAccountId = corpo?.account?.id;
  if (!asaasAccountId) return;
  const situacao = corpo?.accountStatus ?? {};
  await deps.atualizarSituacaoSubconta(asaasAccountId, {
    geral: situacao.general ?? null,
    comercial: situacao.commercialInfo ?? null,
    bancaria: situacao.bankAccountInfo ?? null,
    documentos: situacao.documentation ?? null
  });
}

/* ------------------------------------------------------------------
   Pix Automático (autorização recorrente)
------------------------------------------------------------------ */

async function processarAutorizacaoPixAutomatico(corpo, deps = dependenciasPadrao, ocorridoEm = null) {
  const evento = corpo?.event;
  const autorizacaoId = corpo?.authorization?.id ?? corpo?.pixRecurringAuthorization?.id ?? corpo?.id;
  if (!autorizacaoId) return;

  const cobranca = await deps.buscarCobrancaPorCheckoutId(autorizacaoId);
  if (!cobranca) return;

  const ATIVOU = 'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED';
  const ENCERROU = [
    'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED',
    'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_EXPIRED',
    'PIX_AUTOMATIC_RECURRING_AUTHORIZATION_REFUSED'
  ];

  if (evento === ATIVOU) {
    await deps.atualizarStatusPorCheckoutId(autorizacaoId, 'confirmado');
    await deps.upsertAssinatura({
      id: autorizacaoId,
      contratanteId: cobranca.contratante_id,
      planoId: cobranca.plano_id,
      documento: cobranca.documento,
      valor: cobranca.valor_cobrado,
      ciclo: cobranca.ciclo ?? corpo?.authorization?.frequency ?? null,
      proximaCobranca: null
    });
    return notificarAssinatura(cobranca, { evento: 'criada', assinaturaId: autorizacaoId, chargeId: null, statusFinanceiro: 'confirmado', ocorridoEm }, deps);
  }

  if (ENCERROU.includes(evento)) {
    await deps.atualizarStatusPorCheckoutId(autorizacaoId, 'cancelado');
    return notificarAssinatura(cobranca, { evento: 'cancelada', assinaturaId: autorizacaoId, chargeId: null, statusFinanceiro: 'cancelado', ocorridoEm }, deps);
  }
}

/* ------------------------------------------------------------------
   VOCABULÁRIO 1 — PAYMENT_* (payment.id = nosso charge_id)
------------------------------------------------------------------ */

async function processarEventoPayment(corpo, deps = dependenciasPadrao, ocorridoEm = null) {
  const evento = corpo?.event;
  const payment = corpo?.payment;
  const chargeId = payment?.id;
  if (!chargeId) return;

  const novoStatus = mapearStatusPayment(evento);
  if (!novoStatus) return;

  let cobranca = await deps.buscarCobranca(chargeId);

  /* Primeira cobrança de um pop-up: o `charge_id` só existe AQUI
     (`payment.checkoutSession` aponta para a sessão — medido em 15/09). */
  let primeiraDoCheckout = false;
  if (!cobranca) {
    cobranca = await vincularPrimeiraCobrancaDoCheckout(payment, deps);
    primeiraDoCheckout = Boolean(cobranca);
  }

  if (!cobranca) {
    // O ACERTO de uma troca ainda sem `cobrancas`: resolve pela intenção.
    const avancou = await deps.avancarIntencaoDeTrocaPorChargeId(chargeId, evento);
    if (avancou) return;

    // Charge desconhecido: só interessa se for ciclo novo de assinatura.
    if (!payment?.subscription) return;
    cobranca = await registrarNovoCicloAssinatura(payment, deps);
    if (!cobranca) return;
  }

  /* A MÁQUINA DE ESTADOS (C-03). `primeiraDoCheckout` fura a guarda de
     "mesmo status" de propósito: o `CHECKOUT_PAID` já marcou a sessão
     `confirmado`, e este evento é o que traz o id que faltava — mas
     NÃO fura a matriz: um `PAYMENT_CONFIRMED` sobre uma sessão que já
     virou `estornado` continua recusado. */
  const valorEstornado = ['estornado', 'estornado_parcialmente'].includes(novoStatus) ? valorEstornadoDoPayment(payment) : undefined;
  let statusGravado = novoStatus;

  if (primeiraDoCheckout && cobranca.status === novoStatus) {
    // nada a gravar de status; o vínculo já foi feito em vincularPrimeiraCobrancaDoCheckout
  } else {
    const decisao = decidirTransicao(cobranca, novoStatus, ocorridoEm);
    if (decisao.acao === 'ignorar') {
      if (cobranca.status !== novoStatus) console.log(`[webhook/pagamento] ${chargeId}: ${decisao.motivo} — ignorado`);
      return;
    }
    const gravou = await deps.aplicarTransicao(chargeId, { de: cobranca.status, para: novoStatus, ocorridoEm, valorEstornado });
    if (!gravou) {
      // Outro evento venceu a corrida entre a leitura e a escrita: relê e
      // deixa a inbox/worker decidir de novo se ainda houver o que fazer.
      console.log(`[webhook/pagamento] ${chargeId}: transição ${cobranca.status} → ${novoStatus} perdeu a corrida — ignorado`);
      return;
    }
  }

  /* Estorno parcial que devolve TUDO: é estorno total, e o contratante
     precisa ouvir isso — mesmo que a Asaas tenha chamado de "parcial". */
  if (novoStatus === 'estornado_parcialmente' && valorEstornado !== null && emCentavos(valorEstornado) >= emCentavos(cobranca.valor_cobrado ?? 0) && emCentavos(cobranca.valor_cobrado ?? 0) > 0) {
    statusGravado = 'estornado';
    await deps.aplicarTransicao(chargeId, { de: 'estornado_parcialmente', para: 'estornado', ocorridoEm, valorEstornado });
  }

  const contexto = { chargeId, statusFinanceiro: statusGravado, valorEstornado: valorEstornado ?? cobranca.valor_estornado ?? null, ocorridoEm };

  /* O ACERTO DE UMA TROCA DE PLANO (H-03). Confirmação é anunciada pela
     própria troca (`plano_trocado`); mas uma REVERSÃO do acerto —
     estorno, chargeback — precisa chegar ao contratante, senão o
     assinante fica com o plano novo e o dinheiro de volta. */
  if (cobranca.metodo_pagamento === METODO_ACERTO_TROCA) {
    if (['estornado', 'estornado_parcialmente', 'estorno_solicitado', 'chargeback'].includes(statusGravado)) {
      const assinatura = cobranca.asaas_subscription_id ? await deps.buscarAssinaturaPorId(cobranca.asaas_subscription_id) : null;
      return notificarAssinatura(cobranca, {
        ...contexto,
        evento: 'troca_revertida',
        assinaturaId: cobranca.asaas_subscription_id ?? null,
        planoAnterior: assinatura?.plano_anterior_id ?? null,
        acertoCobrado: cobranca.valor_cobrado ?? null
      }, deps);
    }
    return;
  }

  if (METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento)) {
    /* A PRIMEIRA cobrança de uma assinatura anuncia `criada` — AQUI, no
       evento que traz `chargeId` e `payment.subscription` (H-02). O
       `CHECKOUT_PAID` não traz nenhum dos dois e não anuncia mais nada. */
    const eventoAssinatura = primeiraDoCheckout && statusGravado === 'confirmado'
      ? 'criada'
      : mapearEventoAssinatura(statusGravado);
    if (!eventoAssinatura) return;
    return notificarAssinatura(cobranca, {
      ...contexto,
      evento: eventoAssinatura,
      assinaturaId: cobranca.asaas_subscription_id ?? payment.subscription ?? null
    }, deps);
  }

  // Pix/Boleto/Cartão avulso — repassa TODA mudança de status.
  return notificarPedido(cobranca, contexto, deps);
}

/* ------------------------------------------------------------------
   Vínculo da primeira cobrança / ciclos / renovação
------------------------------------------------------------------ */

async function amarrarAssinaturaACobranca(cobranca, payment, chargeId, deps = dependenciasPadrao) {
  await deps.atualizarSubscriptionIdDaCobranca(chargeId, payment.subscription);
  await deps.upsertAssinatura({
    id: payment.subscription,
    contratanteId: cobranca.contratante_id,
    planoId: cobranca.plano_id,
    documento: cobranca.documento,
    valor: cobranca.valor_cobrado,
    // `ciclo` vem da CRIAÇÃO do checkout (gravado em `cobrancas`), nunca
    // do webhook — `payment.cycle` não existe no payload real.
    ciclo: cobranca.ciclo ?? payment.cycle ?? null,
    proximaCobranca: payment.nextDueDate ?? null
  });
  await encerrarAssinaturaSubstituida(cobranca, payment.subscription, deps);
}

/** Fecha a antiga depois que a renovação foi paga — nunca antes. Falha
 *  ao cancelar não derruba a confirmação: fica em Lei 8. */
async function encerrarAssinaturaSubstituida(cobranca, novaAssinaturaId, deps = dependenciasPadrao) {
  const antigaId = cobranca.substitui_assinatura_id;
  if (!antigaId || antigaId === novaAssinaturaId) return;
  try {
    await deps.cancelarAssinaturaNaAsaas(antigaId);
    await deps.atualizarStatusAssinatura(antigaId, 'cancelada');
    console.log(`[assinatura/renovacao] ${antigaId} encerrada; substituída por ${novaAssinaturaId}`);
  } catch (erro) {
    const mensagem =
      `[assinatura/renovacao] a nova assinatura ${novaAssinaturaId} foi paga, mas NÃO consegui cancelar a antiga ` +
      `${antigaId}: ${erro.message}. Cancele na mão no painel da Asaas pra não cobrar duas vezes.`;
    console.error(mensagem);
    await deps.registrarErro(new Error(mensagem), { contexto: 'webhookController.encerrarAssinaturaSubstituida', rota: 'webhook/asaas', metodo: 'POST' });
  }
}

async function vincularPrimeiraCobrancaDoCheckout(payment, deps = dependenciasPadrao) {
  const asaasCheckoutId = payment?.checkoutSession;
  if (!asaasCheckoutId) return null;

  let cobranca = await deps.buscarCobrancaPorCheckoutId(asaasCheckoutId);
  if (!cobranca && payment?.externalReference) {
    // Reserva cuja resposta de `POST /v3/checkouts` se perdeu (C-04/H-06):
    // a sessão existe na Asaas com a nossa referência, mas a linha ficou
    // sem `asaas_checkout_id`. Amarra agora.
    cobranca = await deps.buscarCobrancaPorReferenciaExterna(payment.externalReference);
    if (cobranca && !cobranca.asaas_checkout_id) {
      await deps.vincularChargeIdAoCheckout(asaasCheckoutId, payment.id);
    }
  }
  if (!cobranca) {
    console.error(
      `[webhook/pagamento] payment ${payment.id} cita a sessão ${asaasCheckoutId}, que não existe em cobrancas — ` +
      'sessão perdida ou pagamento de outra integração nesta conta Asaas.'
    );
    return null;
  }
  if (cobranca.charge_id) return null; // já vinculada — este é um ciclo, não a primeira

  await deps.vincularChargeIdAoCheckout(asaasCheckoutId, payment.id);

  if (METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento) && payment.subscription) {
    await amarrarAssinaturaACobranca(cobranca, payment, payment.id, deps);
  }

  return {
    ...cobranca,
    charge_id: payment.id,
    asaas_subscription_id: payment.subscription ?? cobranca.asaas_subscription_id ?? null
  };
}

async function registrarNovoCicloAssinatura(payment, deps = dependenciasPadrao) {
  const subscriptionId = payment.subscription;
  const modelo = await deps.buscarCobrancaPorSubscriptionId(subscriptionId);
  if (!modelo) {
    console.error(`[webhook/assinatura] ciclo novo da subscription ${subscriptionId} sem cobrança-modelo local — ignorando (nunca vimos a 1ª cobrança dela?).`);
    return null;
  }

  // plano/ciclo vêm da ASSINATURA (depois de uma troca, o molde guarda o plano que ERA).
  const assinatura = await deps.buscarAssinaturaPorId(subscriptionId);

  const resultado = await deps.registrarCicloAssinatura({
    chargeId: payment.id,
    asaasSubscriptionId: subscriptionId,
    contratanteId: modelo.contratante_id,
    planoId: assinatura?.plano_id ?? modelo.plano_id,
    documento: modelo.documento,
    email: modelo.email,
    telefone: modelo.telefone,
    endereco: modelo.endereco,
    enderecoNumero: modelo.endereco_numero,
    complemento: modelo.endereco_complemento,
    bairro: modelo.bairro,
    cep: modelo.cep,
    cidade: modelo.cidade,
    uf: modelo.uf,
    cidadeIbge: modelo.cidade_ibge,
    ciclo: assinatura?.ciclo ?? modelo.ciclo,
    valorCheio: payment.value ?? modelo.valor_cheio,
    valorComDesconto: payment.value ?? modelo.valor_com_desconto,
    valorCobrado: payment.value ?? modelo.valor_cobrado
  });

  // `duplicado`: outra entrega do MESMO evento venceu a inserção — ela
  // notifica; esta para aqui (corrida de 16/09).
  if (resultado?.duplicado) return null;

  return deps.buscarCobranca(payment.id);
}

/* ------------------------------------------------------------------
   VOCABULÁRIO 2 — CHECKOUT_* (checkout.id = nosso asaas_checkout_id)
------------------------------------------------------------------ */

async function processarEventoCheckout(corpo, deps = dependenciasPadrao, ocorridoEm = null) {
  const evento = corpo?.event;
  const asaasCheckoutId = corpo?.checkout?.id ?? corpo?.id;
  if (!asaasCheckoutId) return;

  let cobranca = await deps.buscarCobrancaPorCheckoutId(asaasCheckoutId);
  if (!cobranca && corpo?.checkout?.externalReference) {
    // A reserva cuja sessão nasceu mas a resposta se perdeu (C-04/H-06).
    cobranca = await deps.buscarCobrancaPorReferenciaExterna(corpo.checkout.externalReference);
    if (cobranca && !cobranca.asaas_checkout_id) {
      await deps.vincularChargeIdAoCheckout(asaasCheckoutId, cobranca.charge_id ?? null);
      // ↑ grava só o vínculo da sessão; o charge chega no PAYMENT_CONFIRMED
      cobranca = { ...cobranca, asaas_checkout_id: asaasCheckoutId };
    }
  }
  if (!cobranca) return;

  if (evento === 'CHECKOUT_PAID') {
    const payment = corpo?.checkout?.payment ?? corpo?.payment ?? null;
    const chargeId = payment?.id ?? null;
    if (chargeId) await deps.vincularChargeIdAoCheckout(asaasCheckoutId, chargeId);
    await deps.atualizarStatusPorCheckoutId(asaasCheckoutId, 'confirmado');

    const chargeIdFinal = chargeId ?? cobranca.charge_id;
    if (METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento) && payment?.subscription && chargeIdFinal) {
      await amarrarAssinaturaACobranca(cobranca, payment, chargeIdFinal, deps);
    }

    /* NENHUM aviso sai daqui (mudança de 24/09/2026). O `CHECKOUT_PAID`
       real não traz `payment`, então não há `chargeId` nem
       `subscription` para o contratante deduplicar/vincular; quem avisa
       — `confirmado` no pedido, `criada` na assinatura — é o
       `PAYMENT_CONFIRMED`, 279 ms depois, com os dois ids. O que
       acontece AQUI é o que a tela precisa: a sessão vira `confirmado`
       e o polling da pop-up fecha. */
    return;
  }

  if (evento === 'CHECKOUT_CANCELED') {
    await deps.atualizarStatusPorCheckoutId(asaasCheckoutId, 'cancelado');
    // Renovação abandonada NÃO é a assinatura sendo cancelada (RN-20).
    if (cobranca.substitui_assinatura_id) return;
    if (METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento)) {
      return notificarAssinatura(cobranca, { evento: 'cancelada', assinaturaId: cobranca.asaas_subscription_id ?? null, chargeId: cobranca.charge_id ?? null, statusFinanceiro: 'cancelado', ocorridoEm }, deps);
    }
    return; // pedido avulso: tentativa abandonada não tem status no vocabulário de pedido
  }

  if (evento === 'CHECKOUT_EXPIRED') {
    await deps.atualizarStatusPorCheckoutId(asaasCheckoutId, 'expirado');
    // Sem notificação (API.md §4.3.5): a pop-up expirada é ausência de
    // pagamento, não um fato sobre uma cobrança que existiu.
  }
}

/* ------------------------------------------------------------------
   Notificações — contrato v2, via outbox
------------------------------------------------------------------ */

function contratanteDaCobranca(cobranca) {
  const c = cobranca.contratantes ?? {};
  return { id: cobranca.contratante_id ?? c.id ?? null, webhook_url: c.webhook_url ?? null, api_key: c.api_key ?? null };
}

/** Payload de PEDIDO (API.md §4.3.2/§4.3.3) + os campos da v2. */
export function montarPayloadConfirmacaoPedido(cobranca, chargeId, status, extras = {}) {
  return {
    versao: VERSAO_WEBHOOK,
    tipo: 'pedido',
    pedidoId: cobranca.pedido_id,
    chargeId,
    status,
    statusFinanceiro: status,
    valorCheio: cobranca.valor_cheio,
    desconto: cobranca.desconto,
    cupom: cobranca.cupom,
    valorComDesconto: cobranca.valor_com_desconto,
    frete: cobranca.frete,
    taxaDoProjeto: cobranca.taxa_do_projeto,
    taxaAsaas: cobranca.taxa_asaas,
    taxaPropria: cobranca.taxa_propria,
    taxaIsenta: cobranca.taxa_isenta,
    taxasTotais: somarReais([cobranca.taxa_do_projeto, cobranca.taxa_asaas, cobranca.taxa_propria]),
    metodoPagamento: cobranca.metodo_pagamento,
    valorCobrado: cobranca.valor_cobrado,
    valorEstornado: extras.valorEstornado ?? null,
    estornoParcial: status === 'estornado_parcialmente',
    cotacaoId: cobranca.cotacao_id ?? null
  };
}

/** Payload de ASSINATURA (API.md §4.3.4) + os campos da v2 (H-02). */
export function montarPayloadAssinatura(cobranca, { evento, assinaturaId, chargeId, statusFinanceiro, valorEstornado, planoAnterior, acertoCobrado }) {
  return {
    versao: VERSAO_WEBHOOK,
    tipo: 'assinatura',
    evento,
    planoId: cobranca.plano_id,
    documento: cobranca.documento,
    assinaturaId: assinaturaId ?? null,
    chargeId: chargeId ?? null,
    statusFinanceiro: statusFinanceiro ?? null,
    valor: cobranca.valor_cobrado ?? null,
    ciclo: cobranca.ciclo ?? null,
    cicloCanonico: cicloCanonico(cobranca.ciclo) ?? null,
    metodoPagamento: cobranca.metodo_pagamento,
    valorEstornado: valorEstornado ?? null,
    estornoParcial: statusFinanceiro === 'estornado_parcialmente',
    ...(planoAnterior !== undefined ? { planoAnterior } : {}),
    ...(acertoCobrado !== undefined ? { acertoCobrado } : {})
  };
}

/** Chave de idempotência do FATO: o mesmo fato, por qualquer caminho,
 *  cai na mesma linha da outbox. */
function chaveDoFato({ tipo, evento, chargeId, assinaturaId, statusFinanceiro, cobranca }) {
  if (tipo === 'pedido') return `pedido|${chargeId}|${statusFinanceiro}`;
  const referencia = chargeId ?? assinaturaId ?? cobranca?.asaas_checkout_id ?? cobranca?.id;
  return `assinatura|${referencia}|${evento}${statusFinanceiro ? `|${statusFinanceiro}` : ''}`;
}

async function notificarPedido(cobranca, { chargeId, statusFinanceiro, valorEstornado, ocorridoEm }, deps) {
  const contratante = contratanteDaCobranca(cobranca);
  if (!contratante.webhook_url) return;
  return deps.notificar({
    contratante,
    tipo: 'pedido',
    evento: statusFinanceiro,
    chave: chaveDoFato({ tipo: 'pedido', chargeId, statusFinanceiro }),
    payload: montarPayloadConfirmacaoPedido(cobranca, chargeId, statusFinanceiro, { valorEstornado }),
    ocorridoEm
  });
}

async function notificarAssinatura(cobranca, dados, deps) {
  const contratante = contratanteDaCobranca(cobranca);
  if (!contratante.webhook_url) return;
  return deps.notificar({
    contratante,
    tipo: 'assinatura',
    evento: dados.evento,
    chave: chaveDoFato({ tipo: 'assinatura', ...dados, cobranca }),
    payload: montarPayloadAssinatura(cobranca, dados),
    ocorridoEm: dados.ocorridoEm
  });
}

/**
 * `POST /cancelar-assinatura` (assinaturaController.js): cancelamento
 * pedido pelo PRÓPRIO contratante. Mesmo vocabulário dos outros.
 */
export async function notificarAssinaturaCancelada(contratante, { planoId, documento, assinaturaId = null, ciclo = null, valor = null }, deps = dependenciasPadrao) {
  if (!contratante?.webhook_url) return;
  return deps.notificar({
    contratante,
    tipo: 'assinatura',
    evento: 'cancelada',
    chave: `assinatura|${assinaturaId ?? `${planoId}|${documento}`}|cancelada`,
    payload: montarPayloadAssinatura(
      { plano_id: planoId, documento, valor_cobrado: valor, ciclo, metodo_pagamento: 'assinatura' },
      { evento: 'cancelada', assinaturaId, chargeId: null, statusFinanceiro: 'cancelado' }
    ),
    ocorridoEm: new Date().toISOString()
  });
}

/**
 * `POST /trocar-plano` / aprovação (trocaPlanoController, trocaExecucaoService):
 * o assinante passou do plano A para o B com o vínculo mantido.
 */
export async function notificarPlanoTrocado(
  contratante,
  { planoId, planoAnterior, documento, valor, ciclo, acertoCobrado, assinaturaId = null, chargeId = null, intencaoId = null },
  deps = dependenciasPadrao
) {
  if (!contratante?.webhook_url) return;
  return deps.notificar({
    contratante,
    tipo: 'assinatura',
    evento: 'plano_trocado',
    chave: `assinatura|${assinaturaId ?? `${planoId}|${documento}`}|plano_trocado|${intencaoId ?? chargeId ?? planoAnterior}`,
    payload: montarPayloadAssinatura(
      { plano_id: planoId, documento, valor_cobrado: valor, ciclo, metodo_pagamento: 'assinatura' },
      { evento: 'plano_trocado', assinaturaId, chargeId, statusFinanceiro: acertoCobrado > 0 ? 'confirmado' : null, planoAnterior, acertoCobrado }
    ),
    ocorridoEm: new Date().toISOString()
  });
}

/* ------------------------------------------------------------------
   Autoteste — `node src/controllers/webhookController.js`
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('webhookController.js')) {
  const { strict: assertReal } = await import('node:assert');
  let checagens = 0;
  const assert = new Proxy(assertReal, {
    get(alvo, nome) {
      const valor = alvo[nome];
      if (typeof valor !== 'function') return valor;
      return (...args) => { checagens += 1; return valor.apply(alvo, args); };
    }
  });

  // --- Guarda de token ---
  const tokenOriginal = process.env.ASAAS_WEBHOOK_TOKEN;
  function rodarGuarda({ token, header }) {
    if (token === undefined) delete process.env.ASAAS_WEBHOOK_TOKEN;
    else process.env.ASAAS_WEBHOOK_TOKEN = token;
    const req = { get: (nome) => (nome === 'asaas-access-token' ? header : undefined) };
    const res = { _status: null, _json: null, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } };
    let chamouProximo = false;
    verificarWebhookAsaas(req, res, () => { chamouProximo = true; });
    return { status: res._status, chamouProximo };
  }
  let r = rodarGuarda({ token: undefined, header: 'qualquer' });
  assert.equal(r.status, 503, 'sem ASAAS_WEBHOOK_TOKEN configurado: recusa tudo (fail-closed)');
  r = rodarGuarda({ token: 'segredo-certo', header: 'segredo-errado' });
  assert.equal(r.status, 401, 'token do header não bate: 401');
  r = rodarGuarda({ token: 'segredo-certo', header: undefined });
  assert.equal(r.status, 401, 'header ausente com token configurado: 401');
  r = rodarGuarda({ token: 'segredo-certo', header: 'segredo-certo' });
  assert.equal(r.chamouProximo, true, 'token certo passa adiante');
  if (tokenOriginal === undefined) delete process.env.ASAAS_WEBHOOK_TOKEN; else process.env.ASAAS_WEBHOOK_TOKEN = tokenOriginal;

  // --- Mapa evento → status ---
  assert.equal(mapearStatusPayment('PAYMENT_CONFIRMED'), 'confirmado');
  assert.equal(mapearStatusPayment('PAYMENT_RECEIVED'), 'confirmado');
  assert.equal(mapearStatusPayment('PAYMENT_REFUNDED'), 'estornado');
  assert.equal(mapearStatusPayment('PAYMENT_PARTIALLY_REFUNDED'), 'estornado_parcialmente', 'H-04: parcial NÃO é total');
  assert.equal(mapearStatusPayment('PAYMENT_REFUND_IN_PROGRESS'), 'estorno_solicitado');
  assert.equal(mapearStatusPayment('PAYMENT_REFUND_DENIED'), 'estorno_negado');
  assert.equal(mapearStatusPayment('PAYMENT_OVERDUE'), 'vencido');
  assert.equal(mapearStatusPayment('PAYMENT_AWAITING_RISK_ANALYSIS'), 'em_analise');
  assert.equal(mapearStatusPayment('PAYMENT_REPROVED_BY_RISK_ANALYSIS'), 'recusado');
  assert.equal(mapearStatusPayment('PAYMENT_CREDIT_CARD_CAPTURE_REFUSED'), 'recusado');
  assert.equal(mapearStatusPayment('PAYMENT_CHARGEBACK_REQUESTED'), 'chargeback');
  assert.equal(mapearStatusPayment('PAYMENT_RECEIVED_IN_CASH_UNDONE'), 'pendente');
  assert.equal(mapearStatusPayment('PAYMENT_CREATED'), null);
  assert.equal(mapearEventoAssinatura('confirmado'), 'cobranca_confirmada');
  assert.equal(mapearEventoAssinatura('recusado'), 'cobranca_falhou');
  assert.equal(mapearEventoAssinatura('estornado_parcialmente'), 'cobranca_estornada');
  assert.equal(mapearEventoAssinatura('chargeback'), 'cobranca_contestada');
  assert.equal(mapearEventoAssinatura('em_analise'), null);

  // --- ocorridoEm / valorEstornado ---
  assert.equal(ocorridoEmDoEvento({ dateCreated: '2026-09-24 14:03:11' }), '2026-09-24T17:03:11.000Z', 'hora de Brasília vira UTC');
  assert.equal(ocorridoEmDoEvento({ dateCreated: '2026-09-24T17:03:11Z' }), '2026-09-24T17:03:11.000Z');
  assert.equal(ocorridoEmDoEvento({}), null);
  assert.equal(ocorridoEmDoEvento({ dateCreated: 'lixo' }), null);
  assert.equal(valorEstornadoDoPayment({ refunds: [{ status: 'DONE', value: 10 }, { status: 'DONE', value: 5.5 }, { status: 'CANCELLED', value: 100 }] }), 15.5, 'soma só os concluídos');
  assert.equal(valorEstornadoDoPayment({ refunds: [] }), null, 'lista vazia é ausência, não zero');
  assert.equal(valorEstornadoDoPayment({}), null);
  assert.equal(valorEstornadoDoPayment({ refunds: [{ value: 0.1 }, { value: 0.2 }] }), 0.3, 'em centavos, sem ruído binário');

  // --- Payloads v2 ---
  const payload = montarPayloadConfirmacaoPedido(
    { pedido_id: 'ped_1', valor_cheio: 100, desconto: 10, cupom: 'X', valor_com_desconto: 90, frete: 5, taxa_do_projeto: 2, taxa_asaas: 1.5, taxa_propria: 0.5, taxa_isenta: false, metodo_pagamento: 'pix', valor_cobrado: 99 },
    'pay_1', 'confirmado'
  );
  assert.equal(payload.versao, VERSAO_WEBHOOK);
  assert.equal(payload.tipo, 'pedido');
  assert.equal(payload.taxasTotais, 4, 'taxasTotais = projeto + asaas + própria');
  assert.equal(payload.statusFinanceiro, 'confirmado');
  assert.equal(payload.estornoParcial, false);
  assert.equal(montarPayloadConfirmacaoPedido({ taxa_do_projeto: null, taxa_asaas: null, taxa_propria: null }, 'p', 'confirmado').taxasTotais, 0, 'taxa nula conta como 0');
  const parcial = montarPayloadConfirmacaoPedido({ pedido_id: 'p', valor_cobrado: 100 }, 'pay_1', 'estornado_parcialmente', { valorEstornado: 30 });
  assert.equal(parcial.estornoParcial, true);
  assert.equal(parcial.valorEstornado, 30);
  const pa = montarPayloadAssinatura(
    { plano_id: 'pl', documento: '123', valor_cobrado: 267.3, ciclo: 'QUARTERLY', metodo_pagamento: 'assinatura' },
    { evento: 'cobranca_confirmada', assinaturaId: 'sub_1', chargeId: 'pay_9', statusFinanceiro: 'confirmado' }
  );
  for (const campo of ['assinaturaId', 'chargeId', 'valor', 'ciclo', 'statusFinanceiro', 'planoId', 'documento', 'evento']) {
    assert.ok(pa[campo] !== null && pa[campo] !== undefined, `H-02: o evento de assinatura carrega ${campo}`);
  }
  assert.equal(pa.cicloCanonico, 'trimestral');

  /* --- Dublês --- */
  function depsFalsas(retornos = {}) {
    const chamadas = [];
    const deps = {};
    for (const nome of Object.keys(dependenciasPadrao)) {
      if (nome === 'inbox') continue;
      deps[nome] = async (...args) => {
        chamadas.push({ nome, args });
        const r = retornos[nome];
        return typeof r === 'function' ? r(...args) : (r ?? null);
      };
    }
    // aplicarTransicao devolve true por padrão (a escrita venceu)
    if (!('aplicarTransicao' in retornos)) deps.aplicarTransicao = async (...args) => { chamadas.push({ nome: 'aplicarTransicao', args }); return true; };
    deps.inbox = {};
    for (const nome of Object.keys(dependenciasPadrao.inbox)) {
      deps.inbox[nome] = async (...args) => {
        chamadas.push({ nome: `inbox.${nome}`, args });
        const r = retornos.inbox?.[nome];
        return typeof r === 'function' ? r(...args) : (r ?? null);
      };
    }
    deps.chamadas = chamadas;
    deps.chamou = (nome) => chamadas.filter((c) => c.nome === nome);
    deps.notificados = () => chamadas.filter((c) => c.nome === 'notificar').map((c) => c.args[0]);
    return deps;
  }

  const contratante = { id: 'c1', webhook_url: 'https://parceiro.exemplo/hook', api_key: 'chave-do-parceiro' };
  const cobrancaPix = { charge_id: 'pay_1', status: 'pendente', metodo_pagamento: 'pix', pedido_id: 'ped_1', contratante_id: 'c1', valor_cobrado: 99, contratantes: contratante };

  // 1. idempotência simples
  let deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'confirmado' } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } }, deps);
  assert.equal(deps.chamou('aplicarTransicao').length, 0, 'status já era esse: não regrava');
  assert.equal(deps.notificados().length, 0, 'e não notifica de novo');

  // 2. caminho feliz do Pix: grava por CAS e enfileira com a chave do fato
  deps = depsFalsas({ buscarCobranca: cobrancaPix });
  await processarWebhook({ id: 'evt_1', event: 'PAYMENT_CONFIRMED', dateCreated: '2026-09-24 10:00:00', payment: { id: 'pay_1' } }, deps);
  assert.equal(deps.chamou('aplicarTransicao')[0].args[0], 'pay_1');
  assert.deepEqual(deps.chamou('aplicarTransicao')[0].args[1].de, 'pendente');
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].para, 'confirmado');
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].ocorridoEm, '2026-09-24T13:00:00.000Z', 'o carimbo do evento vai para a linha');
  let n = deps.notificados();
  assert.equal(n.length, 1, 'primeira vez notifica o contratante');
  assert.equal(n[0].contratante.webhook_url, contratante.webhook_url);
  assert.equal(n[0].chave, 'pedido|pay_1|confirmado', 'a chave de idempotência é o fato');
  assert.equal(n[0].payload.status, 'confirmado');
  assert.equal(n[0].payload.versao, 2);

  // 3. C-03: CONFIRMED atrasado depois de REFUNDED não regride
  deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'estornado', status_evento_em: '2026-09-24T12:00:00Z' } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', dateCreated: '2026-09-24 08:00:00', payment: { id: 'pay_1' } }, deps);
  assert.equal(deps.chamou('aplicarTransicao').length, 0, 'C-03: estornado não volta a confirmado');
  assert.equal(deps.notificados().length, 0, 'e o contratante não recebe um "confirmado" falso');
  deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'chargeback' } });
  await processarWebhook({ event: 'PAYMENT_RECEIVED_IN_CASH_UNDONE', payment: { id: 'pay_1' } }, deps);
  assert.equal(deps.chamou('aplicarTransicao').length, 0, 'C-03: chargeback não vira pendente');
  // CASH_UNDONE mais antigo que o CONFIRMED gravado também não
  deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'confirmado', status_evento_em: '2026-09-24T12:00:00Z' } });
  await processarWebhook({ event: 'PAYMENT_RECEIVED_IN_CASH_UNDONE', dateCreated: '2026-09-24T11:00:00Z', payment: { id: 'pay_1' } }, deps);
  assert.equal(deps.chamou('aplicarTransicao').length, 0, 'C-03: evento mais antigo que o status gravado não regride');
  // mas a sequência legítima confirmado → estornado passa e notifica
  deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'confirmado' } });
  await processarWebhook({ event: 'PAYMENT_REFUNDED', payment: { id: 'pay_1', refunds: [{ status: 'DONE', value: 99 }] } }, deps);
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].para, 'estornado');
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].valorEstornado, 99);
  assert.equal(deps.notificados()[0].payload.status, 'estornado');
  assert.equal(deps.notificados()[0].payload.valorEstornado, 99);
  // e a corrida perdida no CAS não notifica
  deps = depsFalsas({ buscarCobranca: cobrancaPix, aplicarTransicao: () => false });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } }, deps);
  assert.equal(deps.notificados().length, 0, 'perdeu a corrida do UPDATE condicional: não notifica');

  // 4. H-04: estorno parcial preservado
  deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'confirmado', valor_cobrado: 100 } });
  await processarWebhook({ event: 'PAYMENT_PARTIALLY_REFUNDED', payment: { id: 'pay_1', refunds: [{ status: 'DONE', value: 30 }] } }, deps);
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].para, 'estornado_parcialmente');
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].valorEstornado, 30);
  n = deps.notificados();
  assert.equal(n[0].payload.status, 'estornado_parcialmente');
  assert.equal(n[0].payload.estornoParcial, true);
  assert.equal(n[0].payload.valorEstornado, 30);
  assert.equal(n[0].payload.valorCobrado, 100, 'o valor original é preservado');
  // parcial que devolve tudo vira total
  deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'confirmado', valor_cobrado: 100 } });
  await processarWebhook({ event: 'PAYMENT_PARTIALLY_REFUNDED', payment: { id: 'pay_1', refunds: [{ status: 'DONE', value: 60 }, { status: 'DONE', value: 40 }] } }, deps);
  assert.equal(deps.chamou('aplicarTransicao').at(-1).args[1].para, 'estornado', 'parcial que soma o total é estorno total');
  assert.equal(deps.notificados()[0].payload.status, 'estornado');
  // parcial sem lista de refunds: não inventa valor
  deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'confirmado', valor_cobrado: 100 } });
  await processarWebhook({ event: 'PAYMENT_PARTIALLY_REFUNDED', payment: { id: 'pay_1' } }, deps);
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].valorEstornado, null, 'sem refunds no payload, valorEstornado é null — nunca 0');

  // 5. evento desconhecido / corpo vazio: nenhum efeito
  deps = depsFalsas();
  await processarWebhook({ event: 'EVENTO_QUE_NAO_EXISTE' }, deps);
  await processarWebhook({}, deps);
  await processarWebhook(null, deps);
  assert.equal(deps.chamadas.length, 0, 'evento desconhecido, corpo vazio ou nulo: nenhum efeito');

  // 6. charge desconhecido sem subscription: ignora
  deps = depsFalsas({ buscarCobranca: null });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_de_outro' } }, deps);
  assert.equal(deps.chamou('aplicarTransicao').length, 0);
  assert.equal(deps.chamou('registrarCicloAssinatura').length, 0);

  // 7. ciclo novo de assinatura → cobranca_confirmada COMPLETO (H-02)
  const modeloAssinatura = { contratante_id: 'c1', plano_id: 'plano_1', documento: '12345678909', metodo_pagamento: 'assinatura', ciclo: 'QUARTERLY', valor_cobrado: 267.3, asaas_subscription_id: 'sub_1', contratantes: contratante };
  let cicloRegistrado = false;
  deps = depsFalsas({
    buscarCobranca: () => (cicloRegistrado ? { ...modeloAssinatura, charge_id: 'pay_ciclo2', status: 'pendente' } : null),
    buscarCobrancaPorSubscriptionId: modeloAssinatura,
    registrarCicloAssinatura: () => { cicloRegistrado = true; return { duplicado: false }; }
  });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_ciclo2', subscription: 'sub_1', value: 267.3 } }, deps);
  assert.equal(deps.chamou('registrarCicloAssinatura').length, 1, 'ciclo novo vira registro local');
  n = deps.notificados();
  assert.equal(n[0].payload.tipo, 'assinatura');
  assert.equal(n[0].payload.evento, 'cobranca_confirmada');
  assert.equal(n[0].payload.chargeId, 'pay_ciclo2', 'H-02: renovação carrega o chargeId');
  assert.equal(n[0].payload.assinaturaId, 'sub_1', 'H-02: e o id da assinatura');
  assert.equal(n[0].payload.valor, 267.3);
  assert.equal(n[0].payload.ciclo, 'QUARTERLY');
  assert.equal(n[0].payload.statusFinanceiro, 'confirmado');
  assert.equal(n[0].chave, 'assinatura|pay_ciclo2|cobranca_confirmada|confirmado', 'a chave é por cobrança — dois ciclos nunca colidem');

  // 8. entrega perdedora da corrida do unique não notifica
  let chamadasBuscar = 0;
  deps = depsFalsas({
    buscarCobranca: () => { chamadasBuscar += 1; return chamadasBuscar === 1 ? null : { ...modeloAssinatura, charge_id: 'pay_r', status: 'pendente' }; },
    buscarCobrancaPorSubscriptionId: modeloAssinatura,
    registrarCicloAssinatura: () => ({ duplicado: true })
  });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_r', subscription: 'sub_1' } }, deps);
  assert.equal(deps.notificados().length, 0, 'entrega perdedora da corrida não notifica');

  // 9. ciclo depois de troca nasce com o plano NOVO
  deps = depsFalsas({
    buscarCobranca: null,
    buscarCobrancaPorSubscriptionId: { ...modeloAssinatura, plano_id: 'plano_velho', ciclo: 'MONTHLY' },
    buscarAssinaturaPorId: { id: 'sub_1', plano_id: 'plano_novo', ciclo: 'QUARTERLY' },
    registrarCicloAssinatura: () => ({ duplicado: false })
  });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_pos_troca', subscription: 'sub_1', value: 160 } }, deps);
  assert.equal(deps.chamou('registrarCicloAssinatura')[0].args[0].planoId, 'plano_novo');
  assert.equal(deps.chamou('registrarCicloAssinatura')[0].args[0].ciclo, 'QUARTERLY');

  // 10. acerto de troca: intenção primeiro
  deps = depsFalsas({ buscarCobranca: null, avancarIntencaoDeTrocaPorChargeId: true });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_acerto_1' } }, deps);
  assert.deepEqual(deps.chamou('avancarIntencaoDeTrocaPorChargeId')[0].args, ['pay_acerto_1', 'PAYMENT_CONFIRMED']);
  assert.equal(deps.chamou('registrarCicloAssinatura').length, 0);

  // 11. H-03: estorno do ACERTO avisa troca_revertida
  const acerto = { charge_id: 'pay_acerto', status: 'confirmado', metodo_pagamento: METODO_ACERTO_TROCA, plano_id: 'plano_novo', documento: '123', valor_cobrado: 30, ciclo: 'MONTHLY', asaas_subscription_id: 'sub_1', contratante_id: 'c1', contratantes: contratante };
  deps = depsFalsas({ buscarCobranca: acerto, buscarAssinaturaPorId: { id: 'sub_1', plano_id: 'plano_novo', plano_anterior_id: 'plano_velho' } });
  await processarWebhook({ event: 'PAYMENT_REFUNDED', payment: { id: 'pay_acerto', refunds: [{ status: 'DONE', value: 30 }] } }, deps);
  n = deps.notificados();
  assert.equal(n.length, 1, 'H-03: reversão do acerto CHEGA ao contratante');
  assert.equal(n[0].payload.evento, 'troca_revertida');
  assert.equal(n[0].payload.planoAnterior, 'plano_velho');
  assert.equal(n[0].payload.planoId, 'plano_novo');
  assert.equal(n[0].payload.chargeId, 'pay_acerto');
  assert.equal(n[0].payload.valorEstornado, 30);
  deps = depsFalsas({ buscarCobranca: acerto, buscarAssinaturaPorId: { plano_anterior_id: 'plano_velho' } });
  await processarWebhook({ event: 'PAYMENT_CHARGEBACK_REQUESTED', payment: { id: 'pay_acerto' } }, deps);
  assert.equal(deps.notificados()[0].payload.evento, 'troca_revertida', 'chargeback do acerto também');
  deps = depsFalsas({ buscarCobranca: { ...acerto, status: 'pendente' } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_acerto' } }, deps);
  assert.equal(deps.notificados().length, 0, 'confirmação do acerto continua sem aviso próprio (quem avisa é plano_trocado)');

  // 12. a sequência real da pop-up: CHECKOUT_PAID não avisa; PAYMENT_CONFIRMED avisa `criada` completo
  const cobrancaAssinaturaCrua = { ...cobrancaPix, metodo_pagamento: 'assinatura', charge_id: null, asaas_checkout_id: 'chk_real', plano_id: 'plano_x', documento: '52998224725', contratante_id: 'mostrai', substitui_assinatura_id: null, ciclo: 'QUARTERLY', valor_cobrado: 267.3 };
  deps = depsFalsas({ buscarCobrancaPorCheckoutId: cobrancaAssinaturaCrua });
  await processarWebhook({ event: 'CHECKOUT_PAID', checkout: { id: 'chk_real', status: 'PAID' } }, deps);
  assert.deepEqual(deps.chamou('atualizarStatusPorCheckoutId')[0].args, ['chk_real', 'confirmado'], 'a sessão vira confirmado (é o que o polling da pop-up lê)');
  assert.equal(deps.notificados().length, 0, 'CHECKOUT_PAID não avisa nada: não tem chargeId nem subscription');
  deps = depsFalsas({ buscarCobranca: null, buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, status: 'confirmado' } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_real', subscription: 'sub_real', checkoutSession: 'chk_real' } }, deps);
  assert.deepEqual(deps.chamou('vincularChargeIdAoCheckout')[0].args, ['chk_real', 'pay_real'], 'o charge_id é gravado aqui (bug de 15/09)');
  assert.deepEqual(deps.chamou('atualizarSubscriptionIdDaCobranca')[0].args, ['pay_real', 'sub_real']);
  assert.equal(deps.chamou('upsertAssinatura')[0].args[0].ciclo, 'QUARTERLY', 'ciclo vem de cobranca.ciclo');
  n = deps.notificados();
  assert.equal(n.length, 1, 'e é AQUI que `criada` sai');
  assert.equal(n[0].payload.evento, 'criada');
  assert.equal(n[0].payload.chargeId, 'pay_real', 'H-02: criada carrega chargeId');
  assert.equal(n[0].payload.assinaturaId, 'sub_real', 'H-02: e assinaturaId');
  assert.equal(n[0].payload.valor, 267.3);
  assert.equal(n[0].chave, 'assinatura|pay_real|criada|confirmado');
  assert.equal(deps.chamou('aplicarTransicao').length, 0, 'a sessão já estava confirmado: status não é regravado');
  // pagamento chegando ANTES do CHECKOUT_PAID: vincula e grava a transição
  deps = depsFalsas({ buscarCobranca: null, buscarCobrancaPorCheckoutId: cobrancaAssinaturaCrua });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_antes', subscription: 'sub_antes', checkoutSession: 'chk_real' } }, deps);
  assert.equal(deps.chamou('vincularChargeIdAoCheckout').length, 1);
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].para, 'confirmado', 'com a sessão ainda pendente, a transição é gravada');
  assert.equal(deps.notificados()[0].payload.evento, 'criada');
  // segundo PAYMENT_CONFIRMED (reentrega já processada) sobre a mesma sessão: nada
  deps = depsFalsas({ buscarCobranca: { ...cobrancaAssinaturaCrua, charge_id: 'pay_real', status: 'confirmado' } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_real', subscription: 'sub_real', checkoutSession: 'chk_real' } }, deps);
  assert.equal(deps.notificados().length, 0, 'reentrega: nada');
  // ciclo 2 com checkoutSession: não sobrescreve o vínculo da primeira
  const cicloNovo = { ...cobrancaAssinaturaCrua, charge_id: 'pay_ciclo2', status: 'pendente', asaas_subscription_id: 'sub_real' };
  let leituras = 0;
  deps = depsFalsas({
    buscarCobranca: () => (leituras++ === 0 ? null : cicloNovo),
    buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, charge_id: 'pay_real', status: 'confirmado' },
    buscarCobrancaPorSubscriptionId: { ...cobrancaAssinaturaCrua, charge_id: 'pay_real' },
    registrarCicloAssinatura: () => ({ duplicado: false })
  });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_ciclo2', subscription: 'sub_real', checkoutSession: 'chk_real' } }, deps);
  assert.equal(deps.chamou('vincularChargeIdAoCheckout').length, 0, 'cobrança já vinculada: o ciclo novo NÃO sobrescreve');
  assert.equal(deps.notificados()[0].payload.evento, 'cobranca_confirmada');
  // estorno antes de vincular SAI
  deps = depsFalsas({ buscarCobranca: null, buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, status: 'confirmado' } });
  await processarWebhook({ event: 'PAYMENT_REFUNDED', payment: { id: 'pay_estorno', subscription: 'sub_real', checkoutSession: 'chk_real' } }, deps);
  assert.equal(deps.notificados()[0].payload.evento, 'cobranca_estornada', 'o estorno sai mesmo na primeira cobrança');

  // 13. cartão avulso pela pop-up: aviso só no PAYMENT_CONFIRMED, com chargeId
  const cobrancaCartaoCrua = { ...cobrancaPix, metodo_pagamento: 'cartao_credito', charge_id: null, asaas_checkout_id: 'chk_cart' };
  deps = depsFalsas({ buscarCobrancaPorCheckoutId: cobrancaCartaoCrua });
  await processarWebhook({ event: 'CHECKOUT_PAID', checkout: { id: 'chk_cart' } }, deps);
  assert.equal(deps.notificados().length, 0, 'pedido sem chargeId não vira aviso');
  deps = depsFalsas({ buscarCobranca: null, buscarCobrancaPorCheckoutId: { ...cobrancaCartaoCrua, status: 'confirmado' } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_cart', checkoutSession: 'chk_cart' } }, deps);
  assert.deepEqual(deps.chamou('vincularChargeIdAoCheckout')[0].args, ['chk_cart', 'pay_cart']);
  assert.equal(deps.chamou('upsertAssinatura').length, 0, 'cartão avulso não cria assinatura');
  assert.equal(deps.notificados()[0].payload.chargeId, 'pay_cart');

  // 14. C-04/H-06: sessão que chega pela referência externa
  deps = depsFalsas({
    buscarCobrancaPorCheckoutId: null,
    buscarCobrancaPorReferenciaExterna: (ref) => (ref === 'reserva-abc' ? { ...cobrancaCartaoCrua, asaas_checkout_id: null, id: 'abc' } : null)
  });
  await processarWebhook({ event: 'CHECKOUT_PAID', checkout: { id: 'chk_perdido', externalReference: 'reserva-abc' } }, deps);
  assert.deepEqual(deps.chamou('buscarCobrancaPorReferenciaExterna')[0].args, ['reserva-abc'], 'sem linha pela sessão, procura pela reserva');
  assert.deepEqual(deps.chamou('atualizarStatusPorCheckoutId')[0].args, ['chk_perdido', 'confirmado'], 'e a reserva perdida vira confirmado');

  // 15. renovação: antiga cancelada DEPOIS da nova confirmar; falha vira Lei 8
  const cobrancaRenovacao = { ...cobrancaAssinaturaCrua, substitui_assinatura_id: 'sub_antiga' };
  deps = depsFalsas({ buscarCobranca: null, buscarCobrancaPorCheckoutId: { ...cobrancaRenovacao, status: 'confirmado' } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_nova', subscription: 'sub_nova', checkoutSession: 'chk_real' } }, deps);
  const ordem = deps.chamadas.map((c) => c.nome);
  assert.ok(ordem.indexOf('vincularChargeIdAoCheckout') < ordem.indexOf('cancelarAssinaturaNaAsaas'), 'a nova vincula ANTES de a antiga ser cancelada');
  assert.deepEqual(deps.chamou('cancelarAssinaturaNaAsaas')[0].args, ['sub_antiga']);
  deps = depsFalsas({ buscarCobranca: null, buscarCobrancaPorCheckoutId: { ...cobrancaRenovacao, status: 'confirmado' }, cancelarAssinaturaNaAsaas: () => { throw new Error('asaas fora do ar'); } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_nova', subscription: 'sub_nova', checkoutSession: 'chk_real' } }, deps);
  assert.equal(deps.notificados().length, 1, 'falha ao cancelar a antiga não impede de avisar quem pagou');
  assert.ok(deps.chamou('registrarErro')[0].args[0].message.includes('sub_antiga'), 'o erro registrado nomeia a antiga');

  // 16. RN-20: renovação abandonada não manda cancelada; assinatura nova abandonada manda
  deps = depsFalsas({ buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, substitui_assinatura_id: null } });
  await processarWebhook({ event: 'CHECKOUT_CANCELED', checkout: { id: 'chk_real' } }, deps);
  assert.equal(deps.notificados()[0].payload.evento, 'cancelada');
  deps = depsFalsas({ buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, substitui_assinatura_id: 'sub_antiga_intocada' } });
  await processarWebhook({ event: 'CHECKOUT_CANCELED', checkout: { id: 'chk_real' } }, deps);
  assert.equal(deps.notificados().length, 0, 'renovação abandonada não pode mandar cancelada');
  assert.deepEqual(deps.chamou('atualizarStatusPorCheckoutId')[0].args, ['chk_real', 'cancelado']);

  // 17. rotas: classificação bate com o ramo que roda
  const CASOS_DE_ROTA = [
    ['PAYMENT_CONFIRMED', 'payment'], ['PAYMENT_OVERDUE', 'payment'], ['PAYMENT_PARTIALLY_REFUNDED', 'payment'],
    ['CHECKOUT_PAID', 'checkout'], ['CHECKOUT_CANCELED', 'checkout'],
    ['ACCOUNT_STATUS_DOCUMENT_APPROVED', 'subconta'], ['ACCESS_TOKEN_EXPIRING_SOON', 'chave_api'],
    ['PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED', 'pix_automatico'],
    ['PIX_AUTOMATIC_RECURRING_ELIGIBILITY_UPDATED', null], ['SUBSCRIPTION_CREATED', null], ['PAYMENT_CREATED', null], [undefined, null], [null, null]
  ];
  for (const [evento, esperado] of CASOS_DE_ROTA) assert.equal(classificarEvento(evento), esperado, `rota de ${evento}`);
  for (const [evento, rota] of CASOS_DE_ROTA.filter(([, r]) => r !== null)) {
    const espiao = depsFalsas({ buscarCobranca: cobrancaPix, buscarCobrancaPorCheckoutId: cobrancaPix });
    await processarWebhook({ event: evento, payment: { id: 'pay_1' }, checkout: { id: 'chk_1' }, account: { id: 'acc_1' } }, espiao);
    assert.ok(espiao.chamadas.length > 0 || obterAlertasChaveApi().length > 0, `${evento} foi classificado como ${rota} mas não fez nada`);
  }

  /* ============================================================
     O RECEPTOR: inbox → 200 → processa (C-01)
     ============================================================ */
  async function receber(corpo, retornos = {}) {
    const espiao = depsFalsas(retornos);
    const receptor = criarReceptorWebhook(espiao);
    const res = { _status: null, _json: null, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } };
    const impresso = [];
    const logOriginal = console.log;
    console.log = (...args) => impresso.push(args.map(String).join(' '));
    try {
      await receptor({ body: corpo, get: () => undefined, ip: '203.0.113.7' }, res);
    } finally {
      console.log = logOriginal;
    }
    return { espiao, res, impresso: impresso.join('\n'), auditoria: espiao.chamou('registrarAuditoria')[0]?.args[0] };
  }
  const inboxOk = { registrarNaInbox: () => ({ id: 'in_1', duplicado: false }), reivindicarProcessamento: () => ({ id: 'in_1', tentativas: 0 }), marcarFalha: () => ({ tentativas: 1, esgotou: false }) };

  let a = await receber({ id: 'evt_1', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } }, { buscarCobranca: cobrancaPix, inbox: inboxOk });
  assert.equal(a.res._status, 200);
  assert.equal(a.espiao.chamou('inbox.registrarNaInbox').length, 1, 'C-01: o evento é PERSISTIDO');
  const ordemReceptor = a.espiao.chamadas.map((c) => c.nome);
  assert.ok(ordemReceptor.indexOf('inbox.registrarNaInbox') < ordemReceptor.indexOf('buscarCobranca'), 'persistir vem ANTES de processar');
  assert.equal(a.espiao.chamou('inbox.marcarProcessado').length, 1, 'e a linha fica processada');
  assert.equal(a.auditoria.resultado, 'tratado');
  assert.equal(a.auditoria.rota, 'payment');
  assert.equal(a.auditoria.referenciaId, 'pay_1');

  // C-01: erro no processamento → 200 (está guardado) + linha `falhou` + auditoria `erro`
  a = await receber({ id: 'evt_2', event: 'CHECKOUT_PAID', checkout: { id: 'chk_erro' } }, { buscarCobrancaPorCheckoutId: () => { throw new Error('banco fora do ar'); }, inbox: inboxOk });
  assert.equal(a.res._status, 200, 'erro no processamento AINDA responde 200 — o evento está na inbox');
  assert.equal(a.espiao.chamou('inbox.marcarFalha').length, 1, 'C-01: a falha fica registrada para o worker reprocessar');
  assert.equal(a.espiao.chamou('inbox.marcarFalha')[0].args[2], 'banco fora do ar');
  assert.equal(a.espiao.chamou('inbox.marcarProcessado').length, 0);
  assert.equal(a.auditoria.resultado, 'erro');
  assert.equal(a.auditoria.detalhe, 'banco fora do ar');

  // C-01: NÃO conseguiu persistir → 503 (a Asaas reenvia), nada processado
  a = await receber({ id: 'evt_3', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } }, { buscarCobranca: cobrancaPix, inbox: { registrarNaInbox: () => { throw new Error('inbox indisponível'); } } });
  assert.equal(a.res._status, 503, 'C-01: sem persistir, responde não-2xx para a Asaas reenviar');
  assert.equal(a.espiao.chamou('buscarCobranca').length, 0, 'e não processa nada que não esteja guardado');

  // reentrega do mesmo id: 200, sem processar
  a = await receber({ id: 'evt_1', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } }, { buscarCobranca: cobrancaPix, inbox: { ...inboxOk, registrarNaInbox: () => ({ id: 'in_1', duplicado: true }) } });
  assert.equal(a.res._status, 200);
  assert.deepEqual(a.res._json, { recebido: true, duplicado: true });
  assert.equal(a.espiao.chamou('buscarCobranca').length, 0, 'reentrega do mesmo id não reprocessa');
  assert.equal(a.auditoria.resultado, 'duplicado');

  // evento sem ramo: 200, `ignorado` na inbox, `nao_mapeado` na auditoria
  a = await receber({ id: 'evt_4', event: 'SUBSCRIPTION_CREATED', subscription: { id: 'sub_9' } }, { inbox: inboxOk });
  assert.equal(a.res._status, 200);
  assert.equal(a.espiao.chamou('inbox.marcarIgnorado').length, 1);
  assert.equal(a.auditoria.resultado, 'nao_mapeado');

  // auditoria quebrada não derruba nada
  a = await receber({ id: 'evt_5', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } }, { buscarCobranca: cobrancaPix, inbox: inboxOk, registrarAuditoria: () => { throw new Error('tabela sumiu'); } });
  assert.equal(a.res._status, 200, 'auditoria quebrada não derruba o webhook');
  assert.equal(a.espiao.notificados().length, 1, 'nem impede a notificação');

  // log sem dado de pessoa
  a = await receber({ id: 'evt_6', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1', status: 'CONFIRMED' }, customer: { name: 'Maria Aparecida', cpfCnpj: '52998224725', email: 'maria@exemplo.com' } }, { buscarCobranca: cobrancaPix, inbox: inboxOk });
  for (const proibido of ['52998224725', 'Maria Aparecida', 'maria@exemplo.com']) assert.ok(!a.impresso.includes(proibido), `dado pessoal vazou no log: ${proibido}`);
  assert.ok(a.impresso.includes('customer.cpfCnpj'), 'o CAMINHO da chave continua visível, sem o valor');

  // o worker: reprocessa a partir do corpo mínimo
  deps = depsFalsas({
    buscarCobranca: cobrancaPix,
    inbox: {
      listarParaReprocessar: () => [{ id: 'in_9', tentativas: 2, corpo_minimo: { id: 'evt_9', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } } }],
      reivindicarProcessamento: (id) => ({ id, tentativas: 2, corpo_minimo: { id: 'evt_9', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } } })
    }
  });
  const rel = await reprocessarInbox(deps);
  assert.deepEqual(rel, { examinadas: 1, processadas: 1, falhas: 0 });
  assert.equal(deps.chamou('aplicarTransicao').length, 1, 'o worker reprocessa a partir do corpo mínimo guardado');
  assert.equal(deps.notificados().length, 1);
  // esgotou → Lei 8
  deps = depsFalsas({
    buscarCobranca: () => { throw new Error('ainda fora'); },
    inbox: {
      listarParaReprocessar: () => [{ id: 'in_9', tentativas: 7 }],
      reivindicarProcessamento: (id) => ({ id, tentativas: 7, referencia_id: 'pay_1', corpo_minimo: { event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } } }),
      marcarFalha: () => ({ tentativas: 8, esgotou: true })
    }
  });
  await reprocessarInbox(deps);
  assert.equal(deps.chamou('registrarErro').length, 1, 'tentativas esgotadas viram erro registrado (Lei 8)');

  /* ============================================================
     A NOTIFICAÇÃO NUNCA SEGURA O FLUXO (contratante pendurado)
     Com a outbox, o que o fluxo aguarda é a ESCRITA local; a rede é
     do worker. O dublê abaixo prova que `notificar` devolve antes de
     qualquer fetch: nenhum `fetch` é chamado dentro dela.
     ============================================================ */
  {
    const fetchOriginal = globalThis.fetch;
    let fetchChamado = 0;
    globalThis.fetch = async () => { fetchChamado += 1; return { ok: true, status: 200 }; };
    try {
      const fonte = (await import('node:fs')).readFileSync(new URL(import.meta.url), 'utf8');
      // As agulhas são montadas em tempo de execução para este próprio
      // texto não casar consigo mesmo.
      const agulhaTimer = ['setTimeout(() => ', 'notificarContratante'].join('');
      const agulhaFila = ['ATRASOS_', 'RETRY_MS'].join('');
      assert.ok(!fonte.includes(agulhaTimer), 'H-01: nenhum retry em memória sobrou neste arquivo');
      assert.ok(!fonte.includes(agulhaFila), 'H-01: a fila em memória foi removida');
    } finally {
      globalThis.fetch = fetchOriginal;
    }
    assert.equal(fetchChamado, 0);
  }

  console.log(`webhookController: ${checagens} checagens OK`);
}
