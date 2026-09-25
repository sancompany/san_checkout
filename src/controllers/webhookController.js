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
  buscarCobrancaPorCheckoutId,
  buscarCobrancaPorReferenciaExterna,
  vincularChargeIdAoCheckout,
  vincularSessaoAReserva,
  aplicarTransicaoPorCheckoutId,
  marcarSessaoConcluida,
  atualizarSubscriptionIdDaCobranca,
  buscarCobrancaPorSubscriptionId,
  registrarCicloAssinatura,
  atualizarSituacaoSubconta,
  listarCobrancasParadas
} from '../services/cobrancaService.js';
import { upsertAssinatura, atualizarStatusAssinatura, buscarAssinaturaPorId } from '../services/assinaturaService.js';
import { cancelarAssinatura as cancelarAssinaturaNaAsaas, lerPagamentoNaAsaas, listarEstornosDaCobranca } from '../services/asaasService.js';
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
  listarParaReprocessar,
  marcarReconciladas,
  reabrirSeFalhou,
  listarEsgotadasDePagamento
} from '../services/webhookInboxService.js';
import { enfileirarNotificacao, tentarAgora } from '../services/outboxService.js';
import { decidirTransicao, caminhoDeTransicoes } from '../services/transicoesFinanceiras.js';
import { METODOS_DE_ASSINATURA, METODO_ACERTO_TROCA } from '../services/pedidoService.js';
import { compararSeguro } from '../utils/validadores.js';
import { somarReais, emCentavos } from '../utils/dinheiro.js';
import { cicloCanonico } from '../utils/ciclos.js';
import {
  buscarIntencaoPorChargeId,
  buscarIntencao,
  registrarChargeId as registrarChargeIdDaIntencao,
  marcarConfirmada as marcarIntencaoConfirmada
} from '../services/trocaIntencaoService.js';
import { resolverAposClassificacao, retomarAplicacao } from '../services/trocaExecucaoService.js';
import { classificarPagamentoDoAcerto } from '../services/classificacaoFinanceiraService.js';
import { registrarErro } from '../services/erroService.js';
import { aoLiquidarCobrancaDePedido, dispararCancelador } from '../services/irmasObsoletasService.js';
import { reabrirEstornosNegados } from '../services/estornoService.js';

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
  reabrirEstornosNegados,
  aplicarTransicao,
  buscarCobrancaPorCheckoutId,
  buscarCobrancaPorReferenciaExterna,
  vincularChargeIdAoCheckout,
  vincularSessaoAReserva,
  aplicarTransicaoPorCheckoutId,
  marcarSessaoConcluida,
  atualizarSubscriptionIdDaCobranca,
  buscarCobrancaPorSubscriptionId,
  registrarCicloAssinatura,
  atualizarSituacaoSubconta,
  upsertAssinatura,
  atualizarStatusAssinatura,
  buscarAssinaturaPorId,
  cancelarAssinaturaNaAsaas,
  registrarErro,
  /** RN-51/RN-52: irmãs obsoletas e duplicidade, na liquidação de um
   *  pedido. Local; a rede para a Asaas é do cancelador, disparado fora
   *  do fluxo. */
  aoLiquidarPedido: aoLiquidarCobrancaDePedido,
  dispararCancelador: () => dispararCancelador(),
  /**
   * A notificação ao contratante: ENFILEIRA na outbox (durável) e
   * dispara a primeira tentativa fora do fluxo. O `await` aqui é só da
   * escrita local — a rede fica com o worker, então um contratante
   * pendurado nunca segura a resposta à Asaas (CONSTRAINTS.md §2.3).
   */
  notificar: async ({ contratante, tipo, evento, chave, payload, ocorridoEm, aplicada = false }) => {
    const enfileirar = (chaveIdempotencia) => enfileirarNotificacao({
      contratanteId: contratante?.id ?? payload?.contratanteId ?? null,
      url: contratante?.webhook_url,
      tipo,
      evento,
      chaveIdempotencia,
      payload,
      ocorridoEm
    });
    let { id, nova } = await enfileirar(chave);
    /* O MESMO fato, de novo, de verdade: a transição foi APLICADA agora
       (não é reentrega) e a chave do fato já existia — é uma cobrança
       que voltou a `confirmado` depois de `pendente` (baixa desfeita e
       refeita), ou um chargeback vencido. O contratante precisa ouvir
       a segunda vez; uma reentrega ou um evento equivalente
       (`PAYMENT_RECEIVED` depois de `PAYMENT_CONFIRMED`) NÃO aplica
       transição e cai na chave do fato, que já existe → nada. */
    if (!nova && aplicada && id) {
      ({ id, nova } = await enfileirar(`${chave}|r${ocorridoEm ?? new Date().toISOString()}`));
    }
    if (nova) tentarAgora(id);
    return { id, nova };
  },
  registrarAuditoria: (dados) => registrarEventoWebhook(dados),
  /** A cobrança como a Asaas a vê agora (SEC-007). O `contexto` (evento,
   *  alvo) só decide se vale buscar a lista de estornos — quem manda é o
   *  `chargeId`. */
  estadoNaAsaas: (chargeId, contexto) => estadoDaCobrancaNaAsaas(chargeId, contexto),
  inbox: { registrarNaInbox, reivindicarProcessamento, marcarProcessado, marcarIgnorado, marcarFalha: marcarFalhaNaInbox, listarParaReprocessar, marcarReconciladas, reabrirSeFalhou },
  /** JULES-004: as cobranças com SINAL de divergência (evento esgotado na
   *  inbox, estado de passagem parado). Nunca todas. */
  listarCandidatasADivergencia: () => listarCandidatasADivergencia(),
  /** O acerto de uma troca de plano ainda sem `cobrancas` — resolve
   *  pela intenção. `true` quando encontrou. */
  avancarIntencaoDeTrocaPorChargeId: async (chargeId, evento, statusNaAsaas = null, referenciaExterna = null) => {
    let intencao = await buscarIntencaoPorChargeId(chargeId);

    /* A ÓRFÃ (SEC-009, 25/09/2026): o processo morreu entre cobrar e
       gravar o `charge_id` (ou a cobrança ficou ambígua) — a intenção não
       conhece este pagamento, mas a Asaas diz a referência dele
       (`troca:<id>`, gravada na cobrança; aqui já é o valor DELA, não do
       corpo). Vincula por CAS e segue. Até aqui este evento era
       descartado: o assinante pagava o acerto e o plano nunca mudava. */
    if (!intencao) {
      const intencaoId = /^troca:([0-9a-f-]{36})$/i.exec(referenciaExterna ?? '')?.[1];
      if (!intencaoId) return false;
      intencao = await buscarIntencao(intencaoId);
      if (!intencao) return false;
      if (intencao.charge_id && intencao.charge_id !== chargeId) {
        await registrarErro(
          new Error(`SEGUNDO acerto cobrado para a intenção de troca ${intencao.id}: ${intencao.charge_id} e ${chargeId} (${evento}) — estornar um`),
          { contexto: 'webhookController.segundoAcerto', rota: 'webhook/asaas', metodo: 'POST' }
        );
        return true;
      }
      if (!intencao.charge_id) {
        const vinculou = await registrarChargeIdDaIntencao(intencao.id, chargeId);
        if (!vinculou) throw new Error(`a intenção ${intencao.id} ganhou outro charge_id enquanto o evento de ${chargeId} a lia; reprocessar`);
        intencao = { ...intencao, charge_id: chargeId };
      }
    }

    // O status da ASAAS primeiro (SEC-007): o evento sozinho não paga nada.
    const veredito = classificarPagamentoDoAcerto({ status: statusNaAsaas, evento });
    if (veredito === 'PAID') {
      const confirmada = await marcarIntencaoConfirmada(intencao.id);
      if (confirmada) {
        // Fora do fluxo, e com DONO (SEC-013): a falha vira `erros`, nunca promessa solta.
        retomarAplicacao(confirmada).catch((erro) => registrarErro(
          new Error(`acerto ${chargeId} pago e a aplicação da troca ${intencao.id} falhou fora do fluxo: ${erro.message} — o sweeper retoma`),
          { contexto: 'webhookController.aplicarTroca', rota: 'webhook/asaas', metodo: 'POST' }
        ));
      } else if (!['PAYMENT_CONFIRMED', 'APPLYING_PLAN', 'COMPLETED'].includes(intencao.status)) {
        /* Pago na Asaas e a intenção já fechada sem dinheiro (STALE,
           EXPIRED, recusada) ou em reconciliação: o plano NÃO mudou e o
           assinante pagou. Nunca calado. */
        await registrarErro(
          new Error(`acerto ${chargeId} PAGO na Asaas para a intenção ${intencao.id}, que está "${intencao.status}" — o plano NÃO foi trocado; aplicar à mão ou estornar`),
          { contexto: 'webhookController.acertoSemTroca', rota: 'webhook/asaas', metodo: 'POST' }
        );
      }
    } else {
      await resolverAposClassificacao(intencao, veredito);
    }
    return true;
  }
};

/** As duas fontes de sinal de divergência, uma lista só por `chargeId`. */
async function listarCandidatasADivergencia() {
  const porCharge = new Map();
  for (const { chargeId, id } of await listarEsgotadasDePagamento()) {
    const atual = porCharge.get(chargeId) ?? { chargeId, linhasDaInbox: [] };
    atual.linhasDaInbox.push(id);
    porCharge.set(chargeId, atual);
  }
  for (const { charge_id: chargeId } of await listarCobrancasParadas()) {
    if (!porCharge.has(chargeId)) porCharge.set(chargeId, { chargeId, linhasDaInbox: [] });
  }
  return [...porCharge.values()];
}

/* ------------------------------------------------------------------
   Guarda de origem
------------------------------------------------------------------ */

/**
 * Aplicado em webhookRoutes.js antes do receptor. A Asaas reenvia, em
 * cada webhook, o "Token de acesso" configurado no painel dela no header
 * `asaas-access-token` (doc oficial: "Se o Webhook estiver configurado
 * com authToken, o valor será enviado no header asaas-access-token").
 * Fail-closed: sem env configurada, recusa tudo. Não existe assinatura
 * de corpo no contrato da Asaas (M-01); existem a lista oficial de IPs
 * de origem (conferida abaixo) e o `GET /v3/payments/{id}`, que é o que
 * de fato impede um evento forjado de mover dinheiro (RN-56): o token
 * só abre a porta, quem decide é a Asaas.
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
  /* A ORIGEM, o segundo mecanismo oficial (SEC-007). Com token certo e IP
     fora da lista, o token vazou ou a lista mudou — os dois precisam de
     alguém olhando. Recusar só com `ASAAS_WEBHOOK_IP_ESTRITO=1`: a origem
     REAL das entregas, como este processo a vê atrás do proxy da
     Northflank, ainda não foi medida (o log de ingress não está
     habilitado nesta conta; a primeira entrega depois deste deploy é a
     medida — o IP vai no log do receptor). Recusar antes de medir era
     arriscar pausar a fila da Asaas (15 falhas) por um palpite; o que
     move dinheiro já não depende disto, porque todo `PAYMENT_*` é
     conferido na Asaas antes de valer. */
  const ip = ipDaRequisicao(requisicao);
  if (!origemOficialDaAsaas(ip)) {
    if (process.env.ASAAS_WEBHOOK_IP_ESTRITO === '1') {
      registrarRejeicaoWebhook({ ip, tinhaToken: true, motivo: 'token válido, IP fora da lista oficial da Asaas' });
      return resposta.status(403).json({ erro: 'Origem do webhook não reconhecida.' });
    }
    registrarErro(
      new Error(`webhook com token válido vindo de ${ip ?? 'IP desconhecido'}, fora da lista oficial da Asaas — token vazado, ou a lista mudou; conferir antes de ligar ASAAS_WEBHOOK_IP_ESTRITO`),
      { contexto: 'webhookController.origem', rota: 'webhook/asaas', metodo: 'POST' }
    )?.catch?.(() => {});
  }
  proximo();
}

/** Os IPs de onde a Asaas envia webhook (doc oficial "Webhooks — IPs
 *  oficiais", lida em 25/09/2026). `ASAAS_WEBHOOK_IPS` (lista separada por
 *  vírgula) substitui a lista sem deploy, se a Asaas anunciar mudança. */
export const IPS_OFICIAIS_DA_ASAAS = ['52.67.12.206', '18.230.8.159', '54.94.136.112', '54.94.183.101'];

export function origemOficialDaAsaas(ip) {
  if (typeof ip !== 'string' || !ip) return false;
  const lista = process.env.ASAAS_WEBHOOK_IPS
    ? process.env.ASAAS_WEBHOOK_IPS.split(',').map((s) => s.trim()).filter(Boolean)
    : IPS_OFICIAIS_DA_ASAAS;
  return lista.includes(ip.replace(/^::ffff:/i, ''));
}

/** O IP de quem conectou, como o Express o resolve com `trust proxy` — o
 *  mesmo que o limitador usa (medido em 25/09/2026: um `X-Forwarded-For`
 *  forjado não muda o balde). O primeiro item do `X-Forwarded-For`, que
 *  era lido aqui, é o que o CLIENTE escreve: servia de diagnóstico e não
 *  pode servir de decisão. */
function ipDaRequisicao(requisicao) {
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
  // `status` ausente conta como concluído nas DUAS formas: `undefined`
  // no corpo cru e `null` no corpo mínimo da inbox (`podar` normaliza).
  const concluidos = payment.refunds.filter((r) => r && (r.status === 'DONE' || r.status == null));
  if (concluidos.length === 0) return null;
  return somarReais(concluidos.map((r) => r.value));
}

/* ------------------------------------------------------------------
   A ASAAS COMO FONTE DA VERDADE (SEC-007/SEC-008/SEC-019, 25/09/2026)

   Até aqui o evento era aplicado pelo que o CORPO dizia: o status saía do
   nome do evento, o vínculo de `externalReference`/`checkoutSession`/
   `subscription` e o valor do ciclo saíam do payload, e o carimbo do
   `dateCreated`. O único portão era o token estático do header — vazado
   ele, um evento novo com um `payment.id` real confirmava cobrança sem
   pagamento, e um carimbo no futuro congelava a máquina de estados.

   Agora todo `PAYMENT_*` pergunta à Asaas (`GET /v3/payments/{id}`) antes
   de mexer em dinheiro, e o que é do provedor vem do provedor:

     - a cobrança tem de EXISTIR nesta conta (404 = não é nossa);
     - todo vínculo usa os campos DELA, nunca os do corpo;
     - transição que move dinheiro exige RESPALDO: `confirmado` só com a
       cobrança paga (ou num estado que implica que foi paga), estorno
       só com o estorno lá, contestação só com a contestação lá;
     - o estado local que JÁ é o da Asaas não é mexido por evento
       histórico (a confirmação D+30 de um cartão em disputa não tira a
       cobrança de `chargeback` — SEC-019);
     - "transição não permitida" com a Asaas À FRENTE do estado local é
       estado anterior faltando, não evento descartável: LANÇA, e a inbox
       tenta de novo (SEC-008). Com a Asaas IGUAL ao local, é obsoleto
       provado e se ignora;
     - carimbo no futuro vale "agora".
------------------------------------------------------------------ */

/** Status de cobrança da Asaas (os 14 da doc "Recuperar uma única
 *  cobrança", lida em 25/09/2026) → o status local que ele IMPLICA. */
export function estadoLocalDaAsaas(pagamento, valorEstornado = null) {
  if (!pagamento || pagamento.deleted) return null;
  switch (pagamento.status) {
    case 'PENDING': return 'pendente';
    case 'AWAITING_RISK_ANALYSIS': return 'em_analise';
    case 'CONFIRMED': case 'RECEIVED': case 'RECEIVED_IN_CASH':
      return valorEstornado && emCentavos(valorEstornado) > 0 ? 'estornado_parcialmente' : 'confirmado';
    case 'OVERDUE': return 'vencido';
    case 'REFUNDED': return 'estornado';
    case 'REFUND_REQUESTED': case 'REFUND_IN_PROGRESS': return 'estorno_solicitado';
    case 'CHARGEBACK_REQUESTED': case 'CHARGEBACK_DISPUTE': case 'AWAITING_CHARGEBACK_REVERSAL': return 'chargeback';
    default: return null; // DUNNING_*, ou status novo: não se presume nada
  }
}

/** Para cada alvo que MOVE DINHEIRO, os estados da Asaas que o
 *  respaldam — o próprio, ou um posterior que implica que ele aconteceu. */
const RESPALDO_DO_PROVEDOR = {
  confirmado: ['confirmado', 'estornado_parcialmente', 'estorno_solicitado', 'estornado', 'chargeback'],
  estornado_parcialmente: ['estornado_parcialmente', 'estorno_solicitado', 'estornado'],
  estorno_solicitado: ['estorno_solicitado', 'estornado_parcialmente', 'estornado'],
  estornado: ['estornado'],
  chargeback: ['chargeback', 'estornado'],
  pendente: ['pendente', 'vencido'], // baixa desfeita: o dinheiro saiu de novo
  /* A negativa de estorno também move dinheiro, ao contrário: desde RN-71
     ela REABRE a operação e libera um novo pedido. Só vale com o pagamento
     de volta a pago na Asaas — uma negativa velha, reprocessada depois de
     um novo pedido aceito, com a Asaas ainda em `REFUND_REQUESTED`,
     reabriria o pedido vivo e mandaria o estorno de novo (CP1-01). Sem
     respaldo, lança: a negativa legítima que chegou antes da Asaas
     refletir é reaplicada com recuo; a velha esgota e vira `erros`. */
  estorno_negado: ['confirmado', 'estornado_parcialmente']
};
export const ALVOS_QUE_MOVEM_DINHEIRO = Object.keys(RESPALDO_DO_PROVEDOR);

/** O alvo do evento tem respaldo no estado atual da Asaas? Alvos
 *  informativos (em análise, recusado, vencido) só precisam de a
 *  cobrança existir e ser nossa. */
export function respaldoDoProvedor(alvo, estadoDaAsaas) {
  if (!ALVOS_QUE_MOVEM_DINHEIRO.includes(alvo)) return true;
  return Boolean(estadoDaAsaas) && RESPALDO_DO_PROVEDOR[alvo].includes(estadoDaAsaas);
}

/** Onde cada estado fica na história de uma cobrança — pendente, depois
 *  as passagens, o pago, e o que acontece com o pago. Só a ORDEM importa. */
const POSICAO_NA_HISTORIA = {
  pendente: 0, em_analise: 1, recusado: 1, vencido: 1, expirado: 1,
  confirmado: 2, estorno_solicitado: 3, estorno_negado: 3, estornado_parcialmente: 4,
  chargeback: 5, estornado: 6, cancelado: 7, cancelado_por_outro_pagamento: 7
};

/**
 * O que fazer com um evento, olhando a Asaas:
 *
 *  - `historico`: o estado local JÁ É o da Asaas e o evento aponta para
 *    um ponto ANTERIOR da história (reentrega, reprocessamento, a
 *    liquidação D+30 de um cartão em disputa — SEC-019). Obsoleto provado:
 *    ignora, sem barulho.
 *  - `sem_respaldo`: o alvo move dinheiro e a Asaas não o mostra. Lança —
 *    evento prematuro é tentado de novo; forjado esgota e vira `erros`.
 *  - `seguir`: a máquina de estados decide.
 */
export function veredictoDaAsaas(statusLocal, alvo, estadoDaAsaas) {
  if (estadoDaAsaas && estadoDaAsaas === statusLocal && alvo !== statusLocal
      && (POSICAO_NA_HISTORIA[alvo] ?? 99) < (POSICAO_NA_HISTORIA[statusLocal] ?? -1)) {
    return 'historico';
  }
  if (!respaldoDoProvedor(alvo, estadoDaAsaas)) return 'sem_respaldo';
  return 'seguir';
}

/** O mais recente de dois carimbos ISO (qualquer um pode faltar). */
function oMaisRecente(a, b) {
  const ta = a ? new Date(a).getTime() : NaN;
  const tb = b ? new Date(b).getTime() : NaN;
  if (Number.isNaN(ta)) return Number.isNaN(tb) ? null : b;
  if (Number.isNaN(tb)) return a;
  return tb > ta ? b : a;
}

/** Carimbo do evento no futuro (relógio da Asaas adiantado, ou corpo
 *  forjado) vale "agora" — senão todo evento legítimo depois dele
 *  pareceria "mais antigo" e seria ignorado (SEC-007). */
export function carimboAtePresente(ocorridoEm, agora = Date.now()) {
  if (!ocorridoEm) return ocorridoEm;
  const t = new Date(ocorridoEm).getTime();
  if (Number.isNaN(t)) return null;
  return t > agora + 2 * 60_000 ? new Date(agora).toISOString() : ocorridoEm;
}

const ALVOS_DE_ESTORNO = ['estornado', 'estornado_parcialmente', 'estorno_solicitado', 'estorno_negado'];
const ESTADOS_LOCAIS_COM_ESTORNO = ALVOS_DE_ESTORNO;

/** O estado da cobrança na Asaas, com o valor estornado DELA. A lista de
 *  estornos só é buscada à parte quando o `GET` não a trouxe e ela decide
 *  alguma coisa: o evento é de estorno, a cobrança está `REFUNDED`, ou
 *  quem pergunta é o reconciliador (`comEstornos`), que precisa ver um
 *  estorno PARCIAL — a cobrança parcialmente estornada continua
 *  `RECEIVED`/`CONFIRMED` no status. */
export async function estadoDaCobrancaNaAsaas(chargeId, { alvo = null, comEstornos = false } = {}) {
  const pagamento = await lerPagamentoNaAsaas(chargeId);
  if (!pagamento) return { existe: false, pagamento: null, estado: null, valorEstornado: null };
  let estornos = pagamento.refunds;
  const precisaDaLista = ALVOS_DE_ESTORNO.includes(alvo) || pagamento.status === 'REFUNDED'
    || (comEstornos && ['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'].includes(pagamento.status));
  if (!Array.isArray(estornos) && precisaDaLista) {
    estornos = await listarEstornosDaCobranca(chargeId);
  }
  const valorEstornado = Array.isArray(estornos) ? valorEstornadoDoPayment({ refunds: estornos }) : null;
  return { existe: true, pagamento, estado: estadoLocalDaAsaas(pagamento, valorEstornado), valorEstornado };
}

/** Os campos que decidem vínculo e valor, vindos do PROVEDOR. O corpo do
 *  evento fica só com o que a Asaas não devolve no GET. */
function comOQueAAsaasDiz(paymentDoCorpo, pagamento) {
  if (!pagamento) return paymentDoCorpo;
  return {
    ...paymentDoCorpo,
    id: pagamento.id ?? paymentDoCorpo?.id,
    status: pagamento.status,
    value: pagamento.value,
    externalReference: pagamento.externalReference,
    checkoutSession: pagamento.checkoutSession,
    subscription: pagamento.subscription,
    installment: pagamento.installment,
    ...(Array.isArray(pagamento.refunds) ? { refunds: pagamento.refunds } : {})
  };
}

/** Confirmação de um valor diferente do que cobramos não confirma sozinha
 *  (binding de valor): pedido avulso sem parcelamento, valor conhecido dos
 *  dois lados, centavos diferentes. Assinatura (o preço pode ter mudado
 *  no painel, RN-34) e parcelamento (o `value` é o da parcela) ficam fora. */
export function valorDivergenteDaCobranca(cobranca, pagamento) {
  if (METODOS_DE_ASSINATURA.includes(cobranca?.metodo_pagamento)) return false;
  if (pagamento?.installment) return false;
  const nosso = emCentavos(cobranca?.valor_cobrado);
  const deles = emCentavos(pagamento?.value);
  return nosso != null && deles != null && nosso !== deles;
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
  const ocorridoEm = carimboAtePresente(ocorridoEmDoEvento(corpo));
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
/** Teto do processamento INLINE antes do 200 (C1-06). Desde SEC-007 o
 *  processamento pergunta à Asaas (até 20 s por chamada, às vezes mais de
 *  uma); com a Asaas lenta, a resposta levaria dezenas de segundos — e
 *  resposta lenta a Asaas conta como falha, 15 seguidas PAUSAM a fila da
 *  conta inteira (`CONSTRAINTS.md` §2.7.1), parando a confirmação de
 *  todos os pagamentos. Passado o teto, responde 200 e o processamento
 *  termina em segundo plano: o evento já está na inbox, a linha já está
 *  reivindicada, e a ordem por cobrança é garantida pela máquina de
 *  estados, não pela pressa. */
export const TETO_DE_RESPOSTA_DO_WEBHOOK_MS = 8000;

export function criarReceptorWebhook(deps = dependenciasPadrao, { tetoDeRespostaMs = TETO_DE_RESPOSTA_DO_WEBHOOK_MS } = {}) {
  return async function receberWebhookAsaas(requisicao, resposta) {
    const corpo = requisicao.body;
    const evento = corpo?.event;
    const rota = classificarEvento(evento);
    const referencia = extrairReferencia(corpo);
    const campos = redigirPayload(corpo);
    // `ip`: o servidor da Asaas, não uma pessoa — é a medida da origem real (SEC-007).
    console.log('[webhook/asaas] evento:', JSON.stringify({ evento, rota, referencia, id: corpo?.id ?? null, ip: requisicao.ip ?? null, campos }));

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
       tiver sido processado").
       A exceção é a linha que FALHOU (SEC-024): reenviar um evento pelo
       painel da Asaas é o gesto de quem viu que ele não teve efeito, e
       responder "duplicado" deixava a linha esgotada morta. Ela volta à
       fila com as tentativas zeradas e é processada agora, inline. */
    if (registro.duplicado) {
      const reaberta = await deps.inbox.reabrirSeFalhou(registro.id).catch((erro) => {
        console.error('[webhook/asaas] não consegui reabrir a linha que falhou:', erro.message);
        return false;
      });
      if (!reaberta) {
        auditar(deps, { evento, rota, resultado: 'duplicado', detalhe: 'reentrega do mesmo id', referencia, campos, statusMapeado: mapearStatusPayment(evento) });
        return resposta.status(200).json({ recebido: true, duplicado: true });
      }
    }

    /* 3. PROCESSAR a partir da linha, inline. Inline, e não depois do
       200, para preservar a ordem que a Asaas garante em `SEQUENTIALLY`
       (ela só manda o próximo depois do nosso 200). O que é lento (rede
       para o contratante) está na outbox; a conferência na Asaas
       (SEC-007) tem teto — passado `tetoDeRespostaMs`, o 200 sai e o
       processamento termina em segundo plano (C1-06). */
    let desfecho = { resultado: 'erro', detalhe: 'não reivindicada' };
    const linha = await deps.inbox.reivindicarProcessamento(registro.id).catch(() => null);
    if (linha) {
      const auditarDesfecho = (d) => auditar(deps, { evento, rota, resultado: d.resultado, detalhe: d.detalhe, referencia, campos, statusMapeado: mapearStatusPayment(evento) });
      /* A promessa tem dono do começo ao fim: se passar do teto, é ela
         quem audita quando terminar; se lançar (o banco recusando
         `marcarFalha`), a linha fica `processando` e o arrendamento da
         inbox a devolve ao worker. */
      const processamento = processarLinhaDaInbox(linha, corpo, deps)
        .catch((erro) => ({ resultado: 'erro', detalhe: `falha ao registrar o desfecho: ${erro.message}` }));
      let temporizador;
      const teto = new Promise((ok) => { temporizador = setTimeout(() => ok(null), tetoDeRespostaMs); temporizador.unref?.(); });
      const noPrazo = await Promise.race([processamento, teto]);
      clearTimeout(temporizador);
      if (noPrazo) {
        auditarDesfecho(noPrazo);
      } else {
        console.warn(`[webhook/asaas] processamento de ${evento} passou de ${tetoDeRespostaMs} ms — respondendo 200 e terminando em segundo plano`);
        void processamento.then(auditarDesfecho);
      }
    } else {
      auditar(deps, { evento, rota, resultado: desfecho.resultado, detalhe: desfecho.detalhe, referencia, campos, statusMapeado: mapearStatusPayment(evento) });
    }

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

/** Quanto uma passada da inbox pode durar antes de deixar o resto para o
 *  próximo tique (C1-07): bem abaixo do atraso que o `/api/saude` acusa
 *  (3 × 60 s + 2 min). */
export const ORCAMENTO_DA_PASSADA_DA_INBOX_MS = 120_000;

/**
 * O WORKER da inbox — uma passada. Lê as linhas com tentativa vencida
 * (em ordem de recebimento), reivindica e reprocessa a partir do corpo
 * mínimo. Chamado pelo `setInterval` em `server.js` e pelo autoteste.
 */
export async function reprocessarInbox(deps = dependenciasPadrao, { orcamentoMs = ORCAMENTO_DA_PASSADA_DA_INBOX_MS, relogio = () => Date.now() } = {}) {
  const relatorio = { examinadas: 0, processadas: 0, falhas: 0 };
  const pendentes = await deps.inbox.listarParaReprocessar();
  const inicio = relogio();
  for (const candidata of pendentes) {
    /* Orçamento da passada (C1-07): com a Asaas lenta, 50 linhas × 20 s
       passariam do limite de atraso do `/api/saude` — 503 por culpa de
       terceiro — e seguravam a passada seguinte. O que sobra fica para o
       próximo tique, na mesma ordem. */
    if (relogio() - inicio >= orcamentoMs) { relatorio.adiadas = pendentes.length - relatorio.examinadas; break; }
    const linha = await deps.inbox.reivindicarProcessamento(candidata.id).catch(() => null);
    if (!linha) continue;
    relatorio.examinadas += 1;
    const desfecho = await processarLinhaDaInbox(linha, linha.corpo_minimo, deps);
    if (desfecho.resultado === 'erro') relatorio.falhas += 1; else relatorio.processadas += 1;
  }
  return relatorio;
}

/**
 * O RECONCILIADOR DIRIGIDO (JULES-004, 25/09/2026).
 *
 * O reconciliador de reservas (H-06) só olha reserva sem `charge_id`.
 * Ficava de fora a cobrança que EXISTE e divergiu da Asaas porque os
 * eventos do meio se perderam: o `PAYMENT_CONFIRMED` que esgotou as oito
 * tentativas da inbox, o estorno de boleto cujo `PAYMENT_REFUNDED` nunca
 * veio. Divergência assim ficava para sempre, calada.
 *
 * DIRIGIDO, não varredura: só olha as cobranças que têm SINAL de
 * divergência — evento de pagamento esgotado na inbox, ou estado de
 * passagem parado há tempo demais (`em_analise` > 1 dia,
 * `estorno_solicitado` > 3 dias). Para cada uma, pergunta à Asaas, acha o
 * caminho permitido do estado local até o dela (`caminhoDeTransicoes`) e
 * passa CADA passo pelo `processarEventoPayment` como evento sintético —
 * que confere de novo na Asaas e roda o mesmo rabo de sempre (irmãs,
 * vínculo de assinatura, aviso ao contratante com a chave do fato). O
 * reconciliador nunca grava estado por um atalho próprio.
 */
const EVENTO_QUE_LEVA_A = {
  confirmado: 'PAYMENT_RECEIVED', estornado: 'PAYMENT_REFUNDED', estornado_parcialmente: 'PAYMENT_PARTIALLY_REFUNDED',
  estorno_solicitado: 'PAYMENT_REFUND_IN_PROGRESS', estorno_negado: 'PAYMENT_REFUND_DENIED', chargeback: 'PAYMENT_CHARGEBACK_REQUESTED',
  vencido: 'PAYMENT_OVERDUE', em_analise: 'PAYMENT_AWAITING_RISK_ANALYSIS', recusado: 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
  pendente: 'PAYMENT_RECEIVED_IN_CASH_UNDONE'
};

/** A cobrança que a reconciliação não conseguiu resolver sai da frente
 *  por um tempo (C1-11): a lista vem em ordem fixa (a mais antiga
 *  primeiro), e vinte sem solução — charge de outra conta, sem caminho
 *  permitido, Asaas sem estado — tomavam o lote de toda passada por até
 *  14 dias, com as resolvíveis esperando atrás. Em memória de propósito:
 *  é só prioridade; reiniciar o processo apenas as traz de volta. */
const RECONCILIACAO_ADIADAS_ATE = new Map();
const HORA_MS = 60 * 60_000;

export async function reconciliarDivergenciasUmaVez(deps = dependenciasPadrao, { adiadasAte = RECONCILIACAO_ADIADAS_ATE, agora = () => Date.now(), lote = 20, adiarPorMs = HORA_MS } = {}) {
  const relatorio = { examinadas: 0, corrigidas: 0, iguais: 0, semCaminho: 0, falhas: 0 };
  const agoraMs = agora();
  const candidatas = (await deps.listarCandidatasADivergencia())
    .filter(({ chargeId }) => !(adiadasAte.get(chargeId) > agoraMs))
    .slice(0, lote);
  const adiar = (chargeId) => adiadasAte.set(chargeId, agoraMs + adiarPorMs);
  for (const { chargeId, linhasDaInbox = [] } of candidatas) {
    relatorio.examinadas += 1;
    try {
      const cobranca = await deps.buscarCobranca(chargeId);
      if (!cobranca) { adiar(chargeId); continue; } // charge que não é nosso: o alerta do evento já existe
      const naAsaas = await deps.estadoNaAsaas(chargeId, { alvo: null, comEstornos: true });
      if (!naAsaas?.existe || !naAsaas.estado) { adiar(chargeId); continue; } // sem verdade para seguir: fica para um humano
      /* Mesmo estado, mais dinheiro devolvido: um SEGUNDO estorno parcial
         cujo evento se perdeu. O status não muda — o acumulado muda, e é
         ele que o contratante precisa ouvir. */
      const parcialAvancou = naAsaas.estado === 'estornado_parcialmente' && cobranca.status === 'estornado_parcialmente'
        && (emCentavos(naAsaas.valorEstornado) ?? 0) > (emCentavos(cobranca.valor_estornado) ?? 0);
      if (parcialAvancou) {
        await processarWebhook({ event: EVENTO_QUE_LEVA_A.estornado_parcialmente, payment: { id: chargeId }, dateCreated: new Date().toISOString() }, deps);
        relatorio.corrigidas += 1;
      } else if (naAsaas.estado !== cobranca.status) {
        const caminho = caminhoDeTransicoes(cobranca.status, naAsaas.estado);
        if (!caminho) {
          relatorio.semCaminho += 1;
          adiar(chargeId);
          await deps.registrarErro(
            new Error(`reconciliação: ${chargeId} está "${cobranca.status}" aqui e "${naAsaas.estado}" na Asaas, e não há transição permitida entre os dois — conferir à mão`),
            { contexto: 'webhookController.reconciliarDivergencias', rota: 'worker/reconciliacao', metodo: 'WORKER' }
          );
          continue;
        }
        for (const passo of caminho) {
          await processarWebhook({ event: EVENTO_QUE_LEVA_A[passo], payment: { id: chargeId }, dateCreated: new Date().toISOString() }, deps);
        }
        relatorio.corrigidas += 1;
      } else {
        relatorio.iguais += 1;
      }
      if (linhasDaInbox.length) await deps.inbox.marcarReconciladas(linhasDaInbox);
      adiadasAte.delete(chargeId);
    } catch (erro) {
      relatorio.falhas += 1;
      adiar(chargeId);
      console.error(`[reconciliacao] ${chargeId}:`, erro.message);
    }
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

  /* Por CAS, desde 25/09/2026 (SEC-020): só ativa o que está
     `pendente`, e só encerra o que está `pendente` ou `confirmado` — um
     estorno não é apagado por um evento de autorização, e a reentrega do
     mesmo evento não repete o aviso ao contratante. A semântica em si
     ("autorização ativada" vira `confirmado` sem dinheiro nenhum ter
     entrado) NÃO foi mudada: o método está desligado nesta conta
     (`CONSTRAINTS.md` §2.4) e o evento real nunca foi medido — risco
     aceito, registrado no relatório da Estação 6. */
  if (evento === ATIVOU) {
    /* Já `confirmado`: pode ser a refeitura de uma passagem que gravou a
       transição e morreu antes da assinatura ou do aviso (C1-09). Os dois
       são idempotentes — `upsert`, e a chave do fato na outbox — e são
       refeitos; o que a CAS impede é o `pendente → confirmado` duas vezes. */
    if (cobranca.status !== 'pendente' && cobranca.status !== 'confirmado') return;
    if (cobranca.status === 'pendente') {
      const ativou = await deps.aplicarTransicaoPorCheckoutId(autorizacaoId, { de: 'pendente', para: 'confirmado', ocorridoEm });
      if (!ativou) return;
    } else if (await deps.buscarAssinaturaPorId(autorizacaoId)) {
      /* Refeitura com a assinatura JÁ criada: nada a refazer (C2-L1). O
         `upsert` a devolveria a `ativa` no plano de origem — por cima de
         uma pausa, cancelamento ou troca — e o aviso sairia de novo. */
      return;
    }
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
    // Já `cancelado`: refeitura de um aviso que não chegou a ser enfileirado (C1-09) — a chave do fato deduplica.
    if (!['pendente', 'confirmado', 'cancelado'].includes(cobranca.status)) return;
    if (cobranca.status !== 'cancelado') {
      const encerrou = await deps.aplicarTransicaoPorCheckoutId(autorizacaoId, { de: cobranca.status, para: 'cancelado', ocorridoEm });
      if (!encerrou) return;
    }
    return notificarAssinatura(cobranca, { evento: 'cancelada', assinaturaId: autorizacaoId, chargeId: null, statusFinanceiro: 'cancelado', ocorridoEm }, deps);
  }
}

/* ------------------------------------------------------------------
   VOCABULÁRIO 1 — PAYMENT_* (payment.id = nosso charge_id)
------------------------------------------------------------------ */

async function processarEventoPayment(corpo, deps = dependenciasPadrao, ocorridoEm = null) {
  const evento = corpo?.event;
  const chargeId = corpo?.payment?.id;
  if (!chargeId) return;

  const novoStatus = mapearStatusPayment(evento);
  if (!novoStatus) return;

  /* A linha LOCAL pelo charge (nada do corpo decide qual): o estado dela
     diz se a lista de estornos da Asaas tem de vir junto — uma cobrança
     parcialmente estornada continua `RECEIVED` no status, e sem a lista
     ela pareceria "confirmado" e um evento histórico sobre ela viraria
     alarme falso de estado faltando. */
  let cobranca = await deps.buscarCobranca(chargeId);

  /* SEC-007: a cobrança como a ASAAS a vê, antes de qualquer vínculo ou
     escrita. Falha ao perguntar LANÇA (a inbox tenta de novo) — "não
     consegui conferir" nunca vira "confirmado". */
  const naAsaas = await deps.estadoNaAsaas(chargeId, {
    evento, alvo: novoStatus, payment: corpo.payment, comEstornos: ESTADOS_LOCAIS_COM_ESTORNO.includes(cobranca?.status)
  });
  if (!naAsaas?.existe) {
    await deps.registrarErro(
      new Error(`webhook ${evento} sobre ${chargeId}, que NÃO existe nesta conta da Asaas — evento de outra integração ou forjado (token do webhook vazado?). Nada foi aplicado.`),
      { contexto: 'webhookController.semRespaldo', rota: 'webhook/asaas', metodo: 'POST' }
    );
    return;
  }
  // Daqui para baixo, vínculo e valor vêm do PROVEDOR, nunca do corpo.
  const payment = comOQueAAsaasDiz(corpo.payment, naAsaas.pagamento);

  /* INTEGRIDADE DO VÍNCULO: a linha achada pelo `charge_id` tem de ser a
     que a Asaas diz — mesma reserva (`reserva-<id>`) e mesma sessão.
     Divergir é banco corrompido ou vínculo trocado: nada se aplica. */
  if (cobranca) {
    const ref = payment?.externalReference;
    /* Ciclo de assinatura já amarrado: TODO ciclo leva a referência da
       1ª reserva (a da assinatura), e a linha do ciclo 2+ tem id próprio.
       Ali quem identifica é a ASSINATURA — comparar a referência lançava
       para sempre a partir do 2º ciclo (C1-02). */
    const cicloAmarrado = Boolean(cobranca.asaas_subscription_id && payment?.subscription);
    if (cicloAmarrado && payment.subscription !== cobranca.asaas_subscription_id) {
      throw new Error(`vínculo inconsistente: ${chargeId} está na linha da assinatura ${cobranca.asaas_subscription_id}, mas a Asaas diz ${payment.subscription}; conferir`);
    }
    if (!cicloAmarrado && cobranca.id && typeof ref === 'string' && /^reserva-[0-9a-f-]{36}$/i.test(ref) && ref !== `reserva-${cobranca.id}`) {
      throw new Error(`vínculo inconsistente: ${chargeId} está na linha ${cobranca.id}, mas a Asaas diz referência ${ref}; conferir`);
    }
    if (cobranca.asaas_checkout_id && payment?.checkoutSession && payment.checkoutSession !== cobranca.asaas_checkout_id) {
      throw new Error(`vínculo inconsistente: ${chargeId} está na sessão ${cobranca.asaas_checkout_id}, mas a Asaas diz ${payment.checkoutSession}; conferir`);
    }
  }

  /* Primeira cobrança de um pop-up: o `charge_id` só existe AQUI
     (`payment.checkoutSession` aponta para a sessão — medido em 15/09).
     Só VINCULA o charge à linha; amarrar assinatura e cancelar a antiga
     é depois, e só quando o status for `confirmado` (abaixo). */
  if (!cobranca) cobranca = await vincularPrimeiraCobrancaDoCheckout(payment, deps);

  /* Pix/Boleto direto cuja resposta do `POST /v3/payments` se perdeu
     (H-06): a linha existe como RESERVA, sem `charge_id`, e a Asaas nos
     dá a referência de volta. Vincula pela linha e segue — sem isto o
     `PAYMENT_CONFIRMED` era consumido sem efeito e o pago ficava
     `pendente` para sempre (revisão de 24/09/2026). */
  if (!cobranca && typeof payment?.externalReference === 'string' && payment.externalReference.startsWith('reserva-')) {
    const reserva = await deps.buscarCobrancaPorReferenciaExterna(payment.externalReference);
    if (reserva && !reserva.charge_id) {
      const vinculou = await deps.vincularSessaoAReserva(reserva.id, { chargeId });
      if (!vinculou) throw new Error(`a reserva ${reserva.id} foi amarrada por outro caminho enquanto este evento de ${chargeId} a lia; reprocessar`);
      cobranca = { ...reserva, charge_id: chargeId };
    } else if (reserva && !payment.subscription && !payment.installment) {
      /* A NOSSA referência numa cobrança que não é a da linha: a Asaas
         tem DOIS pagamentos para a mesma reserva (a linha já está com
         outro `charge_id`). Ciclo de assinatura e parcela compartilham a
         referência de propósito e ficam fora. Não é evento de outra
         integração — é dinheiro deste pedido sem linha, e um humano
         precisa decidir o estorno (RN-52). */
      await deps.registrarErro(
        new Error(`pagamento ${chargeId} (${evento}) leva a referência ${payment.externalReference}, cuja linha já está com ${reserva.charge_id} — dois pagamentos na Asaas para a mesma reserva; conferir e estornar um`),
        { contexto: 'webhookController.duplicidadeDeReserva', rota: 'webhook/asaas', metodo: 'POST' }
      );
      return;
    }
  }

  if (!cobranca) {
    // O ACERTO de uma troca ainda sem `cobrancas`: resolve pela intenção.
    const avancou = await deps.avancarIntencaoDeTrocaPorChargeId(chargeId, evento, naAsaas.pagamento?.status ?? null, payment?.externalReference ?? null);
    if (avancou) return;

    // Charge desconhecido: só interessa se for ciclo novo de assinatura.
    if (!payment?.subscription) return;
    cobranca = await registrarNovoCicloAssinatura(payment, deps);
    if (!cobranca) return;
  }

  /* BINDING DE VALOR: uma confirmação de valor diferente do que cobramos
     não confirma sozinha — alguém mexeu na cobrança na Asaas, ou o
     evento não é desta linha. Lança: esgotadas as tentativas, vira
     `erros` para um humano decidir. */
  if (novoStatus === 'confirmado' && valorDivergenteDaCobranca(cobranca, payment)) {
    throw new Error(`confirmação de ${chargeId} com valor ${payment.value} na Asaas, e a cobrança local é de ${cobranca.valor_cobrado} — não confirmada sozinha; conferir`);
  }

  /* O EVENTO CONTRA A ASAAS (SEC-007/SEC-019). */
  const veredicto = veredictoDaAsaas(cobranca.status, novoStatus, naAsaas.estado);
  if (veredicto === 'historico') {
    console.log(`[webhook/pagamento] ${chargeId}: ${evento} é histórico — a Asaas diz "${naAsaas.estado}", que já é o estado local; ignorado`);
    return;
  }
  if (veredicto === 'sem_respaldo') {
    throw new Error(`evento ${evento} de ${chargeId} sem respaldo na Asaas (lá: ${naAsaas.pagamento?.status ?? 'desconhecido'}${naAsaas.pagamento?.deleted ? ', removida' : ''}) — nada aplicado; reprocessar`);
  }

  /* A MÁQUINA DE ESTADOS (C-03). O valor estornado é o da ASAAS. */
  const valorEstornado = ['estornado', 'estornado_parcialmente'].includes(novoStatus)
    ? (naAsaas.valorEstornado ?? valorEstornadoDoPayment(payment))
    : undefined;
  let statusGravado = novoStatus;
  let aplicada = false;

  /* O carimbo só decide ORDEM quando a Asaas não decide por ele. Com a
     Asaas JÁ no estado que o evento aponta, o evento é o presente — não um
     passado atrasado —, e um `dateCreated` alguns segundos atrás do
     relógio que gravou o estado atual (o do evento sintético do
     reconciliador, ou um relógio da Asaas adiantado) não pode descartá-lo:
     era o mesmo furo do SEC-008 por outra porta, "obsoleto" dito por
     carimbo com o provedor mostrando o contrário. O carimbo gravado nunca
     anda para trás. */
  const aAsaasConfirmaOAlvo = naAsaas.estado === novoStatus;
  const carimbo = aAsaasConfirmaOAlvo ? oMaisRecente(cobranca.status_evento_em, ocorridoEm) : ocorridoEm;
  const decisao = decidirTransicao(cobranca, novoStatus, aAsaasConfirmaOAlvo ? null : ocorridoEm);
  /* Um SEGUNDO estorno parcial chega com o MESMO status e um acumulado
     maior — "mesmo status" aqui não é reentrega, é dinheiro novo saindo.
     Só o valor avança; se não avançou, é reentrega de verdade. */
  const segundoParcial = decisao.acao === 'ignorar'
    && novoStatus === 'estornado_parcialmente' && cobranca.status === 'estornado_parcialmente'
    && valorEstornado !== null && (emCentavos(valorEstornado) ?? 0) > (emCentavos(cobranca.valor_estornado) ?? 0);
  const mesmoStatus = cobranca.status === novoStatus && !segundoParcial;

  if (decisao.acao === 'ignorar' && !segundoParcial && !mesmoStatus) {
    /* SEC-008 — OBSOLETO PROVADO × TEMPORARIAMENTE INAPLICÁVEL. A
       transição não é permitida a partir do estado local. Se a Asaas está
       À FRENTE dele (outro estado, e o alvo tem respaldo lá), falta um
       estado anterior — tipicamente a confirmação que falhou e está no
       recuo da inbox. Descartar este evento como "processado" deixava a
       cobrança paga com o dinheiro devolvido. LANÇA: a inbox tenta de
       novo, a anterior entra primeiro, e esgotado vira `erros`. */
    if (naAsaas.estado && naAsaas.estado !== cobranca.status && /não é permitida/.test(decisao.motivo ?? '')) {
      throw new Error(`transição ${cobranca.status} → ${novoStatus} de ${chargeId} ainda não se aplica: a Asaas já está em "${naAsaas.estado}" e falta o estado anterior; reprocessar`);
    }
    console.log(`[webhook/pagamento] ${chargeId}: ${decisao.motivo} — obsoleto, ignorado`);
    return;
  }
  if (!mesmoStatus) {
    const gravou = await deps.aplicarTransicao(chargeId, { de: cobranca.status, para: novoStatus, ocorridoEm: carimbo, valorEstornado });
    if (!gravou) {
      /* Outro evento venceu a corrida entre a leitura e a escrita. LANÇA:
         a inbox marca `falhou`, relê a linha no reprocessamento e decide
         de novo — marcar "processado" aqui descartava o evento perdedor
         (um estorno que chegou junto com a confirmação, por exemplo). */
      throw new Error(`transição ${cobranca.status} → ${novoStatus} de ${chargeId} perdeu a corrida do UPDATE condicional; reprocessar`);
    }
    aplicada = true;
  }
  /* `mesmoStatus` NÃO devolve aqui de propósito: a notificação ainda é
     tentada com a chave do fato. Se a transição foi gravada numa
     tentativa anterior e a outbox falhou logo depois, é este caminho
     que recupera o aviso; se já foi enfileirada, a chave única faz o
     resto (revisão de 24/09/2026). */

  /* Estorno parcial que devolve TUDO: é estorno total, e o contratante
     precisa ouvir isso — mesmo que a Asaas tenha chamado de "parcial". */
  if (novoStatus === 'estornado_parcialmente' && valorEstornado !== null && emCentavos(valorEstornado) >= emCentavos(cobranca.valor_cobrado ?? 0) && emCentavos(cobranca.valor_cobrado ?? 0) > 0) {
    statusGravado = 'estornado';
    await deps.aplicarTransicao(chargeId, { de: 'estornado_parcialmente', para: 'estornado', ocorridoEm: carimbo, valorEstornado });
    aplicada = true;
  }

  /* A ASSINATURA nasce AQUI — no primeiro `confirmado` de uma cobrança de
     pop-up que ainda não tem `asaas_subscription_id`. Derivado da LINHA,
     não de "foi este evento que vinculou o charge": um `em_analise`
     que chegue antes vincula o charge e NÃO ativa nada, e o
     `PAYMENT_CONFIRMED` seguinte, achando a linha pelo charge, ativa.
     Antes, qualquer primeiro PAYMENT_* ativava a assinatura e cancelava
     a antiga (renovação) — inclusive um cartão RECUSADO. */
  /* "Primeira confirmação" é decidida pela AUSÊNCIA da linha em
     `assinaturas` (SEC-014, 25/09/2026), não por `asaas_subscription_id`
     já estar na cobrança. Antes, uma falha entre gravar esse vínculo e
     criar a linha (banco piscando) deixava a retentativa convencida de
     que já tinha amarrado: cobrança `confirmado`, `criada` enviado, e
     nenhuma assinatura aqui — cancelar/pausar/consultar respondendo 404
     enquanto a Asaas seguia cobrando. Toda escrita da amarração lança, e
     a inbox refaz; `upsert` e a checagem da antiga fazem a refeitura ser
     idempotente. */
  let primeiraConfirmacaoDaAssinatura = false;
  if (
    statusGravado === 'confirmado'
    && METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento)
    && payment?.subscription
  ) {
    const jaGravada = await deps.buscarAssinaturaPorId(payment.subscription);
    if (!jaGravada) {
      await amarrarAssinaturaACobranca(cobranca, payment, chargeId, deps);
      cobranca = { ...cobranca, asaas_subscription_id: payment.subscription };
      primeiraConfirmacaoDaAssinatura = true;
    } else if (refeituraDaAmarracao(jaGravada, deps.agora?.() ?? new Date())) {
      /* C1-03: a nova já está gravada — mas a refeitura que chega aqui
         pode ser a de uma passagem que morreu ENTRE gravar a nova e
         cancelar a antiga. Pular isto deixava as duas cobrando. O
         encerramento é idempotente (a antiga já cancelada não recebe
         outro DELETE), e só a linha da renovação tem a antiga.
         Só DENTRO da janela de refeitura (C2-L2): o `PAYMENT_RECEIVED` da
         liquidação, 30 dias depois, não é refeitura — e cancelaria uma
         antiga que um humano decidiu manter depois de o cancelamento
         automático falhar. */
      await encerrarAssinaturaSubstituida(cobranca, payment.subscription, deps);
    }
  }

  /* SEC-011: o PRIMEIRO ciclo de uma assinatura nova falhou (cartão
     recusado, vencido). A assinatura continua viva na Asaas — ela tenta
     o ciclo seguinte —, e o pagador que assinar de novo fica com DUAS.
     Nada aqui a cancela sozinho (o comportamento da Asaas depois da
     recusa ainda não foi medido); um humano é chamado. */
  if (
    ['recusado', 'vencido'].includes(statusGravado) && aplicada
    && METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento)
    && cobranca.asaas_checkout_id && payment?.subscription
    && !(await deps.buscarAssinaturaPorId(payment.subscription))
  ) {
    await deps.registrarErro(
      new Error(`o 1º ciclo da assinatura ${payment.subscription} ficou "${statusGravado}" (${chargeId}): ela continua ativa na Asaas e vai tentar de novo; se o pagador assinar outra vez, serão duas — cancelar esta na Asaas se não for mais valer`),
      { contexto: 'webhookController.primeiroCicloFalhou', rota: 'webhook/asaas', metodo: 'POST' }
    );
  }

  /* Estorno NEGADO (D-1): a operação que o registrou como pedido reabre, e
     a mesma chave pode pedir de novo. Também na reentrega — é idempotente. */
  if (statusGravado === 'estorno_negado' && cobranca.id) await deps.reabrirEstornosNegados(cobranca.id);

  /* CP1-I1/CP2-01: assinatura de sessão SUBSTITUÍDA que a Asaas liquidou
     mesmo assim — trocada por outro preço (`cancelado`, RN-70) ou por ter
     travado 65 min (`expirado`, a reserva abre outra). A de pedido vira duplicidade pelo pedido; a de
     assinatura não tem pedido — se a sessão que a substituiu também
     pagou, são duas assinaturas cobrando. Um humano confere. */
  if (aplicada && statusGravado === 'confirmado' && ['cancelado', 'expirado'].includes(cobranca.status) && METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento)) {
    await deps.registrarErro(
      new Error(`a sessão de assinatura ${cobranca.asaas_checkout_id ?? cobranca.id} tinha sido substituída e foi paga mesmo assim (${chargeId}): conferir se a que a substituiu também pagou — seriam duas assinaturas do mesmo plano cobrando`),
      { contexto: 'webhookController.assinaturaSubstituidaPaga', rota: 'webhook/asaas', metodo: 'POST' }
    );
  }

  const contexto = { chargeId, statusFinanceiro: statusGravado, valorEstornado: valorEstornado ?? cobranca.valor_estornado ?? null, ocorridoEm, aplicada };

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
    /* `criada` é a PRIMEIRA cobrança da assinatura confirmando — a linha
       da pop-up (tem `asaas_checkout_id`; os ciclos 2+ não têm). Também
       derivado da linha, para o reprocessamento chegar ao mesmo
       veredito que a primeira passagem (H-02). */
    const primeiraDaAssinatura = primeiraConfirmacaoDaAssinatura || Boolean(cobranca.asaas_checkout_id);
    const eventoAssinatura = primeiraDaAssinatura && statusGravado === 'confirmado'
      ? 'criada'
      : mapearEventoAssinatura(statusGravado);
    if (!eventoAssinatura) return;
    return notificarAssinatura(cobranca, {
      ...contexto,
      evento: eventoAssinatura,
      assinaturaId: cobranca.asaas_subscription_id ?? payment.subscription ?? null
    }, deps);
  }

  /* O PEDIDO FOI PAGO por esta cobrança (RN-51/RN-52, 25/09/2026). As
     irmãs ainda pagáveis — o Pix/boleto emitido antes, a pop-up aberta —
     viram obsoletas e o cancelador as invalida na Asaas; se outra irmã
     JÁ tinha liquidado, as duas ficam marcadas como duplicidade e o
     aviso ao contratante diz isso. Também na reentrega (`mesmoStatus`):
     é idempotente, e é o que recupera uma marcação que falhou depois de
     a transição ter sido gravada — o erro aqui LANÇA, e a inbox refaz. */
  if (statusGravado === 'confirmado' && cobranca.pedido_id) {
    const { duplicadoCom = [], obsoletas = 0 } = (await deps.aoLiquidarPedido(cobranca)) ?? {};
    if (duplicadoCom.length > 0) cobranca = { ...cobranca, pagamento_duplicado_com: duplicadoCom };
    if (obsoletas > 0) deps.dispararCancelador();
  }

  // Pix/Boleto/Cartão avulso — repassa TODA mudança de status.
  return notificarPedido(cobranca, contexto, deps);
}

/* ------------------------------------------------------------------
   Vínculo da primeira cobrança / ciclos / renovação
------------------------------------------------------------------ */

/** A refeitura da amarração só é refeitura enquanto a nova assinatura é
 *  recente e ainda está ativa aqui: 72 h cobre as tentativas da inbox
 *  (~42 h) e o reconciliador; depois disso, o evento é outro fato. */
const JANELA_DE_REFEITURA_MS = 72 * 60 * 60_000;
export function refeituraDaAmarracao(assinatura, agora = new Date()) {
  if (!assinatura || assinatura.status !== 'ativa') return false;
  const criada = Date.parse(assinatura.criado_em ?? '');
  return Number.isFinite(criada) && agora.getTime() - criada <= JANELA_DE_REFEITURA_MS;
}

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
  // Refeitura da amarração (SEC-014): a antiga já encerrada não é cancelada de novo.
  if ((await deps.buscarAssinaturaPorId(antigaId))?.status === 'cancelada') return;
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
    // sem `asaas_checkout_id`. Amarra sessão E charge pela LINHA (o
    // `where asaas_checkout_id` não casaria — ele é nulo aqui).
    cobranca = await deps.buscarCobrancaPorReferenciaExterna(payment.externalReference);
    if (cobranca && !cobranca.asaas_checkout_id) {
      if (cobranca.charge_id) return null; // reserva já completada por outro caminho
      const vinculou = await deps.vincularSessaoAReserva(cobranca.id, { asaasCheckoutId, chargeId: payment.id });
      if (!vinculou) throw new Error(`a reserva ${cobranca.id} foi amarrada por outro caminho enquanto o evento de ${payment.id} a lia; reprocessar`);
      return { ...cobranca, asaas_checkout_id: asaasCheckoutId, charge_id: payment.id };
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

  const vinculou = await deps.vincularChargeIdAoCheckout(asaasCheckoutId, payment.id);
  if (!vinculou) throw new Error(`a sessão ${asaasCheckoutId} ganhou outro charge_id enquanto o evento de ${payment.id} a lia; reprocessar`);
  /* O id da ASSINATURA fica gravado já no primeiro evento (SEC-011),
     qualquer que seja o status: um primeiro ciclo recusado deixava a
     assinatura viva na Asaas sem nenhuma linha daqui apontando para ela,
     e o ciclo seguinte chegava como "assinatura desconhecida". Quem
     decide se a assinatura NASCEU continua sendo o primeiro `confirmado`
     (a linha em `assinaturas`). */
  if (payment.subscription && METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento) && !cobranca.asaas_subscription_id) {
    await deps.atualizarSubscriptionIdDaCobranca(payment.id, payment.subscription);
    return { ...cobranca, charge_id: payment.id, asaas_subscription_id: payment.subscription };
  }
  return { ...cobranca, charge_id: payment.id };
}

async function registrarNovoCicloAssinatura(payment, deps = dependenciasPadrao) {
  const subscriptionId = payment.subscription;
  const modelo = await deps.buscarCobrancaPorSubscriptionId(subscriptionId);
  if (!modelo) {
    /* Pagamento de assinatura DESTA conta (a Asaas confirmou que existe)
       sem nenhuma cobrança nossa apontando para ela: dinheiro sem dono.
       Era só log (SEC-011); agora é `erros`, para alguém decidir. */
    await deps.registrarErro(
      new Error(`cobrança ${payment.id} da assinatura ${subscriptionId} chegou sem cobrança-modelo local — assinatura criada fora deste checkout, ou a 1ª cobrança dela nunca foi vista; conferir na Asaas`),
      { contexto: 'webhookController.assinaturaDesconhecida', rota: 'webhook/asaas', metodo: 'POST' }
    );
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
    // A reserva cuja sessão nasceu mas a resposta se perdeu (C-04/H-06):
    // amarra pela LINHA — `asaas_checkout_id` é nulo, um update por ele
    // não casaria nada (revisão de 24/09/2026).
    cobranca = await deps.buscarCobrancaPorReferenciaExterna(corpo.checkout.externalReference);
    if (cobranca && !cobranca.asaas_checkout_id) {
      const vinculou = await deps.vincularSessaoAReserva(cobranca.id, { asaasCheckoutId });
      if (!vinculou) throw new Error(`a reserva ${cobranca.id} foi amarrada a outra sessão enquanto o evento de ${asaasCheckoutId} a lia; reprocessar`);
      cobranca = { ...cobranca, asaas_checkout_id: asaasCheckoutId };
    }
  }
  if (!cobranca) return;

  /* `CHECKOUT_PAID` NÃO É DINHEIRO (primeiro pagamento real, 25/09/2026).
     Ele diz que o pagador CONCLUIU a sessão hospedada — cartão digitado,
     assinatura criada. Até aqui ele virava `confirmado`, e naquele dia a
     tela mostrou "Assinatura Ativa ✓" com a primeira cobrança `PENDING`
     na Asaas e o cartão sem débito nenhum. Quem confirma dinheiro é
     `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` (`processarEventoPayment`).
     Aqui só se carimba a sessão: a linha segue `pendente`, e a tela
     passa a dizer "processando" (`consultarStatusCheckout`). Nenhum aviso
     sai daqui — nunca saiu. */
  if (evento === 'CHECKOUT_PAID') {
    /* Só o carimbo. O `charge_id` NÃO é amarrado daqui (25/09/2026): o
       `CHECKOUT_PAID` real não traz pagamento nenhum (medido em 15/09 e em
       25/09), e um id tirado do CORPO de um evento que não se confere na
       Asaas (não há `GET` de sessão documentado) só podia vir de um
       evento forjado — amarrando um pagamento alheio a esta sessão. Quem
       amarra é o `PAYMENT_*`, conferido (RN-56). */
    await deps.marcarSessaoConcluida(asaasCheckoutId, ocorridoEm);
    return;
  }

  /* Sessão já concluída não expira nem é cancelada: um `CHECKOUT_EXPIRED`
     atrasado sobre ela é ruído, e marcá-la `expirado` soltaria a reserva
     para uma SEGUNDA sessão/assinatura enquanto a primeira ainda vai ser
     cobrada. */
  if (cobranca.sessao_concluida_em) {
    console.log(`[webhook/sessao] ${asaasCheckoutId}: ${evento} depois de CHECKOUT_PAID — ignorado`);
    return;
  }

  const STATUS_DA_SESSAO = { CHECKOUT_CANCELED: 'cancelado', CHECKOUT_EXPIRED: 'expirado' };
  const novoStatus = STATUS_DA_SESSAO[evento];
  if (!novoStatus) return;

  /* A mesma máquina de estados dos eventos de pagamento (C-03): um
     `CHECKOUT_PAID` reprocessado depois de um estorno não regride a
     linha, e um `CHECKOUT_EXPIRED` atrasado não apaga uma confirmação. */
  const decisao = decidirTransicao(cobranca, novoStatus, ocorridoEm);
  if (decisao.acao === 'ignorar') {
    if (cobranca.status !== novoStatus) console.log(`[webhook/sessao] ${asaasCheckoutId}: ${decisao.motivo} — ignorado`);
    return;
  }
  const gravou = await deps.aplicarTransicaoPorCheckoutId(asaasCheckoutId, { de: cobranca.status, para: novoStatus, ocorridoEm });
  if (!gravou) throw new Error(`transição ${cobranca.status} → ${novoStatus} da sessão ${asaasCheckoutId} perdeu a corrida; reprocessar`);

  if (evento === 'CHECKOUT_CANCELED') {
    // Renovação abandonada NÃO é a assinatura sendo cancelada (RN-20).
    if (cobranca.substitui_assinatura_id) return;
    if (METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento)) {
      return notificarAssinatura(cobranca, { evento: 'cancelada', assinaturaId: cobranca.asaas_subscription_id ?? null, chargeId: cobranca.charge_id ?? null, statusFinanceiro: 'cancelado', ocorridoEm, aplicada: true }, deps);
    }
    // pedido avulso: tentativa abandonada não tem status no vocabulário de pedido
  }
  // CHECKOUT_EXPIRED: sem notificação (API.md §4.3.5) — a pop-up expirada é
  // ausência de pagamento, não um fato sobre uma cobrança que existiu.
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
    cotacaoId: cobranca.cotacao_id ?? null,
    /* RN-52: outra cobrança DESTE pedido também liquidou. Os dois
       pagamentos são reais; um precisa ser estornado (API.md §4.3.2). */
    pagamentoDuplicado: Array.isArray(cobranca.pagamento_duplicado_com) && cobranca.pagamento_duplicado_com.length > 0,
    duplicadoCom: Array.isArray(cobranca.pagamento_duplicado_com) ? cobranca.pagamento_duplicado_com : []
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
function chaveDoFato({ tipo, evento, chargeId, assinaturaId, statusFinanceiro, valorEstornado, cobranca }) {
  /* Cada estorno PARCIAL é um fato próprio — dois parciais sobre a mesma
     cobrança têm acumulados diferentes, e o segundo não pode cair na
     linha do primeiro (que já foi entregue). */
  const sufixoParcial = statusFinanceiro === 'estornado_parcialmente' ? `|${emCentavos(valorEstornado) ?? 0}` : '';
  if (tipo === 'pedido') return `pedido|${chargeId}|${statusFinanceiro}${sufixoParcial}`;
  const referencia = chargeId ?? assinaturaId ?? cobranca?.asaas_checkout_id ?? cobranca?.id;
  return `assinatura|${referencia}|${evento}${statusFinanceiro ? `|${statusFinanceiro}` : ''}${sufixoParcial}`;
}

async function notificarPedido(cobranca, { chargeId, statusFinanceiro, valorEstornado, ocorridoEm, aplicada = false }, deps) {
  const contratante = contratanteDaCobranca(cobranca);
  if (!contratante.webhook_url) return;
  return deps.notificar({
    contratante,
    tipo: 'pedido',
    evento: statusFinanceiro,
    chave: chaveDoFato({ tipo: 'pedido', chargeId, statusFinanceiro, valorEstornado }),
    payload: montarPayloadConfirmacaoPedido(cobranca, chargeId, statusFinanceiro, { valorEstornado }),
    ocorridoEm,
    aplicada
  });
}

/**
 * Um fato sobre um PEDIDO produzido por NÓS, fora do webhook — hoje, o
 * estorno pedido em `POST /estornar`. Mesma chave do fato: quando o
 * `PAYMENT_REFUNDED` da Asaas chegar, cai na mesma linha da outbox e
 * não avisa duas vezes. Antes, o §5.4 do API.md prometia esse webhook e
 * ele nunca saía (revisão de 24/09/2026).
 */
export async function notificarFatoDePedido(contratante, cobranca, { chargeId, statusFinanceiro, valorEstornado = null }, deps = dependenciasPadrao) {
  if (!contratante?.webhook_url) return;
  return deps.notificar({
    contratante,
    tipo: 'pedido',
    evento: statusFinanceiro,
    chave: chaveDoFato({ tipo: 'pedido', chargeId, statusFinanceiro, valorEstornado }),
    payload: montarPayloadConfirmacaoPedido(cobranca, chargeId, statusFinanceiro, { valorEstornado }),
    ocorridoEm: new Date().toISOString(),
    aplicada: false
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
    ocorridoEm: dados.ocorridoEm,
    aplicada: Boolean(dados.aplicada)
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
  function rodarGuarda({ token, header, ip = '52.67.12.206' }) {
    if (token === undefined) delete process.env.ASAAS_WEBHOOK_TOKEN;
    else process.env.ASAAS_WEBHOOK_TOKEN = token;
    const req = { ip, get: (nome) => (nome === 'asaas-access-token' ? header : undefined) };
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
  // SEC-007: a lista oficial de IPs — observa por padrão, recusa só com a chave ligada
  for (const oficial of IPS_OFICIAIS_DA_ASAAS) assert.ok(origemOficialDaAsaas(oficial), `IP oficial ${oficial} reconhecido`);
  assert.ok(origemOficialDaAsaas('::ffff:52.67.12.206'), 'o mesmo IP na forma IPv4-mapeada do socket');
  for (const outro of ['203.0.113.7', '52.67.12.20', '52.67.12.2060', '', null, undefined]) assert.ok(!origemOficialDaAsaas(outro), `origem ${outro} não é da Asaas`);
  const estritoOriginal = process.env.ASAAS_WEBHOOK_IP_ESTRITO;
  const errosAntes = console.error;
  console.error = () => {};
  try {
    delete process.env.ASAAS_WEBHOOK_IP_ESTRITO;
    r = rodarGuarda({ token: 'segredo-certo', header: 'segredo-certo', ip: '203.0.113.7' });
    assert.equal(r.chamouProximo, true, 'IP fora da lista, modo observação: passa (e fica em erros) — a origem real ainda não foi medida');
    process.env.ASAAS_WEBHOOK_IP_ESTRITO = '1';
    r = rodarGuarda({ token: 'segredo-certo', header: 'segredo-certo', ip: '203.0.113.7' });
    assert.equal(r.status, 403, 'modo estrito: token certo de IP fora da lista é recusado');
    assert.equal(r.chamouProximo, false);
    r = rodarGuarda({ token: 'segredo-certo', header: 'segredo-certo', ip: '18.230.8.159' });
    assert.equal(r.chamouProximo, true, 'modo estrito: IP oficial com token certo passa (controle positivo)');
    process.env.ASAAS_WEBHOOK_IPS = '198.51.100.9';
    assert.ok(origemOficialDaAsaas('198.51.100.9') && !origemOficialDaAsaas('52.67.12.206'), 'ASAAS_WEBHOOK_IPS substitui a lista sem deploy');
    delete process.env.ASAAS_WEBHOOK_IPS;
    await new Promise((fim) => setTimeout(fim, 100)); // o registro em `erros` do modo observação termina (sem banco aqui) antes de o log voltar
  } finally {
    console.error = errosAntes;
    if (estritoOriginal === undefined) delete process.env.ASAAS_WEBHOOK_IP_ESTRITO; else process.env.ASAAS_WEBHOOK_IP_ESTRITO = estritoOriginal;
  }
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
  const STATUS_ASAAS_QUE_O_ALVO_IMPLICA = {
    confirmado: 'RECEIVED', estornado: 'REFUNDED', estornado_parcialmente: 'RECEIVED', estorno_solicitado: 'REFUND_IN_PROGRESS',
    estorno_negado: 'RECEIVED', vencido: 'OVERDUE', em_analise: 'AWAITING_RISK_ANALYSIS', recusado: 'PENDING',
    chargeback: 'CHARGEBACK_REQUESTED', pendente: 'PENDING'
  };
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
    /* A ASAAS HONESTA por padrão (SEC-007): a cobrança existe, e o status
       dela é o que o evento implica — ou o que o cenário diz
       (`statusNaAsaas`), quando a verdade não é o evento (evento
       atrasado, forjado, fora de ordem). O corpo do evento dá os campos
       de vínculo; `naAsaas` sobrescreve qualquer um deles. */
    if (!('estadoNaAsaas' in retornos)) {
      deps.estadoNaAsaas = async (chargeId, { alvo, payment } = {}) => {
        chamadas.push({ nome: 'estadoNaAsaas', args: [chargeId, alvo] });
        const status = retornos.statusNaAsaas ?? STATUS_ASAAS_QUE_O_ALVO_IMPLICA[alvo] ?? 'PENDING';
        const pagamento = {
          id: chargeId, status, value: payment?.value ?? null, deleted: false,
          externalReference: payment?.externalReference ?? null, checkoutSession: payment?.checkoutSession ?? null,
          subscription: payment?.subscription ?? null, installment: payment?.installment ?? null,
          refunds: payment?.refunds ?? null, ...(retornos.naAsaas ?? {})
        };
        const valorEstornado = valorEstornadoDoPayment(pagamento);
        return { existe: true, pagamento, estado: estadoLocalDaAsaas(pagamento, valorEstornado), valorEstornado };
      };
    }
    if (!('aplicarTransicaoPorCheckoutId' in retornos)) deps.aplicarTransicaoPorCheckoutId = async (...args) => { chamadas.push({ nome: 'aplicarTransicaoPorCheckoutId', args }); return true; };
    // o vínculo da reserva é CAS desde 25/09: por padrão, a escrita venceu
    if (!('vincularSessaoAReserva' in retornos)) deps.vincularSessaoAReserva = async (...args) => { chamadas.push({ nome: 'vincularSessaoAReserva', args }); return true; };
    if (!('vincularChargeIdAoCheckout' in retornos)) deps.vincularChargeIdAoCheckout = async (...args) => { chamadas.push({ nome: 'vincularChargeIdAoCheckout', args }); return true; };
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
  let n = deps.notificados();
  assert.equal(n.length, 1, 'mas AINDA tenta enfileirar com a chave do fato — é o que recupera um aviso perdido depois da transição gravada');
  assert.equal(n[0].aplicada, false, 'sem transição aplicada: a chave do fato, que já existe, não vira segunda linha');
  assert.equal(n[0].chave, 'pedido|pay_1|confirmado');

  // 2. caminho feliz do Pix: grava por CAS e enfileira com a chave do fato
  deps = depsFalsas({ buscarCobranca: cobrancaPix });
  await processarWebhook({ id: 'evt_1', event: 'PAYMENT_CONFIRMED', dateCreated: '2026-09-24 10:00:00', payment: { id: 'pay_1' } }, deps);
  assert.equal(deps.chamou('aplicarTransicao')[0].args[0], 'pay_1');
  assert.deepEqual(deps.chamou('aplicarTransicao')[0].args[1].de, 'pendente');
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].para, 'confirmado');
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].ocorridoEm, '2026-09-24T13:00:00.000Z', 'o carimbo do evento vai para a linha');
  n = deps.notificados();
  assert.equal(n.length, 1, 'primeira vez notifica o contratante');
  assert.equal(n[0].aplicada, true, 'transição aplicada agora: um fato repetido de verdade ganha linha nova');
  assert.equal(n[0].contratante.webhook_url, contratante.webhook_url);
  assert.equal(n[0].chave, 'pedido|pay_1|confirmado', 'a chave de idempotência é o fato');
  assert.equal(n[0].payload.status, 'confirmado');
  assert.equal(n[0].payload.versao, 2);

  // 3. C-03: CONFIRMED atrasado depois de REFUNDED não regride
  // A Asaas diz REFUNDED (é a verdade de hoje); o CONFIRMED é o passado chegando atrasado.
  deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'estornado', status_evento_em: '2026-09-24T12:00:00Z' }, statusNaAsaas: 'REFUNDED' });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', dateCreated: '2026-09-24 08:00:00', payment: { id: 'pay_1' } }, deps);
  assert.equal(deps.chamou('aplicarTransicao').length, 0, 'C-03: estornado não volta a confirmado');
  assert.equal(deps.notificados().length, 0, 'e o contratante não recebe um "confirmado" falso');
  deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'chargeback' }, statusNaAsaas: 'CHARGEBACK_REQUESTED' });
  await processarWebhook({ event: 'PAYMENT_RECEIVED_IN_CASH_UNDONE', payment: { id: 'pay_1' } }, deps);
  assert.equal(deps.chamou('aplicarTransicao').length, 0, 'C-03: chargeback não vira pendente');
  // CASH_UNDONE mais antigo que o CONFIRMED gravado também não
  deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'confirmado', status_evento_em: '2026-09-24T12:00:00Z' }, statusNaAsaas: 'RECEIVED' });
  await processarWebhook({ event: 'PAYMENT_RECEIVED_IN_CASH_UNDONE', dateCreated: '2026-09-24T11:00:00Z', payment: { id: 'pay_1' } }, deps);
  assert.equal(deps.chamou('aplicarTransicao').length, 0, 'C-03: evento mais antigo que o status gravado não regride');
  // mas a sequência legítima confirmado → estornado passa e notifica
  deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'confirmado' } });
  await processarWebhook({ event: 'PAYMENT_REFUNDED', payment: { id: 'pay_1', refunds: [{ status: 'DONE', value: 99 }] } }, deps);
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].para, 'estornado');
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].valorEstornado, 99);
  assert.equal(deps.notificados()[0].payload.status, 'estornado');
  assert.equal(deps.notificados()[0].payload.valorEstornado, 99);
  // e a corrida perdida no CAS LANÇA (a inbox reprocessa depois de reler) — nunca notifica
  deps = depsFalsas({ buscarCobranca: cobrancaPix, aplicarTransicao: () => false });
  await assert.rejects(() => processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } }, deps), /perdeu a corrida/);
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
  // parcial sem lista no CORPO: o valor vem da ASAAS (SEC-007), nunca inventado
  deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'confirmado', valor_cobrado: 100 }, naAsaas: { refunds: [{ status: 'DONE', value: 30 }] } });
  await processarWebhook({ event: 'PAYMENT_PARTIALLY_REFUNDED', payment: { id: 'pay_1' } }, deps);
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].valorEstornado, 30, 'sem refunds no payload, o valor estornado é o que a Asaas lista');
  // e sem estorno NENHUM na Asaas, o "parcial" não tem respaldo: lança, nada gravado
  deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'confirmado', valor_cobrado: 100 } });
  await assert.rejects(
    () => processarWebhook({ event: 'PAYMENT_PARTIALLY_REFUNDED', payment: { id: 'pay_1' } }, deps),
    /sem respaldo na Asaas/, 'estorno parcial sem estorno na Asaas é recusado (a inbox tenta de novo; forjado esgota em erros)'
  );
  assert.equal(deps.chamou('aplicarTransicao').length, 0, 'e nada foi gravado');
  // SEGUNDO parcial: mesmo status, acumulado maior — grava e notifica com chave própria
  deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'estornado_parcialmente', valor_cobrado: 100, valor_estornado: 30 } });
  await processarWebhook({ event: 'PAYMENT_PARTIALLY_REFUNDED', payment: { id: 'pay_1', refunds: [{ status: 'DONE', value: 30 }, { status: 'DONE', value: 20 }] } }, deps);
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].valorEstornado, 50, 'segundo parcial avança o acumulado');
  n = deps.notificados();
  assert.equal(n.length, 1);
  assert.equal(n[0].chave, 'pedido|pay_1|estornado_parcialmente|5000', 'cada parcial é um fato próprio — chave leva o acumulado em centavos');
  // ...mas a REENTREGA do mesmo parcial (acumulado igual) é ignorada
  deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'estornado_parcialmente', valor_cobrado: 100, valor_estornado: 30 } });
  await processarWebhook({ event: 'PAYMENT_PARTIALLY_REFUNDED', payment: { id: 'pay_1', refunds: [{ status: 'DONE', value: 30 }] } }, deps);
  assert.equal(deps.chamou('aplicarTransicao').length, 0, 'reentrega do mesmo parcial não grava');
  assert.equal(deps.notificados()[0].aplicada, false, 'e só reencosta na chave do fato (acumulado igual → mesma linha da outbox)');
  assert.equal(deps.notificados()[0].chave, 'pedido|pay_1|estornado_parcialmente|3000');

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
  // A assinatura JÁ nasceu (linha em `assinaturas`): o ciclo 2 é renovação, não `criada` (SEC-014).
  const assinaturaExistente = { id: 'sub_1', status: 'ativa', plano_id: 'plano_1', ciclo: 'QUARTERLY' };
  deps = depsFalsas({
    buscarCobranca: () => (cicloRegistrado ? { ...modeloAssinatura, charge_id: 'pay_ciclo2', status: 'pendente' } : null),
    buscarCobrancaPorSubscriptionId: modeloAssinatura,
    buscarAssinaturaPorId: assinaturaExistente,
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
    buscarAssinaturaPorId: assinaturaExistente,
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
  assert.deepEqual(deps.chamou('avancarIntencaoDeTrocaPorChargeId')[0].args, ['pay_acerto_1', 'PAYMENT_CONFIRMED', 'RECEIVED', null], 'o acerto é classificado com o status DA ASAAS junto (SEC-007)');
  deps = depsFalsas({ buscarCobranca: null, avancarIntencaoDeTrocaPorChargeId: true, naAsaas: { externalReference: 'troca:11111111-1111-4111-8111-111111111111' } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_acerto_orfao', externalReference: 'troca:22222222-2222-4222-8222-222222222222' } }, deps);
  assert.equal(deps.chamou('avancarIntencaoDeTrocaPorChargeId')[0].args[3], 'troca:11111111-1111-4111-8111-111111111111', 'SEC-009: a referência que acha a intenção órfã é a DA ASAAS, não a do corpo');
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
  assert.equal(deps.chamou('aplicarTransicaoPorCheckoutId').length, 0, 'CHECKOUT_PAID NÃO muda status: sessão concluída não é dinheiro (25/09/2026)');
  assert.deepEqual(deps.chamou('marcarSessaoConcluida')[0].args, ['chk_real', null], 'só carimba a sessão — é o que a tela lê como "processando"');
  assert.equal(deps.notificados().length, 0, 'CHECKOUT_PAID não avisa nada: não tem chargeId nem subscription');
  // reprocessamento de um CHECKOUT_PAID sobre uma linha já estornada: nada muda de status
  deps = depsFalsas({ buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, status: 'estornado' } });
  await processarWebhook({ event: 'CHECKOUT_PAID', checkout: { id: 'chk_real', status: 'PAID' } }, deps);
  assert.equal(deps.chamou('aplicarTransicaoPorCheckoutId').length, 0, 'C-03 vale para a sessão também: estornado não volta a confirmado');
  deps = depsFalsas({ buscarCobranca: null, buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, sessao_concluida_em: '2026-09-25T01:26:34Z' } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_real', subscription: 'sub_real', checkoutSession: 'chk_real' } }, deps);
  assert.deepEqual(deps.chamou('vincularChargeIdAoCheckout')[0].args, ['chk_real', 'pay_real'], 'o charge_id é gravado aqui (bug de 15/09)');
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].para, 'confirmado', 'é o PAGAMENTO que leva a linha a confirmado — e grava confirmado_em no dia do dinheiro');
  assert.deepEqual(deps.chamou('atualizarSubscriptionIdDaCobranca')[0].args, ['pay_real', 'sub_real']);
  assert.equal(deps.chamou('upsertAssinatura')[0].args[0].ciclo, 'QUARTERLY', 'ciclo vem de cobranca.ciclo');
  n = deps.notificados();
  assert.equal(n.length, 1, 'e é AQUI que `criada` sai');
  assert.equal(n[0].payload.evento, 'criada');
  assert.equal(n[0].payload.chargeId, 'pay_real', 'H-02: criada carrega chargeId');
  assert.equal(n[0].payload.assinaturaId, 'sub_real', 'H-02: e assinaturaId');
  assert.equal(n[0].payload.valor, 267.3);
  assert.equal(n[0].chave, 'assinatura|pay_real|criada|confirmado');
  assert.equal(n[0].aplicada, true);
  // linha LEGADA (gravada confirmado pelo CHECKOUT_PAID antigo): o PAYMENT_CONFIRMED ainda amarra e avisa
  deps = depsFalsas({ buscarCobranca: null, buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, status: 'confirmado' } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_real', subscription: 'sub_real', checkoutSession: 'chk_real' } }, deps);
  assert.equal(deps.chamou('upsertAssinatura').length, 1, 'legado: a assinatura nasce do mesmo jeito');
  assert.equal(deps.notificados()[0].payload.evento, 'criada');
  // pagamento chegando ANTES do CHECKOUT_PAID: vincula e grava a transição
  deps = depsFalsas({ buscarCobranca: null, buscarCobrancaPorCheckoutId: cobrancaAssinaturaCrua });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_antes', subscription: 'sub_antes', checkoutSession: 'chk_real' } }, deps);
  assert.equal(deps.chamou('vincularChargeIdAoCheckout').length, 1);
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].para, 'confirmado', 'com a sessão ainda pendente, a transição é gravada');
  assert.equal(deps.notificados()[0].payload.evento, 'criada');
  // segundo PAYMENT_CONFIRMED (reentrega já processada) sobre a mesma sessão: não amarra de novo,
  // e o `criada` sai com a MESMA chave (que já existe na outbox → nada é enviado)
  deps = depsFalsas({ buscarCobranca: { ...cobrancaAssinaturaCrua, charge_id: 'pay_real', status: 'confirmado', asaas_subscription_id: 'sub_real' }, buscarAssinaturaPorId: { id: 'sub_real', status: 'ativa' } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_real', subscription: 'sub_real', checkoutSession: 'chk_real' } }, deps);
  assert.equal(deps.chamou('upsertAssinatura').length, 0, 'reentrega: a assinatura (que JÁ existe) não é amarrada de novo');
  assert.equal(deps.chamou('cancelarAssinaturaNaAsaas').length, 0);
  n = deps.notificados();
  assert.equal(n[0].payload.evento, 'criada', 'derivado da LINHA (tem asaas_checkout_id): o reprocessamento chega ao mesmo veredito');
  assert.equal(n[0].chave, 'assinatura|pay_real|criada|confirmado');
  assert.equal(n[0].aplicada, false);
  // SEC-014: a MESMA reentrega, com a amarração que ficou PELA METADE (vínculo gravado, linha em
  // `assinaturas` não) — a refeitura completa, em vez de se convencer de que já tinha amarrado
  deps = depsFalsas({ buscarCobranca: { ...cobrancaAssinaturaCrua, charge_id: 'pay_real', status: 'confirmado', asaas_subscription_id: 'sub_real' } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_real', subscription: 'sub_real', checkoutSession: 'chk_real' } }, deps);
  assert.equal(deps.chamou('upsertAssinatura').length, 1, 'SEC-014: sem linha em `assinaturas`, a reentrega AMARRA — era 404 no cancelar enquanto a Asaas cobrava');
  assert.equal(deps.chamou('upsertAssinatura')[0].args[0].id, 'sub_real');
  // e uma falha na amarração LANÇA (a inbox refaz) — antes era só log, e a linha ficava `processado`
  deps = depsFalsas({ buscarCobranca: { ...cobrancaAssinaturaCrua, charge_id: 'pay_real', status: 'confirmado', asaas_subscription_id: 'sub_real' }, upsertAssinatura: () => { throw new Error('banco piscou'); } });
  await assert.rejects(processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_real', subscription: 'sub_real', checkoutSession: 'chk_real' } }, deps), /banco piscou/, 'SEC-014: a falha da amarração sobe para a inbox refazer');
  // a antiga de uma renovação JÁ cancelada não é cancelada de novo na refeitura
  deps = depsFalsas({
    buscarCobranca: { ...cobrancaAssinaturaCrua, charge_id: 'pay_real', status: 'confirmado', asaas_subscription_id: 'sub_real', substitui_assinatura_id: 'sub_velha' },
    buscarAssinaturaPorId: (id) => (id === 'sub_velha' ? { id, status: 'cancelada' } : null)
  });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_real', subscription: 'sub_real', checkoutSession: 'chk_real' } }, deps);
  assert.equal(deps.chamou('cancelarAssinaturaNaAsaas').length, 0, 'refeitura: a assinatura antiga que já está cancelada não recebe um segundo DELETE');
  // CP1-I1: assinatura de sessão substituída e paga chama um humano (duas assinaturas?)
  deps = depsFalsas({ buscarCobranca: { ...cobrancaAssinaturaCrua, charge_id: 'pay_sub', status: 'cancelado', asaas_subscription_id: null } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_sub', subscription: 'sub_x', checkoutSession: 'chk_real' } }, deps);
  assert.ok(deps.chamou('registrarErro').some((c) => /substituída e foi paga/.test(c.args[0].message)), 'CP1-I1: a assinatura substituída que pagou chama um humano');
  // CP2-01: a sessão substituída por TRAVADA (65 min, vira `expirado`) e paga depois também chama um humano
  deps = depsFalsas({ buscarCobranca: { ...cobrancaAssinaturaCrua, charge_id: 'pay_sub_exp', status: 'expirado', asaas_subscription_id: null } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_sub_exp', subscription: 'sub_y', checkoutSession: 'chk_real' } }, deps);
  assert.ok(deps.chamou('registrarErro').some((c) => /substituída e foi paga/.test(c.args[0].message)), 'CP2-01: a assinatura expirada/substituída que pagou chama um humano');
  // C1-03: a refeitura depois de a NOVA já estar gravada (crash ou falha entre o upsert e
  // o cancelamento da antiga) ainda cancela a antiga — o portão "a nova não existe" pulava
  // tudo, e o pagador ficava com as duas assinaturas cobrando.
  deps = depsFalsas({
    buscarCobranca: { ...cobrancaAssinaturaCrua, charge_id: 'pay_real', status: 'confirmado', asaas_subscription_id: 'sub_real', substitui_assinatura_id: 'sub_velha' },
    buscarAssinaturaPorId: (id) => ({ id, status: 'ativa', criado_em: new Date(Date.now() - 3600_000).toISOString() })
  });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_real', subscription: 'sub_real', checkoutSession: 'chk_real' } }, deps);
  assert.deepEqual(deps.chamou('cancelarAssinaturaNaAsaas').map((c) => c.args[0]), ['sub_velha'], 'C1-03: a refeitura com a nova já gravada cancela a antiga que ainda está ativa');
  assert.equal(deps.chamou('upsertAssinatura').length, 0, 'e não reescreve a nova, que já existe');
  // C2-L2: a liquidação 30 dias depois NÃO é refeitura — a antiga que um humano manteve fica
  deps = depsFalsas({
    buscarCobranca: { ...cobrancaAssinaturaCrua, charge_id: 'pay_real', status: 'confirmado', asaas_subscription_id: 'sub_real', substitui_assinatura_id: 'sub_velha' },
    buscarAssinaturaPorId: (id) => ({ id, status: 'ativa', criado_em: new Date(Date.now() - 30 * 86_400_000).toISOString() })
  });
  await processarWebhook({ event: 'PAYMENT_RECEIVED', payment: { id: 'pay_real', subscription: 'sub_real', checkoutSession: 'chk_real' } }, deps);
  assert.equal(deps.chamou('cancelarAssinaturaNaAsaas').length, 0, 'C2-L2: o evento de 30 dias depois não cancela a antiga');
  assert.equal(refeituraDaAmarracao({ status: 'cancelada', criado_em: new Date().toISOString() }), false, 'C2-L2: nova já cancelada aqui não autoriza encerrar a antiga');
  // um evento NÃO-confirmado chegando primeiro vincula o charge, mas NÃO ativa nem cancela nada
  deps = depsFalsas({ buscarCobranca: null, buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, substitui_assinatura_id: 'sub_antiga' } });
  await processarWebhook({ event: 'PAYMENT_AWAITING_RISK_ANALYSIS', payment: { id: 'pay_risco', subscription: 'sub_nova', checkoutSession: 'chk_real' } }, deps);
  assert.deepEqual(deps.chamou('vincularChargeIdAoCheckout')[0].args, ['chk_real', 'pay_risco'], 'o charge é vinculado');
  assert.equal(deps.chamou('upsertAssinatura').length, 0, 'em_analise NÃO ativa a assinatura');
  assert.equal(deps.chamou('cancelarAssinaturaNaAsaas').length, 0, 'e NÃO cancela a antiga (renovação recusada deixava o pagador sem nenhuma)');
  assert.equal(deps.notificados().length, 0, 'em_analise não tem evento de assinatura');
  // ...e o PAYMENT_CONFIRMED seguinte, achando a linha pelo charge, é quem ativa e cancela a antiga
  deps = depsFalsas({ buscarCobranca: { ...cobrancaAssinaturaCrua, charge_id: 'pay_risco', status: 'em_analise', substitui_assinatura_id: 'sub_antiga' } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_risco', subscription: 'sub_nova', checkoutSession: 'chk_real' } }, deps);
  assert.equal(deps.chamou('upsertAssinatura')[0].args[0].id, 'sub_nova', 'agora sim: a assinatura nasce no confirmado');
  assert.deepEqual(deps.chamou('cancelarAssinaturaNaAsaas')[0].args, ['sub_antiga']);
  assert.equal(deps.notificados()[0].payload.evento, 'criada');
  // ciclo 2 com checkoutSession: não sobrescreve o vínculo da primeira
  const cicloNovo = { ...cobrancaAssinaturaCrua, charge_id: 'pay_ciclo2', status: 'pendente', asaas_subscription_id: 'sub_real', asaas_checkout_id: null };
  let leituras = 0;
  deps = depsFalsas({
    buscarCobranca: () => (leituras++ === 0 ? null : cicloNovo),
    buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, charge_id: 'pay_real', status: 'confirmado' },
    buscarCobrancaPorSubscriptionId: { ...cobrancaAssinaturaCrua, charge_id: 'pay_real' },
    buscarAssinaturaPorId: { id: 'sub_real', status: 'ativa' }, // a assinatura já nasceu no 1º ciclo
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
  assert.deepEqual(deps.chamou('vincularSessaoAReserva')[0].args, ['abc', { asaasCheckoutId: 'chk_perdido' }], 'a sessão é amarrada pela LINHA (asaas_checkout_id é nulo — um update por ele não casaria)');
  assert.deepEqual(deps.chamou('marcarSessaoConcluida')[0].args, ['chk_perdido', null], 'e a reserva perdida fica com a sessão concluída — sem virar confirmado');
  assert.equal(deps.chamou('aplicarTransicaoPorCheckoutId').length, 0);
  // PAYMENT_CONFIRMED citando a sessão perdida: amarra sessão E charge pela linha, e avisa
  deps = depsFalsas({
    buscarCobranca: null, buscarCobrancaPorCheckoutId: null,
    buscarCobrancaPorReferenciaExterna: (ref) => (ref === 'reserva-abc' ? { ...cobrancaCartaoCrua, asaas_checkout_id: null, id: 'abc' } : null)
  });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_perdido', checkoutSession: 'chk_perdido', externalReference: 'reserva-abc' } }, deps);
  assert.deepEqual(deps.chamou('vincularSessaoAReserva')[0].args, ['abc', { asaasCheckoutId: 'chk_perdido', chargeId: 'pay_perdido' }]);
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].para, 'confirmado');
  assert.equal(deps.notificados()[0].payload.chargeId, 'pay_perdido', 'o pagamento de uma sessão perdida chega ao contratante');
  // Pix/Boleto direto cuja resposta do POST /v3/payments se perdeu: a reserva é achada pela referência
  deps = depsFalsas({
    buscarCobranca: null,
    buscarCobrancaPorReferenciaExterna: (ref) => (ref === 'reserva-pix1' ? { ...cobrancaPix, charge_id: null, id: 'pix1' } : null)
  });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_pix_perdido', externalReference: 'reserva-pix1' } }, deps);
  assert.deepEqual(deps.chamou('vincularSessaoAReserva')[0].args, ['pix1', { chargeId: 'pay_pix_perdido' }], 'H-06: o charge é amarrado à reserva pela linha');
  assert.equal(deps.chamou('aplicarTransicao')[0].args[1].para, 'confirmado', 'e o status é aplicado — antes o evento era consumido sem efeito');
  assert.equal(deps.notificados()[0].payload.chargeId, 'pay_pix_perdido');
  assert.equal(deps.chamou('registrarCicloAssinatura').length, 0);

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
  assert.deepEqual(deps.chamou('aplicarTransicaoPorCheckoutId')[0].args, ['chk_real', { de: 'pendente', para: 'cancelado', ocorridoEm: null }]);
  // CHECKOUT_EXPIRED atrasado sobre uma sessão já paga: não apaga a confirmação
  deps = depsFalsas({ buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, status: 'confirmado' } });
  await processarWebhook({ event: 'CHECKOUT_EXPIRED', checkout: { id: 'chk_real' } }, deps);
  assert.equal(deps.chamou('aplicarTransicaoPorCheckoutId').length, 0, 'confirmado → expirado não existe na matriz');
  // CHECKOUT_EXPIRED/CANCELED sobre uma sessão CONCLUÍDA (ainda pendente de dinheiro): ignorado
  for (const evento of ['CHECKOUT_EXPIRED', 'CHECKOUT_CANCELED']) {
    deps = depsFalsas({ buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, sessao_concluida_em: '2026-09-25T01:26:34Z' } });
    await processarWebhook({ event: evento, checkout: { id: 'chk_real' } }, deps);
    assert.equal(deps.chamou('aplicarTransicaoPorCheckoutId').length, 0, `${evento} depois de CHECKOUT_PAID não solta a reserva para uma segunda assinatura`);
    assert.equal(deps.notificados().length, 0, `${evento} depois de CHECKOUT_PAID não avisa "cancelada"`);
  }

  // 16b. O INCIDENTE DE 25/09/2026, com os payloads REAIS (redigidos) na ordem em
  //      que chegaram: SUBSCRIPTION_CREATED, CHECKOUT_PAID — e o 1º ciclo PENDING.
  {
    const linha = { ...cobrancaAssinaturaCrua, id: 'bda7f6e9', asaas_checkout_id: '842e6f11', plano_id: 'plano_anual', ciclo: 'YEARLY', valor_cobrado: 10, contratante_id: 'testemaster' };
    const subscriptionCreated = { id: 'evt_6561&1533536453', event: 'SUBSCRIPTION_CREATED', dateCreated: '2026-09-24 22:26:34', subscription: { id: 'sub_39mjscz7vl2jwx7g', cycle: 'YEARLY', value: 10, status: 'ACTIVE', deleted: false, nextDueDate: '2027-09-25', checkoutSession: '842e6f11', billingType: 'CREDIT_CARD' } };
    const checkoutPaid = { id: 'evt_20f7&1533536454', event: 'CHECKOUT_PAID', dateCreated: '2026-09-24 22:26:34', checkout: { id: '842e6f11', status: 'PAID', subscription: { cycle: 'YEARLY', nextDueDate: '2026-09-25T03:00:00+0000' }, externalReference: 'reserva-bda7f6e9' } };
    deps = depsFalsas({ buscarCobrancaPorCheckoutId: linha });
    await processarWebhook(subscriptionCreated, deps);
    await processarWebhook(checkoutPaid, deps);
    assert.equal(deps.chamou('aplicarTransicaoPorCheckoutId').length, 0, 'INCIDENTE: nenhum dos dois eventos leva a linha a confirmado');
    assert.equal(deps.chamou('aplicarTransicao').length, 0);
    assert.equal(deps.chamou('upsertAssinatura').length, 0, 'INCIDENTE: nenhuma assinatura ativa nasce antes do dinheiro (entitlement)');
    assert.equal(deps.notificados().length, 0, 'INCIDENTE: o contratante não ouve "criada" nem "confirmado"');
    assert.equal(deps.chamou('marcarSessaoConcluida').length, 1, 'só a sessão é carimbada');
    // o 1º ciclo é RECUSADO no vencimento: vira recusado, e nada é ativado
    deps = depsFalsas({ buscarCobranca: null, buscarCobrancaPorCheckoutId: { ...linha, sessao_concluida_em: '2026-09-25T01:26:34Z' } });
    await processarWebhook({ event: 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', payment: { id: 'pay_v6f2xr6j98reaxb9', subscription: 'sub_39mjscz7vl2jwx7g', checkoutSession: '842e6f11' } }, deps);
    assert.equal(deps.chamou('aplicarTransicao')[0]?.args[1].para, 'recusado', 'cartão recusado no vencimento: recusado, nunca confirmado');
    assert.equal(deps.chamou('upsertAssinatura').length, 0, 'e a assinatura NÃO é ativada');
    assert.ok(!deps.notificados().some((x) => x.payload.evento === 'criada'), 'e "criada" não sai');
    // o 1º ciclo é CONFIRMADO no vencimento: aí sim confirmado + criada
    deps = depsFalsas({ buscarCobranca: null, buscarCobrancaPorCheckoutId: { ...linha, sessao_concluida_em: '2026-09-25T01:26:34Z' } });
    await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_v6f2xr6j98reaxb9', subscription: 'sub_39mjscz7vl2jwx7g', checkoutSession: '842e6f11' } }, deps);
    assert.equal(deps.chamou('aplicarTransicao')[0].args[1].para, 'confirmado');
    assert.equal(deps.chamou('upsertAssinatura')[0].args[0].id, 'sub_39mjscz7vl2jwx7g');
    assert.equal(deps.chamou('upsertAssinatura')[0].args[0].ciclo, 'YEARLY');
    assert.equal(deps.notificados()[0].payload.evento, 'criada');
  }

  // 16c. SEC-011: o ciclo de vida da assinatura não some calado
  {
    const linha = { ...cobrancaAssinaturaCrua, asaas_checkout_id: 'chk_s', charge_id: null, asaas_subscription_id: null };
    // o id da assinatura é gravado JÁ no primeiro evento, mesmo recusado
    deps = depsFalsas({ buscarCobranca: null, buscarCobrancaPorCheckoutId: linha });
    await processarWebhook({ event: 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', payment: { id: 'pay_s1', subscription: 'sub_s', checkoutSession: 'chk_s' } }, deps);
    assert.deepEqual(deps.chamou('atualizarSubscriptionIdDaCobranca')[0]?.args, ['pay_s1', 'sub_s'], 'SEC-011: a assinatura fica apontada desde o 1º evento, mesmo com o cartão recusado');
    assert.equal(deps.chamou('upsertAssinatura').length, 0, 'mas não NASCE — nasce só com dinheiro');
    assert.ok(deps.chamou('registrarErro').some((c) => c.args[1]?.contexto === 'webhookController.primeiroCicloFalhou'), 'SEC-011: o 1º ciclo recusado chama um humano (a assinatura segue viva na Asaas)');
    // ciclo de assinatura que ninguém daqui conhece: vira `erros`, não só log
    deps = depsFalsas({ buscarCobranca: null, buscarCobrancaPorSubscriptionId: null });
    await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_x9', subscription: 'sub_estranha' } }, deps);
    assert.ok(deps.chamou('registrarErro').some((c) => c.args[1]?.contexto === 'webhookController.assinaturaDesconhecida'), 'SEC-011: pagamento de assinatura sem molde local vira `erros`');
    // CHECKOUT_PAID não amarra um charge tirado do CORPO (o real não traz; o forjado traria um alheio)
    deps = depsFalsas({ buscarCobrancaPorCheckoutId: linha });
    await processarWebhook({ event: 'CHECKOUT_PAID', checkout: { id: 'chk_s', payment: { id: 'pay_de_outro_pedido' } } }, deps);
    assert.equal(deps.chamou('vincularChargeIdAoCheckout').length, 0, 'CHECKOUT_PAID não vincula pagamento algum pelo corpo');
    assert.equal(deps.chamou('marcarSessaoConcluida').length, 1, 'só carimba a sessão');
  }

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
    // Lançar depois de perguntar à Asaas (estorno sem respaldo) também é "fazer algo".
    await processarWebhook({ event: evento, payment: { id: 'pay_1' }, checkout: { id: 'chk_1' }, account: { id: 'acc_1' } }, espiao).catch(() => {});
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

  // C1-11: as que a reconciliação não resolve saem da frente — as outras chegam a ser vistas
  {
    const lista = Array.from({ length: 25 }, (_, i) => ({ chargeId: `pay_r${i}`, linhasDaInbox: [] }));
    const vistas = [];
    const espiao = depsFalsas({ listarCandidatasADivergencia: () => lista, buscarCobranca: (id) => { vistas.push(id); return null; } });
    const memoria = new Map();
    let t = 0;
    await reconciliarDivergenciasUmaVez(espiao, { adiadasAte: memoria, agora: () => t, lote: 20 });
    await reconciliarDivergenciasUmaVez(espiao, { adiadasAte: memoria, agora: () => t, lote: 20 });
    assert.equal(new Set(vistas).size, 25, 'C1-11: em duas passadas, TODAS as 25 candidatas foram examinadas (antes, as mesmas 20 sempre)');
    t = 2 * 60 * 60_000;
    vistas.length = 0;
    await reconciliarDivergenciasUmaVez(espiao, { adiadasAte: memoria, agora: () => t, lote: 20 });
    assert.equal(vistas.length, 20, 'e passado o adiamento, as adiadas voltam a ser examinadas');
  }

  // C1-07: a passada da inbox tem orçamento — o que sobra fica para o próximo tique
  {
    let t = 0;
    const lidas = [];
    const espiao = depsFalsas({ buscarCobranca: cobrancaPix, inbox: { ...inboxOk, listarParaReprocessar: () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }], reivindicarProcessamento: (id) => { lidas.push(id); t += 70_000; return { id, tentativas: 0, corpo_minimo: { id: `evt_${id}`, event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } } }; } } });
    const r = await reprocessarInbox(espiao, { orcamentoMs: 120_000, relogio: () => t });
    assert.deepEqual(lidas, ['a', 'b'], 'C1-07: passado o orçamento, a passada para de reivindicar');
    assert.equal(r.adiadas, 1, 'e diz quantas ficaram para o próximo tique');
  }

  // C1-06: a Asaas lenta não segura a resposta além do teto — e o processamento termina mesmo assim
  {
    const espiao = depsFalsas({ buscarCobranca: cobrancaPix, inbox: inboxOk, estadoNaAsaas: () => new Promise((ok) => setTimeout(() => ok({ existe: true, pagamento: { id: 'pay_1', status: 'RECEIVED', value: cobrancaPix.valor_cobrado }, estado: 'confirmado', valorEstornado: null }), 300)) });
    const receptor = criarReceptorWebhook(espiao, { tetoDeRespostaMs: 50 });
    const res = { _status: null, status(c) { this._status = c; return this; }, json() { return this; } };
    const avisoOriginal = console.warn; const logOriginal = console.log; console.warn = () => {}; console.log = () => {};
    const inicio = Date.now();
    try { await receptor({ body: { id: 'evt_lento', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } }, get: () => undefined, ip: '203.0.113.7' }, res); } finally { console.warn = avisoOriginal; console.log = logOriginal; }
    const levou = Date.now() - inicio;
    assert.equal(res._status, 200, 'C1-06: responde 200 mesmo com a Asaas lenta');
    assert.ok(levou < 250, `C1-06: e responde no teto, não quando a Asaas responde (${levou} ms)`);
    assert.equal(espiao.chamou('inbox.marcarProcessado').length, 0, 'controle: no momento do 200 o processamento ainda não terminou');
    await new Promise((ok) => setTimeout(ok, 400));
    assert.equal(espiao.chamou('inbox.marcarProcessado').length, 1, `C1-06: o processamento em segundo plano termina e marca a linha (falhas: ${JSON.stringify(espiao.chamou('inbox.marcarFalha').map((c) => c.args[2]))})`);
    assert.equal(espiao.chamou('registrarAuditoria').at(-1)?.args[0].resultado, 'tratado', 'e a auditoria registra o desfecho real, quando ele chega');
  }

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

  /* ============================================================
     RN-51/RN-52 (25/09/2026): a liquidação de um pedido invalida as
     irmãs e denuncia a duplicidade. O serviço em si tem autoteste
     próprio; aqui, a FIAÇÃO no receptor.
     ============================================================ */
  {
    const pedidoPago = { id: 'row_cartao', ...cobrancaPix, charge_id: 'pay_cartao', metodo_pagamento: 'cartao_credito' };

    // pago agora: a irmã é marcada e o cancelador é disparado
    let d = depsFalsas({ buscarCobranca: pedidoPago, aoLiquidarPedido: () => ({ duplicadoCom: [], obsoletas: 1 }) });
    await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_cartao' } }, d);
    assert.equal(d.chamou('aoLiquidarPedido').length, 1, 'a confirmação de um pedido passa pelas irmãs');
    assert.equal(d.chamou('aoLiquidarPedido')[0].args[0].id, 'row_cartao', 'com a linha que liquidou');
    assert.equal(d.chamou('dispararCancelador').length, 1, 'e o cancelador sai logo, fora do fluxo');
    assert.equal(d.notificados()[0].payload.pagamentoDuplicado, false);
    assert.deepEqual(d.notificados()[0].payload.duplicadoCom, []);
    const ordem = d.chamadas.map((c) => c.nome);
    assert.ok(ordem.indexOf('aplicarTransicao') < ordem.indexOf('aoLiquidarPedido'), 'as irmãs são marcadas DEPOIS de a transição estar gravada');
    assert.ok(ordem.indexOf('aoLiquidarPedido') < ordem.indexOf('notificar'), 'e ANTES do aviso, que precisa saber da duplicidade');

    // nada a cancelar: o cancelador não é disparado à toa
    d = depsFalsas({ buscarCobranca: pedidoPago, aoLiquidarPedido: () => ({ duplicadoCom: [], obsoletas: 0 }) });
    await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_cartao' } }, d);
    assert.equal(d.chamou('dispararCancelador').length, 0);

    // D: a outra irmã já tinha liquidado — o aviso leva a duplicidade
    d = depsFalsas({ buscarCobranca: pedidoPago, aoLiquidarPedido: () => ({ duplicadoCom: ['pay_pix'], obsoletas: 0 }) });
    await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_cartao' } }, d);
    assert.equal(d.chamou('aplicarTransicao')[0].args[1].para, 'confirmado', 'D: o segundo pagamento é gravado — não se reescreve a história');
    assert.equal(d.notificados()[0].payload.pagamentoDuplicado, true, 'D: e o contratante ouve que é duplicado');
    assert.deepEqual(d.notificados()[0].payload.duplicadoCom, ['pay_pix']);
    assert.equal(d.notificados()[0].payload.status, 'confirmado', 'D: continua sendo um confirmado — é dinheiro real');

    // E: reentrega do MESMO evento (status já gravado) — as irmãs de novo, idempotente
    d = depsFalsas({ buscarCobranca: { ...pedidoPago, status: 'confirmado' }, aoLiquidarPedido: () => ({ duplicadoCom: [], obsoletas: 0 }) });
    await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_cartao' } }, d);
    assert.equal(d.chamou('aplicarTransicao').length, 0, 'E: nada é regravado');
    assert.equal(d.chamou('aoLiquidarPedido').length, 1, 'E: a marcação é refeita (o serviço é idempotente) — recupera uma que tenha falhado');

    // falha na marcação: LANÇA, para a inbox refazer (a transição já está gravada)
    d = depsFalsas({ buscarCobranca: pedidoPago, aoLiquidarPedido: () => { throw new Error('banco fora'); } });
    await assert.rejects(processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_cartao' } }, d), /banco fora/);

    // só liquidação mexe nas irmãs; assinatura não é pedido
    for (const evento of ['PAYMENT_OVERDUE', 'PAYMENT_REFUNDED', 'PAYMENT_AWAITING_RISK_ANALYSIS']) {
      d = depsFalsas({ buscarCobranca: { ...pedidoPago, status: evento === 'PAYMENT_REFUNDED' ? 'confirmado' : 'pendente' } });
      await processarWebhook({ event: evento, payment: { id: 'pay_cartao' } }, d);
      assert.equal(d.chamou('aoLiquidarPedido').length, 0, `${evento} não invalida irmã nenhuma`);
    }
    d = depsFalsas({ buscarCobranca: { ...cobrancaPix, pedido_id: null, plano_id: 'plano_x', metodo_pagamento: 'assinatura', charge_id: 'pay_sub' } });
    await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_sub', subscription: 'sub_1' } }, d);
    assert.equal(d.chamou('aoLiquidarPedido').length, 0, 'assinatura não tem irmãs de pedido');

    // a irmã JÁ cancelada que a Asaas liquida mesmo assim: o dinheiro vale
    d = depsFalsas({ buscarCobranca: { ...pedidoPago, status: 'cancelado_por_outro_pagamento' }, aoLiquidarPedido: () => ({ duplicadoCom: ['pay_pix'], obsoletas: 0 }) });
    await processarWebhook({ event: 'PAYMENT_RECEIVED', payment: { id: 'pay_cartao' } }, d);
    assert.deepEqual(d.chamou('aplicarTransicao')[0].args[1], { de: 'cancelado_por_outro_pagamento', para: 'confirmado', ocorridoEm: null, valorEstornado: undefined }, 'pagamento depois da exclusão não se perde');
    assert.equal(d.notificados()[0].payload.pagamentoDuplicado, true, 'e entra como duplicidade');
    // …e um CHECKOUT_* atrasado não a ressuscita nem troca o motivo
    d = depsFalsas({ buscarCobrancaPorCheckoutId: { ...pedidoPago, asaas_checkout_id: 'chk_1', status: 'cancelado_por_outro_pagamento' } });
    await processarWebhook({ event: 'CHECKOUT_EXPIRED', checkout: { id: 'chk_1' } }, d);
    assert.equal(d.chamou('aplicarTransicaoPorCheckoutId').length, 0);
  }

  console.log(`webhookController: ${checagens} checagens OK`);
}
