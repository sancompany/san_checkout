/**
 * SAN CHECKOUT v2 — src/controllers/webhookController.js
 * Recebe webhooks da Asaas e repassa a confirmação pro webhook_url do
 * contratante. Dois vocabulários de evento diferentes chegam no MESMO
 * endpoint — precisam de tratamento separado:
 *
 *   1. PAYMENT_* — Pix e Boleto cobrados direto, E TAMBÉM cada ciclo
 *      recorrente de Assinatura a partir do 2º mês (a 1ª cobrança de
 *      uma assinatura chega como CHECKOUT_PAID, item 2 abaixo; os
 *      ciclos seguintes são cobrança avulsa de verdade, identificados
 *      só pelo campo `payment.subscription`, sem passar pela pop-up
 *      de novo). Identifica pelo `payment.id`.
 *   2. CHECKOUT_* — Cartão/Assinatura via pop-up (Boleto NÃO usa mais
 *      Asaas Checkout — confirmado que ele só aceita CREDIT_CARD/PIX,
 *      ver `checkoutController.js`). Identifica pelo `checkout.id`
 *      (nosso `asaas_checkout_id`) — o `charge_id` de verdade só existe
 *      DEPOIS que `CHECKOUT_PAID` chega.
 *
 * Nota fiscal e e-mail de confirmação NÃO são mais responsabilidade
 * daqui — cada contratante recebe todo evento de mudança de status
 * (confirmado/estornado/vencido) no próprio `webhook_url` e decide o
 * que fazer do lado dele (ver `montarPayloadConfirmacaoPedido`).
 *
 * ✅ NOMES DE EVENTO CONFERIDOS contra a documentação oficial da Asaas
 * em 11/09/2026 — os 21 que este arquivo cita existem e estão escritos
 * certo, inclusive as duas grafias que divergem entre si e são fáceis
 * de errar: `CHECKOUT_CANCELED` com um L e
 * `PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED` com dois.
 *
 * ⚠️ O que continua NÃO confirmado é o FORMATO do payload em tráfego
 * real, não os nomes — esta v2 nunca recebeu um webhook de verdade. O
 * formato de PAYMENT_* já foi confirmado numa versão anterior deste
 * projeto; o de CHECKOUT_* não: onde exatamente vem o `payment.id`
 * criado (dentro de `checkout.payment` ou solto em `payment`? o código
 * tenta os dois caminhos), e se `payment.cycle` e `payment.nextDueDate`
 * chegam junto. É por isso que o console.log lá embaixo existe: para
 * ler o primeiro evento real de cada tipo e corrigir se precisar.
 *
 * ⚠️ Nome certo no código não basta: o evento só chega se estiver
 * MARCADO no painel da Asaas. A seleção é individual, não existe
 * "receber todos", e evento não marcado simplesmente nunca chega — o
 * pedido fica pendente para sempre do lado do contratante, sem erro em
 * lugar nenhum. A lista do que está marcado, e o motivo de cada um, é o
 * `CONSTRAINTS.md` seção 2.2 — referência única do assunto.
 */

import {
  buscarCobranca,
  atualizarStatusCobranca,
  buscarCobrancaPorCheckoutId,
  vincularChargeIdAoCheckout,
  atualizarStatusPorCheckoutId,
  atualizarSubscriptionIdDaCobranca,
  buscarCobrancaPorSubscriptionId,
  registrarCicloAssinatura,
  atualizarSituacaoSubconta
} from '../services/cobrancaService.js';
import { upsertAssinatura, atualizarStatusAssinatura } from '../services/assinaturaService.js';
import { cancelarAssinatura as cancelarAssinaturaNaAsaas } from '../services/asaasService.js';
import {
  registrarEventoWebhook,
  registrarRejeicaoWebhook,
  redigirPayload,
  extrairReferencia
} from '../services/auditoriaWebhookService.js';
import { compararSeguro } from '../utils/validadores.js';
import { assinarPayload } from '../utils/assinaturaWebhook.js';

/**
 * Tudo que este módulo toca fora de si mesmo, reunido num objeto só.
 *
 * Produção não passa nada e recebe estas; o autoteste passa versões
 * falsas e consegue exercitar o caminho crítico — idempotência, ciclo
 * novo de assinatura, sempre-200 — sem banco, sem rede e sem relógio.
 * Sem essa costura, a única forma de testar essas regras seria subir
 * Supabase e Asaas de verdade, que é o mesmo que não testar.
 *
 * `notificar` entra aqui junto com as funções de banco de propósito: é
 * saída de rede, e no teste ela também precisa virar um espião em vez
 * de um `fetch` real — de quebra, evita que o retry por `setTimeout`
 * agende timer de verdade durante o teste.
 */
const dependenciasPadrao = {
  buscarCobranca,
  atualizarStatusCobranca,
  buscarCobrancaPorCheckoutId,
  vincularChargeIdAoCheckout,
  atualizarStatusPorCheckoutId,
  atualizarSubscriptionIdDaCobranca,
  buscarCobrancaPorSubscriptionId,
  registrarCicloAssinatura,
  atualizarSituacaoSubconta,
  upsertAssinatura,
  atualizarStatusAssinatura,
  cancelarAssinaturaNaAsaas,
  notificar: (url, dados, segredo) => notificarContratante(url, dados, segredo),
  // A auditoria entra na costura junto com o resto: sem isso, o
  // autoteste não conseguiria afirmar que a linha é gravada — e uma
  // auditoria que ninguém testa é a que descobre estar quebrada no dia
  // em que era a única fonte de informação.
  registrarAuditoria: (dados) => registrarEventoWebhook(dados)
};

/**
 * Aplicado em webhookRoutes.js antes de receberWebhookAsaas. A Asaas
 * reenvia, em cada webhook, o "Token de acesso" configurado no painel
 * dela (Integrações → Webhooks) no header abaixo — sem isso, qualquer
 * um que descobrisse a URL podia forjar CHECKOUT_PAID/PAYMENT_CONFIRMED
 * e liberar pedido sem pagar. Fail-closed: sem env configurada, recusa
 * tudo (mesmo padrão do verificarAdminKey em adminController.js).
 * ⚠️ Nome do header confirmado na doc oficial da Asaas; conferir contra
 * o primeiro webhook real assim que o token for configurado no painel.
 */
export function verificarWebhookAsaas(requisicao, resposta, proximo) {
  const { ASAAS_WEBHOOK_TOKEN } = process.env;
  if (!ASAAS_WEBHOOK_TOKEN) {
    registrarRejeicaoWebhook({ ip: ipDaRequisicao(requisicao), tinhaToken: Boolean(requisicao.get('asaas-access-token')), motivo: 'sem ASAAS_WEBHOOK_TOKEN configurado' });
    return resposta.status(503).json({ erro: 'ASAAS_WEBHOOK_TOKEN não configurado no .env — webhook desativado.' });
  }
  if (!compararSeguro(requisicao.get('asaas-access-token'), ASAAS_WEBHOOK_TOKEN)) {
    // Contagem acumulada em memória, não uma linha por requisição: isto
    // aqui é alimentado por quem NÃO tem token, e uma escrita no banco
    // por tentativa entregaria escrita ilimitada a qualquer um que
    // descobrisse a URL. Ver auditoriaWebhookService.js.
    registrarRejeicaoWebhook({ ip: ipDaRequisicao(requisicao), tinhaToken: Boolean(requisicao.get('asaas-access-token')), motivo: 'token inválido' });
    return resposta.status(401).json({ erro: 'Token de webhook inválido.' });
  }
  proximo();
}

/** `req.ip` depende do `trust proxy` do Express; atrás do proxy o endereço
 *  real vem no `x-forwarded-for`. Só o primeiro salto interessa — o
 *  resto da cadeia é forjável por quem manda a requisição. */
function ipDaRequisicao(requisicao) {
  const encaminhado = requisicao.get?.('x-forwarded-for');
  if (encaminhado) return String(encaminhado).split(',')[0].trim();
  return requisicao.ip ?? null;
}

const EVENTOS_PAYMENT_CONFIRMACAO = ['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'];
const EVENTOS_PAYMENT_ESTORNO = ['PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED'];
const EVENTOS_PAYMENT_ESTORNO_PROGRESSO = ['PAYMENT_REFUND_IN_PROGRESS'];
const EVENTOS_PAYMENT_ESTORNO_NEGADO = ['PAYMENT_REFUND_DENIED'];
const EVENTOS_PAYMENT_VENCIDO = ['PAYMENT_OVERDUE'];

/**
 * Pagamento parado na análise antifraude da Asaas — nem aprovado nem
 * recusado. O contratante precisa saber pra NÃO liberar o pedido
 * ainda, e pra não tratar como falha também.
 */
const EVENTOS_PAYMENT_EM_ANALISE = ['PAYMENT_AWAITING_RISK_ANALYSIS'];

/**
 * Recusa definitiva: antifraude reprovou, ou a captura do cartão
 * falhou. Antes esses eventos caíam no "não mapeado" e o pedido ficava
 * eternamente pendente do lado do contratante, sem ninguém saber por
 * quê.
 */
const EVENTOS_PAYMENT_RECUSADO = [
  'PAYMENT_REPROVED_BY_RISK_ANALYSIS',
  'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED'
];

/**
 * O portador contestou a compra no banco. É dinheiro saindo, e o
 * contratante costuma precisar suspender a entrega na hora — por isso
 * é repassado, mesmo que a disputa em si seja tratada fora do checkout.
 */
const EVENTOS_PAYMENT_CHARGEBACK = [
  'PAYMENT_CHARGEBACK_REQUESTED',
  'PAYMENT_AWAITING_CHARGEBACK_REVERSAL'
];

/** Baixa manual desfeita na Asaas — o que estava pago voltou a pendente. */
const EVENTOS_PAYMENT_PENDENTE_DE_NOVO = ['PAYMENT_RECEIVED_IN_CASH_UNDONE'];

const EVENTOS_PAYMENT_TRATADOS = [
  ...EVENTOS_PAYMENT_CONFIRMACAO,
  ...EVENTOS_PAYMENT_ESTORNO,
  ...EVENTOS_PAYMENT_ESTORNO_PROGRESSO,
  ...EVENTOS_PAYMENT_ESTORNO_NEGADO,
  ...EVENTOS_PAYMENT_VENCIDO,
  ...EVENTOS_PAYMENT_EM_ANALISE,
  ...EVENTOS_PAYMENT_RECUSADO,
  ...EVENTOS_PAYMENT_CHARGEBACK,
  ...EVENTOS_PAYMENT_PENDENTE_DE_NOVO
];

/**
 * Versão do contrato do webhook (INTEGRACAO.md seção 4.4). Vai em todo
 * payload pra que o contratante possa ramificar se um dia existir uma
 * v2 — a regra é só ADICIONAR campo, nunca remover nem renomear, então
 * este número deve mudar raramente ou nunca.
 */
const VERSAO_WEBHOOK = 1;

/** Os dois jeitos de assinar. Ambos falam o vocabulário de assinatura
 *  no webhook do contratante, não o de pedido avulso. */
const METODOS_DE_ASSINATURA = ['assinatura', 'assinatura_pix'];

/**
 * O roteamento por vocabulário de evento, sem Express em volta. É aqui
 * que mora a decisão do que fazer com cada evento — separado do handler
 * justamente para poder ser exercitado com dependências falsas.
 *
 * ⚠️ NÃO VALIDA ORIGEM. Quem faz isso é o `verificarWebhookAsaas`, que
 * `webhookRoutes.js` monta ANTES do handler. Esta função aceita qualquer
 * corpo e muda estado de pagamento a partir dele — montá-la direto numa
 * rota, ou chamá-la com corpo vindo da rede sem passar pela guarda,
 * reabre exatamente o buraco que a guarda fecha: qualquer um que
 * descubra a URL manda `CHECKOUT_PAID` e libera pedido sem pagar.
 * É exportada para o autoteste, não para ser reaproveitada em rota.
 */
export async function processarWebhook(corpo, deps = dependenciasPadrao) {
  switch (classificarEvento(corpo?.event)) {
    case 'checkout': return processarEventoCheckout(corpo, deps);
    case 'payment': return processarEventoPayment(corpo, deps);
    case 'subconta': return processarEventoSubconta(corpo, deps);
    case 'chave_api': return registrarAlertaChaveApi(corpo);
    case 'pix_automatico': return processarAutorizacaoPixAutomatico(corpo, deps);
    default:
      // Evento sem ramo (ex.: PAYMENT_CREATED, PIX_AUTOMATIC_RECURRING_
      // ELIGIBILITY_UPDATED, INVOICE_*) chega aqui e não faz nada. Não
      // some mais, porém: a auditoria grava a linha como `nao_mapeado`
      // e ela aparece no contador do painel.
      return undefined;
  }
}

/**
 * Qual ramo do roteador atende este evento — `null` quando nenhum.
 *
 * Existe separado por um motivo só, e é o que impede a auditoria de
 * mentir: o rótulo que vai para o log ("tratado" ou "não mapeado")
 * precisa sair da MESMA decisão que despacha o evento. Duas listas
 * paralelas divergiriam no primeiro evento novo, e o log passaria a
 * afirmar que algo foi tratado quando não foi — que é pior do que não
 * ter log, porque ninguém checa o que o painel já garantiu.
 */
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
 * Fábrica existe só para o autoteste conseguir injetar dependências: o
 * Express chama o handler com `(req, res, next)`, então não dá para
 * receber as dependências por parâmetro posicional sem colidir com o
 * `next`. Produção usa a instância única exportada logo abaixo, e
 * `webhookRoutes.js` continua importando o mesmo nome de sempre.
 *
 * ⚠️ O handler devolvido aqui TAMBÉM não valida origem — a guarda é
 * middleware separado, aplicado antes dele na rota. Vale a mesma
 * ressalva do `processarWebhook` acima: montar este handler sem o
 * `verificarWebhookAsaas` na frente libera pedido sem pagamento.
 */
export function criarReceptorWebhook(deps = dependenciasPadrao) {
  return async function receberWebhookAsaas(requisicao, resposta) {
    const corpo = requisicao.body;
    const evento = corpo?.event;
    const rota = classificarEvento(evento);
    const referencia = extrairReferencia(corpo);

    // O payload CRU não é mais impresso. Ele carrega nome, e-mail,
    // CPF/CNPJ, telefone e endereço do comprador, e o log da hospedagem é
    // retido por terceiro — era pendência aberta da Lei 10. O que
    // sobra é a versão redigida, que responde as mesmas perguntas de
    // diagnóstico (inclusive "onde vem o payment.id do CHECKOUT_PAID",
    // pelo mapa de chaves) sem carregar dado de pessoa nenhuma.
    const campos = redigirPayload(corpo);
    console.log('[webhook/asaas] evento:', JSON.stringify({ evento, rota, referencia, campos }));

    let resultado = rota ? 'tratado' : 'nao_mapeado';
    let detalhe = null;

    try {
      await processarWebhook(corpo, deps);
    } catch (erro) {
      resultado = 'erro';
      detalhe = erro.message;
      console.error('[webhook/asaas] erro ao processar:', erro.message);
    }

    // Sem `await` DE PROPÓSITO. A Asaas pausa a fila depois de 15
    // falhas seguidas (CONSTRAINTS.md §2.3), e resposta lenta conta
    // como falha: fazer a confirmação de pagamento esperar uma escrita
    // de diagnóstico trocaria o risco pequeno (perder uma linha de
    // log) pelo grande (perder a fila inteira). A função chamada não
    // lança — o `catch` aqui é cinto e suspensório.
    try {
      deps.registrarAuditoria({
        evento,
        rota,
        resultado,
        detalhe,
        referenciaTipo: referencia.tipo,
        referenciaId: referencia.id,
        statusMapeado: mapearStatusPayment(evento),
        campos
      })?.catch?.((erro) => console.error('[webhook/asaas] auditoria falhou:', erro.message));
    } catch (erro) {
      // O `catch` do promise cobre a falha assíncrona; este cobre a
      // síncrona. Parece redundante e não é: uma implementação que
      // estourasse ANTES de devolver o promise escaparia do primeiro e
      // impediria o 200 de ser enviado — auditoria derrubando o
      // caminho do dinheiro, exatamente o que ela não pode fazer.
      console.error('[webhook/asaas] auditoria falhou:', erro.message);
    }

    // sempre 200 — a Asaas para de reenviar se receber erro repetido
    resposta.status(200).json({ recebido: true });
  };
}

export const receberWebhookAsaas = criarReceptorWebhook();

/** Traduz o nome do evento Asaas pro nosso status local — devolve
 *  `null` pra evento que chegou até aqui mas não deveria mudar status
 *  (não deve acontecer, já que a rota acima já filtra, mas evita
 *  gravar um status incorreto se um evento novo entrar na lista de
 *  tratados sem entrar aqui também). */
export function mapearStatusPayment(evento) {
  if (EVENTOS_PAYMENT_CONFIRMACAO.includes(evento)) return 'confirmado';
  if (EVENTOS_PAYMENT_ESTORNO.includes(evento)) return 'estornado';
  if (EVENTOS_PAYMENT_ESTORNO_PROGRESSO.includes(evento)) return 'estorno_solicitado';
  if (EVENTOS_PAYMENT_ESTORNO_NEGADO.includes(evento)) return 'estorno_negado';
  if (EVENTOS_PAYMENT_VENCIDO.includes(evento)) return 'vencido';
  if (EVENTOS_PAYMENT_EM_ANALISE.includes(evento)) return 'em_analise';
  if (EVENTOS_PAYMENT_RECUSADO.includes(evento)) return 'recusado';
  if (EVENTOS_PAYMENT_CHARGEBACK.includes(evento)) return 'chargeback';
  if (EVENTOS_PAYMENT_PENDENTE_DE_NOVO.includes(evento)) return 'pendente';
  return null;
}

/** Só usado pra notificação de Assinatura — traduz o status local pro
 *  vocabulário já documentado no INTEGRACAO.md seção 6.1
 *  (criada/cobranca_confirmada/cobranca_falhou/cancelada). */
/**
 * Fecha a assinatura antiga depois que a renovação foi paga.
 *
 * Ordem importa: cancelar primeiro e cobrar depois deixaria o assinante
 * sem nada se o pagamento falhasse. Aqui a antiga só cai com a nova já
 * confirmada — no pior caso ele fica com duas por alguns segundos, o
 * que é recuperável; ficar com zero não é.
 *
 * Falha ao cancelar não derruba a confirmação: o dinheiro da nova já
 * entrou, e uma assinatura velha sobrando é problema menor (e visível
 * no painel da Asaas) do que devolver erro pra quem acabou de pagar.
 */
async function encerrarAssinaturaSubstituida(cobranca, novaAssinaturaId, deps = dependenciasPadrao) {
  const antigaId = cobranca.substitui_assinatura_id;
  if (!antigaId || antigaId === novaAssinaturaId) return;

  try {
    await deps.cancelarAssinaturaNaAsaas(antigaId);
    await deps.atualizarStatusAssinatura(antigaId, 'cancelada');
    console.log(`[assinatura/renovacao] ${antigaId} encerrada; substituída por ${novaAssinaturaId}`);
  } catch (erro) {
    console.error(
      `[assinatura/renovacao] a nova assinatura ${novaAssinaturaId} foi paga, mas NÃO consegui cancelar a antiga ` +
      `${antigaId}: ${erro.message}. Cancele na mão no painel da Asaas pra não cobrar duas vezes.`
    );
  }
}

/* ------------------------------------------------------------------
   VOCABULÁRIO 3 — eventos de CONTA (subcontas e chave de API)
------------------------------------------------------------------ */

/**
 * Alertas de chave de API vivos neste processo, expostos em
 * `/api/saude`. A Asaas EXPIRA chave por inatividade: sem escutar isso,
 * a integração morre sozinha um dia e ninguém sabe por quê. Guardar em
 * memória basta — o boot limpa, e a Asaas reavisa antes de expirar.
 *
 * ponytail: sem tabela nem serviço de alerta; um array e um campo no
 * health check que o cron-job.org já consulta a cada poucos dias.
 */
const alertasChaveApi = [];

export function obterAlertasChaveApi() {
  return alertasChaveApi;
}

function registrarAlertaChaveApi(corpo) {
  const evento = corpo?.event;
  // CREATED/ENABLED são rotina; só o que ameaça a integração vira alerta.
  if (!['ACCESS_TOKEN_EXPIRING_SOON', 'ACCESS_TOKEN_EXPIRED', 'ACCESS_TOKEN_DISABLED', 'ACCESS_TOKEN_DELETED'].includes(evento)) {
    return;
  }

  const alerta = { evento, em: new Date().toISOString() };
  alertasChaveApi.push(alerta);
  console.error(
    `[ALERTA/chave-asaas] ${evento} — a chave de API da Asaas está para expirar ou foi desativada. ` +
    'Gere uma nova no painel da Asaas e atualize ASAAS_API_KEY no Northflank ANTES que ela caia, ' +
    'senão toda cobrança para de funcionar sem aviso.'
  );
}

/**
 * Autorização de Pix Automático mudou de estado.
 *
 * A autorização é criada como CREATED e só vira ACTIVE quando o pagador
 * lê o QR e paga a primeira cobrança no app do banco — é nesse momento
 * que a assinatura por Pix existe de verdade. Antes disso, nada foi
 * cobrado e nada foi autorizado.
 *
 * Guardamos a autorização em `cobrancas.asaas_checkout_id` (ela faz o
 * papel da sessão de pop-up no fluxo de cartão), então é por ali que a
 * cobrança é localizada.
 *
 * ⚠️ NUNCA TESTADO — depende de a Asaas habilitar Pix Automático na
 * conta. O console.log existe pra você ver o payload real do primeiro
 * evento e corrigir se o campo do id vier com outro nome.
 */
async function processarAutorizacaoPixAutomatico(corpo, deps = dependenciasPadrao) {
  const evento = corpo?.event;
  // Não confirmado byte a byte: tenta os caminhos plausíveis do id.
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
      ciclo: corpo?.authorization?.frequency ?? null,
      proximaCobranca: null
    });
    return notificarConformeMetodo(cobranca, { confirmado: true, eventoAssinatura: 'criada' }, deps);
  }

  if (ENCERROU.includes(evento)) {
    await deps.atualizarStatusPorCheckoutId(autorizacaoId, 'cancelado');
    return notificarConformeMetodo(cobranca, { confirmado: false, eventoAssinatura: 'cancelada' }, deps);
  }
}

/**
 * Aprovação de subconta. Antes disso, criar subconta via API deixava o
 * operador conferindo na mão se a Asaas já tinha liberado. O
 * `account.id` do payload é o nosso `subcontas.asaas_account_id`.
 *
 * Formato confirmado na doc oficial ("Webhook para verificar situação
 * da conta"): { event, account: { id }, accountStatus: { general,
 * commercialInfo, bankAccountInfo, documentation } }.
 */
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

export function mapearEventoAssinatura(status) {
  if (status === 'confirmado') return 'cobranca_confirmada';
  // Recusa de cartão num ciclo é, pro assinante, a mesma coisa que a
  // cobrança não ter entrado — mesmo evento do vencimento.
  if (status === 'vencido' || status === 'recusado') return 'cobranca_falhou';
  if (status === 'estornado' || status === 'estorno_solicitado') return 'cobranca_estornada';
  if (status === 'chargeback') return 'cobranca_contestada';
  // 'em_analise' e 'pendente' são estados de passagem — não viram
  // evento de assinatura pra não gerar ruído no contratante.
  return null;
}

/* ------------------------------------------------------------------
   VOCABULÁRIO 1 — Pix/Boleto direto (payment.id = nosso charge_id) E
   ciclos de Assinatura a partir do 2º mês (payment.subscription).
------------------------------------------------------------------ */
async function processarEventoPayment(corpo, deps = dependenciasPadrao) {
  const evento = corpo?.event;
  const payment = corpo?.payment;
  const chargeId = payment?.id;
  if (!chargeId) return;

  const novoStatus = mapearStatusPayment(evento);
  if (!novoStatus) return;

  let cobranca = await deps.buscarCobranca(chargeId);

  if (!cobranca) {
    // Charge_id desconhecido: só vale a pena investigar se for um
    // ciclo novo de assinatura (a Asaas manda o id da assinatura de
    // origem no campo `subscription`) — qualquer outra cobrança
    // avulsa desconhecida não é nossa, ignora.
    if (!payment?.subscription) return;
    cobranca = await registrarNovoCicloAssinatura(payment, deps);
    if (!cobranca) return;
  }

  if (cobranca.status === novoStatus) return; // já processado — evita duplicar notificação/e-mail

  await deps.atualizarStatusCobranca(chargeId, novoStatus);

  if (METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento)) {
    return notificarConformeMetodo(cobranca, {
      confirmado: novoStatus === 'confirmado',
      chargeId,
      eventoAssinatura: mapearEventoAssinatura(novoStatus)
    }, deps);
  }

  // Pix/Boleto avulso — repassa TODA mudança de status (confirmado,
  // estornado, vencido...) pro contratante, que decide do lado dele o
  // que fazer (nota fiscal, e-mail ao cliente, lembrete de vencimento
  // etc.) — não é mais responsabilidade do San Checkout.
  const webhookUrlDoContratante = cobranca.contratantes?.webhook_url;
  if (webhookUrlDoContratante) {
    await deps.notificar(
      webhookUrlDoContratante,
      montarPayloadConfirmacaoPedido(cobranca, chargeId, novoStatus),
      cobranca.contratantes?.api_key
    );
  }
}

/**
 * Ciclo novo de assinatura (2º mês em diante): a Asaas cobra sozinha e
 * o `charge_id` chega pronto no payload — não existe registro local
 * ainda porque só a 1ª cobrança passa pela pop-up/CHECKOUT_PAID. Usa a
 * cobrança mais recente daquela assinatura como "molde" (contratante,
 * plano, CPF, telefone, endereço) pra montar o registro do ciclo novo.
 */
async function registrarNovoCicloAssinatura(payment, deps = dependenciasPadrao) {
  const subscriptionId = payment.subscription;
  const modelo = await deps.buscarCobrancaPorSubscriptionId(subscriptionId);
  if (!modelo) {
    console.error(`[webhook/assinatura] ciclo novo da subscription ${subscriptionId} sem cobrança-modelo local — ignorando (nunca vimos a 1ª cobrança dela?).`);
    return null;
  }

  await deps.registrarCicloAssinatura({
    chargeId: payment.id,
    asaasSubscriptionId: subscriptionId,
    contratanteId: modelo.contratante_id,
    planoId: modelo.plano_id,
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
    valorCheio: payment.value ?? modelo.valor_cheio,
    valorComDesconto: payment.value ?? modelo.valor_com_desconto,
    valorCobrado: payment.value ?? modelo.valor_cobrado
  });

  return deps.buscarCobranca(payment.id);
}

/* ------------------------------------------------------------------
   VOCABULÁRIO 2 — Cartão/Boleto/Assinatura via pop-up
   (checkout.id = nosso asaas_checkout_id)
------------------------------------------------------------------ */
async function processarEventoCheckout(corpo, deps = dependenciasPadrao) {
  const evento = corpo?.event;
  const asaasCheckoutId = corpo?.checkout?.id ?? corpo?.id;
  if (!asaasCheckoutId) return;

  const cobranca = await deps.buscarCobrancaPorCheckoutId(asaasCheckoutId);
  if (!cobranca) return;

  if (evento === 'CHECKOUT_PAID') {
    // o payment recém-criado pode vir em dois lugares, dependendo de
    // como a Asaas realmente estrutura isso — tenta os dois.
    const payment = corpo?.checkout?.payment ?? corpo?.payment ?? null;
    const chargeId = payment?.id ?? null;
    if (chargeId) await deps.vincularChargeIdAoCheckout(asaasCheckoutId, chargeId);
    await deps.atualizarStatusPorCheckoutId(asaasCheckoutId, 'confirmado');

    const chargeIdFinal = chargeId ?? cobranca.charge_id;

    // Assinatura: a partir daqui a Asaas revela o id da assinatura
    // (`payment.subscription`) — grava ele na cobrança (vira a
    // "cobrança-modelo" dos ciclos seguintes) e cria a linha em
    // `assinaturas` (usada só pro /cancelar-assinatura achar o id).
    if (cobranca.metodo_pagamento === 'assinatura' && payment?.subscription && chargeIdFinal) {
      await deps.atualizarSubscriptionIdDaCobranca(chargeIdFinal, payment.subscription);
      await deps.upsertAssinatura({
        id: payment.subscription,
        contratanteId: cobranca.contratante_id,
        planoId: cobranca.plano_id,
        documento: cobranca.documento,
        valor: cobranca.valor_cobrado,
        ciclo: payment.cycle ?? null, // ⚠️ não confirmado se a Asaas manda isso aqui
        proximaCobranca: payment.nextDueDate ?? null // ⚠️ idem
      });

      // Renovação: só AGORA a antiga é cancelada — com o pagamento novo
      // já confirmado. Se a renovação tivesse falhado, o assinante
      // continuaria com a assinatura anterior, sem ficar sem nenhuma.
      await encerrarAssinaturaSubstituida(cobranca, payment.subscription, deps);
    }

    return notificarConformeMetodo(cobranca, {
      confirmado: true,
      chargeId: chargeIdFinal
    }, deps);
  }

  if (evento === 'CHECKOUT_CANCELED') {
    await deps.atualizarStatusPorCheckoutId(asaasCheckoutId, 'cancelado');
    return notificarConformeMetodo(cobranca, { confirmado: false, eventoAssinatura: 'cancelada' }, deps);
  }

  if (evento === 'CHECKOUT_EXPIRED') {
    await deps.atualizarStatusPorCheckoutId(asaasCheckoutId, 'expirado');
    // Sem notificação: nem o webhook de pedido (INTEGRACAO.md seção 4)
    // nem o de assinatura (seção 6.1) documentam um status/evento pra
    // expiração — só atualizamos nosso próprio banco.
  }
}

/**
 * Assinatura usa um FORMATO DE WEBHOOK DIFERENTE do pedido avulso
 * (INTEGRACAO.md seção 6.1 vs seção 4) — por isso ramifica aqui por
 * `metodo_pagamento` antes de montar o payload. `eventoAssinatura`
 * explícito (usado pelos ciclos recorrentes, cancelamento) tem
 * prioridade; sem ele, `confirmado: true` cai no default 'criada'
 * (1ª cobrança, via CHECKOUT_PAID).
 */
async function notificarConformeMetodo(cobranca, { confirmado, chargeId, eventoAssinatura }, deps = dependenciasPadrao) {
  const webhookUrlDoContratante = cobranca.contratantes?.webhook_url;
  if (!webhookUrlDoContratante) return;
  const segredo = cobranca.contratantes?.api_key;

  // Assinatura por cartão e por Pix Automático usam o MESMO vocabulário
  // de webhook (INTEGRACAO.md 6.1) — pro contratante é a mesma coisa,
  // muda só como o assinante pagou.
  if (METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento)) {
    const evento = eventoAssinatura ?? (confirmado ? 'criada' : null);
    if (!evento) return;
    return deps.notificar(webhookUrlDoContratante, {
      versao: VERSAO_WEBHOOK,
      tipo: 'assinatura',
      planoId: cobranca.plano_id,
      documento: cobranca.documento,
      evento
    }, segredo);
  }

  // Cartão/Boleto avulso — só notifica em confirmação (cancelamento
  // de tentativa não tem status documentado no INTEGRACAO.md seção 4,
  // então não inventamos um aqui).
  if (confirmado) {
    return deps.notificar(
      webhookUrlDoContratante,
      montarPayloadConfirmacaoPedido(cobranca, chargeId, 'confirmado'),
      segredo
    );
  }
}

export function montarPayloadConfirmacaoPedido(cobranca, chargeId, status) {
  return {
    versao: VERSAO_WEBHOOK,
    pedidoId: cobranca.pedido_id,
    chargeId,
    status,
    valorCheio: cobranca.valor_cheio,
    desconto: cobranca.desconto,
    cupom: cobranca.cupom,
    valorComDesconto: cobranca.valor_com_desconto,
    frete: cobranca.frete,
    taxaDoProjeto: cobranca.taxa_do_projeto,
    taxaAsaas: cobranca.taxa_asaas,
    taxaPropria: cobranca.taxa_propria,
    taxaIsenta: cobranca.taxa_isenta,
    taxasTotais: Number(cobranca.taxa_do_projeto ?? 0) + Number(cobranca.taxa_asaas ?? 0) + Number(cobranca.taxa_propria ?? 0),
    metodoPagamento: cobranca.metodo_pagamento,
    valorCobrado: cobranca.valor_cobrado
  };
}

// ponytail: retry em memória (setTimeout), sem fila persistente — se o
// processo reiniciar entre tentativas, a notificação pendente se perde.
// É o mesmo teto que o INTEGRACAO.md já documenta ("3 tentativas,
// espaçadas em alguns minutos"); subir pra fila persistente (ex.: tabela
// no Supabase + worker) só quando isso passar a ser um problema real.
const ATRASOS_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000];

async function tentarNotificar(url, dados, segredo) {
  // O corpo é serializado UMA vez e a MESMA string é assinada e
  // enviada. Serializar de novo pra mandar poderia gerar bytes
  // diferentes (ordem de chave, espaçamento) e a assinatura não
  // fecharia do outro lado.
  const corpoCru = JSON.stringify(dados);
  const timestamp = Math.floor(Date.now() / 1000);

  const resposta = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Checkout-Signature': assinarPayload(corpoCru, segredo, timestamp),
      'X-Checkout-Timestamp': String(timestamp)
    },
    body: corpoCru
  });
  if (!resposta.ok) throw new Error(`contratante respondeu ${resposta.status}`);
}

async function notificarContratante(url, dados, segredo, tentativa = 0) {
  if (!segredo) {
    // Sem api_key não dá pra assinar, e mandar sem assinatura é
    // exatamente o buraco que essa mudança fecha — então não manda.
    // Na prática não acontece: api_key é `not null` na tabela.
    console.error(`[webhook/asaas] contratante sem api_key — notificação para ${url} NÃO enviada.`);
    return;
  }

  try {
    await tentarNotificar(url, dados, segredo);
  } catch (erro) {
    const atraso = ATRASOS_RETRY_MS[tentativa];
    if (atraso === undefined) {
      console.error(`[webhook/asaas] desistindo de notificar ${url} após ${tentativa + 1} tentativas:`, erro.message);
      return;
    }
    console.error(`[webhook/asaas] falha ao notificar ${url} (tentativa ${tentativa + 1}), nova tentativa em ${atraso / 1000}s:`, erro.message);
    setTimeout(() => notificarContratante(url, dados, segredo, tentativa + 1), atraso);
  }
}

/* ------------------------------------------------------------------
   Autoteste — `node src/controllers/webhookController.js`
   Roda junto com os outros em `npm test`. Cobre o caminho crítico do
   webhook: a guarda que impede webhook forjado (regra 3 do `checkout`),
   o mapa de evento→status que decide se um pedido é marcado pago, e a
   soma de taxas do payload que o contratante recebe. NÃO cobre o fluxo
   acoplado ao banco (idempotência, ciclo de assinatura) — esse é o
   próximo passo, precisa de uma costura pra falsear o Supabase.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('webhookController.js')) {
  const { strict: assert } = await import('node:assert');

  // --- Guarda de token (segurança, regra 3 do checkout) ---
  const tokenOriginal = process.env.ASAAS_WEBHOOK_TOKEN;

  function rodarGuarda({ token, header }) {
    if (token === undefined) delete process.env.ASAAS_WEBHOOK_TOKEN;
    else process.env.ASAAS_WEBHOOK_TOKEN = token;

    const req = { get: (nome) => (nome === 'asaas-access-token' ? header : undefined) };
    const res = {
      _status: null, _json: null,
      status(c) { this._status = c; return this; },
      json(o) { this._json = o; return this; }
    };
    let chamouProximo = false;
    verificarWebhookAsaas(req, res, () => { chamouProximo = true; });
    return { status: res._status, chamouProximo };
  }

  let r = rodarGuarda({ token: undefined, header: 'qualquer' });
  assert.equal(r.status, 503, 'sem ASAAS_WEBHOOK_TOKEN configurado: recusa tudo (fail-closed)');
  assert.equal(r.chamouProximo, false, 'sem token configurado não passa adiante');

  r = rodarGuarda({ token: 'segredo-certo', header: 'segredo-errado' });
  assert.equal(r.status, 401, 'token do header não bate: 401');
  assert.equal(r.chamouProximo, false, 'token errado não passa adiante');

  r = rodarGuarda({ token: 'segredo-certo', header: undefined });
  assert.equal(r.status, 401, 'header ausente com token configurado: 401 (não 503)');

  r = rodarGuarda({ token: 'segredo-certo', header: 'segredo-certo' });
  assert.equal(r.chamouProximo, true, 'token certo passa adiante');
  assert.equal(r.status, null, 'token certo não seta status de erro');

  if (tokenOriginal === undefined) delete process.env.ASAAS_WEBHOOK_TOKEN;
  else process.env.ASAAS_WEBHOOK_TOKEN = tokenOriginal;

  // --- mapearStatusPayment (evento Asaas → status local) ---
  assert.equal(mapearStatusPayment('PAYMENT_CONFIRMED'), 'confirmado');
  assert.equal(mapearStatusPayment('PAYMENT_RECEIVED'), 'confirmado');
  assert.equal(mapearStatusPayment('PAYMENT_REFUNDED'), 'estornado');
  assert.equal(mapearStatusPayment('PAYMENT_PARTIALLY_REFUNDED'), 'estornado');
  assert.equal(mapearStatusPayment('PAYMENT_REFUND_IN_PROGRESS'), 'estorno_solicitado');
  assert.equal(mapearStatusPayment('PAYMENT_REFUND_DENIED'), 'estorno_negado');
  assert.equal(mapearStatusPayment('PAYMENT_OVERDUE'), 'vencido');
  assert.equal(mapearStatusPayment('PAYMENT_AWAITING_RISK_ANALYSIS'), 'em_analise');
  assert.equal(mapearStatusPayment('PAYMENT_REPROVED_BY_RISK_ANALYSIS'), 'recusado');
  assert.equal(mapearStatusPayment('PAYMENT_CREDIT_CARD_CAPTURE_REFUSED'), 'recusado');
  assert.equal(mapearStatusPayment('PAYMENT_CHARGEBACK_REQUESTED'), 'chargeback');
  assert.equal(mapearStatusPayment('PAYMENT_RECEIVED_IN_CASH_UNDONE'), 'pendente');
  assert.equal(mapearStatusPayment('PAYMENT_CREATED'), null, 'evento não mapeado: null (não marca status errado)');
  assert.equal(mapearStatusPayment('EVENTO_QUE_NAO_EXISTE'), null, 'evento desconhecido: null');

  // --- mapearEventoAssinatura (status local → vocabulário de assinatura) ---
  assert.equal(mapearEventoAssinatura('confirmado'), 'cobranca_confirmada');
  assert.equal(mapearEventoAssinatura('vencido'), 'cobranca_falhou');
  assert.equal(mapearEventoAssinatura('recusado'), 'cobranca_falhou', 'recusa de cartão num ciclo = cobrança não entrou');
  assert.equal(mapearEventoAssinatura('estornado'), 'cobranca_estornada');
  assert.equal(mapearEventoAssinatura('estorno_solicitado'), 'cobranca_estornada');
  assert.equal(mapearEventoAssinatura('chargeback'), 'cobranca_contestada');
  assert.equal(mapearEventoAssinatura('em_analise'), null, 'estado de passagem não vira evento (evita ruído)');
  assert.equal(mapearEventoAssinatura('pendente'), null, 'estado de passagem não vira evento');

  // --- montarPayloadConfirmacaoPedido (caminho de dinheiro: soma das taxas) ---
  const payload = montarPayloadConfirmacaoPedido(
    { pedido_id: 'ped_1', valor_cheio: 100, desconto: 10, cupom: 'X', valor_com_desconto: 90,
      frete: 5, taxa_do_projeto: 2, taxa_asaas: 1.5, taxa_propria: 0.5, taxa_isenta: false,
      metodo_pagamento: 'pix', valor_cobrado: 99 },
    'pay_1', 'confirmado'
  );
  assert.equal(payload.versao, VERSAO_WEBHOOK, 'carrega a versão do contrato');
  assert.equal(payload.pedidoId, 'ped_1');
  assert.equal(payload.chargeId, 'pay_1');
  assert.equal(payload.status, 'confirmado');
  assert.equal(payload.taxasTotais, 4, 'taxasTotais = projeto + asaas + própria (2 + 1.5 + 0.5)');

  const payloadTaxasNulas = montarPayloadConfirmacaoPedido(
    { pedido_id: 'ped_2', taxa_do_projeto: null, taxa_asaas: null, taxa_propria: null },
    'pay_2', 'confirmado'
  );
  assert.equal(payloadTaxasNulas.taxasTotais, 0, 'taxa nula conta como 0, não NaN');

  /* --- Fluxo com dependências falsas ---------------------------------
     Cada dependência vira um espião que anota como foi chamada. O valor
     que ela devolve é configurável por teste; passando uma função, dá
     para simular falha. Nenhum banco, nenhuma rede, nenhum timer. */
  // As chaves saem do próprio `dependenciasPadrao` — lista repetida à
  // mão sairia de sincronia no dia em que uma dependência nova entrasse,
  // e o falso devolveria `undefined` no lugar de uma função.
  function depsFalsas(retornos = {}) {
    const chamadas = [];
    const deps = {};
    for (const nome of Object.keys(dependenciasPadrao)) {
      deps[nome] = async (...args) => {
        chamadas.push({ nome, args });
        const r = retornos[nome];
        return typeof r === 'function' ? r(...args) : (r ?? null);
      };
    }
    deps.chamadas = chamadas;
    deps.chamou = (nome) => chamadas.filter((c) => c.nome === nome);
    return deps;
  }

  const contratante = { webhook_url: 'https://parceiro.exemplo/hook', api_key: 'chave-do-parceiro' };
  const cobrancaPix = {
    charge_id: 'pay_1', status: 'pendente', metodo_pagamento: 'pix',
    pedido_id: 'ped_1', contratantes: contratante
  };

  // Idempotência (regra 5 do `checkout`): o mesmo webhook chega duas
  // vezes e a segunda não pode reprocessar nada.
  let deps = depsFalsas({ buscarCobranca: { ...cobrancaPix, status: 'confirmado' } });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } }, deps);
  assert.equal(deps.chamou('atualizarStatusCobranca').length, 0, 'status já era esse: não regrava');
  assert.equal(deps.chamou('notificar').length, 0, 'status já era esse: não notifica de novo');

  deps = depsFalsas({ buscarCobranca: cobrancaPix });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } }, deps);
  assert.deepEqual(deps.chamou('atualizarStatusCobranca')[0].args, ['pay_1', 'confirmado'], 'primeira vez grava o status');
  assert.equal(deps.chamou('notificar').length, 1, 'primeira vez notifica o contratante');
  assert.equal(deps.chamou('notificar')[0].args[0], contratante.webhook_url);
  assert.equal(deps.chamou('notificar')[0].args[1].status, 'confirmado');
  assert.equal(deps.chamou('notificar')[0].args[2], contratante.api_key, 'notificação vai assinada com a chave do contratante');

  // Regra 6: evento fora do contrato não faz nada — e não quebra.
  deps = depsFalsas();
  await processarWebhook({ event: 'EVENTO_QUE_NAO_EXISTE' }, deps);
  await processarWebhook({}, deps);
  await processarWebhook(null, deps);
  assert.equal(deps.chamadas.length, 0, 'evento desconhecido, corpo vazio ou nulo: nenhum efeito');

  // Cobrança que não é nossa: ignora em vez de inventar registro.
  deps = depsFalsas({ buscarCobranca: null });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_de_outro' } }, deps);
  assert.equal(deps.chamou('atualizarStatusCobranca').length, 0, 'charge desconhecido sem subscription: ignora');
  assert.equal(deps.chamou('registrarCicloAssinatura').length, 0);

  // Ciclo novo de assinatura (2º mês em diante): charge desconhecido,
  // mas com `subscription` — vira registro local a partir do molde.
  const modeloAssinatura = {
    contratante_id: 'c1', plano_id: 'plano_1', documento: '12345678909',
    metodo_pagamento: 'assinatura', contratantes: contratante
  };
  let cicloRegistrado = false;
  deps = depsFalsas({
    buscarCobranca: () => (cicloRegistrado
      ? { ...modeloAssinatura, charge_id: 'pay_ciclo2', status: 'pendente' }
      : null),
    buscarCobrancaPorSubscriptionId: modeloAssinatura,
    registrarCicloAssinatura: () => { cicloRegistrado = true; }
  });
  await processarWebhook(
    { event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_ciclo2', subscription: 'sub_1', value: 50 } },
    deps
  );
  assert.equal(deps.chamou('registrarCicloAssinatura').length, 1, 'ciclo novo vira registro local');
  assert.equal(deps.chamou('notificar')[0].args[1].tipo, 'assinatura', 'ciclo usa o vocabulário de assinatura, não o de pedido');
  assert.equal(deps.chamou('notificar')[0].args[1].evento, 'cobranca_confirmada');

  // Ciclo novo sem molde local: ignora, não adivinha o contratante.
  deps = depsFalsas({ buscarCobranca: null, buscarCobrancaPorSubscriptionId: null });
  await processarWebhook(
    { event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_orfao', subscription: 'sub_nunca_vista' } },
    deps
  );
  assert.equal(deps.chamou('registrarCicloAssinatura').length, 0, 'sem cobrança-modelo: não registra ciclo às cegas');

  // CHECKOUT_PAID: liga o charge que só agora existe, confirma, notifica.
  deps = depsFalsas({
    buscarCobrancaPorCheckoutId: { ...cobrancaPix, metodo_pagamento: 'cartao_credito', charge_id: null }
  });
  await processarWebhook(
    { event: 'CHECKOUT_PAID', checkout: { id: 'chk_1', payment: { id: 'pay_novo' } } },
    deps
  );
  assert.deepEqual(deps.chamou('vincularChargeIdAoCheckout')[0].args, ['chk_1', 'pay_novo']);
  assert.deepEqual(deps.chamou('atualizarStatusPorCheckoutId')[0].args, ['chk_1', 'confirmado']);
  assert.equal(deps.chamou('notificar')[0].args[1].chargeId, 'pay_novo');

  // Renovação de assinatura: a ordem é a garantia. A antiga só cai
  // depois que a nova confirmou — trocar a ordem deixaria o assinante
  // sem nenhuma se o pagamento falhasse.
  const cobrancaRenovacao = {
    ...cobrancaPix, metodo_pagamento: 'assinatura',
    charge_id: 'pay_novo', substitui_assinatura_id: 'sub_antiga'
  };
  deps = depsFalsas({ buscarCobrancaPorCheckoutId: cobrancaRenovacao });
  await processarWebhook(
    { event: 'CHECKOUT_PAID', checkout: { id: 'chk_2', payment: { id: 'pay_novo', subscription: 'sub_nova' } } },
    deps
  );
  const ordem = deps.chamadas.map((c) => c.nome);
  assert.ok(
    ordem.indexOf('atualizarStatusPorCheckoutId') < ordem.indexOf('cancelarAssinaturaNaAsaas'),
    'a nova confirma ANTES de a antiga ser cancelada'
  );
  assert.deepEqual(deps.chamou('cancelarAssinaturaNaAsaas')[0].args, ['sub_antiga']);

  deps = depsFalsas({
    buscarCobrancaPorCheckoutId: cobrancaRenovacao,
    cancelarAssinaturaNaAsaas: () => { throw new Error('asaas fora do ar'); }
  });
  await processarWebhook(
    { event: 'CHECKOUT_PAID', checkout: { id: 'chk_3', payment: { id: 'pay_novo', subscription: 'sub_nova' } } },
    deps
  );
  assert.equal(deps.chamou('notificar').length, 1, 'falha ao cancelar a antiga não impede de avisar quem pagou');

  // Sempre 200: se a Asaas recebe erro repetido, ela para de reenviar —
  // então nem exceção no processamento pode virar resposta de erro.
  const receptor = criarReceptorWebhook(depsFalsas({
    buscarCobrancaPorCheckoutId: () => { throw new Error('banco fora do ar'); }
  }));
  const resposta = {
    _status: null, _json: null,
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; }
  };
  await receptor({ body: { event: 'CHECKOUT_PAID', checkout: { id: 'chk_erro' } } }, resposta);
  assert.equal(resposta._status, 200, 'erro no processamento ainda responde 200');
  assert.deepEqual(resposta._json, { recebido: true });

  // --- Auditoria (Lei 8) ------------------------------------------

  /* O rótulo do log tem que sair da MESMA decisão que despacha o
     evento. Aqui isso é verificado de fora: para cada evento, o que
     `classificarEvento` diz bate com o ramo que realmente rodou? */
  const CASOS_DE_ROTA = [
    ['PAYMENT_CONFIRMED', 'payment'],
    ['PAYMENT_OVERDUE', 'payment'],
    ['CHECKOUT_PAID', 'checkout'],
    ['CHECKOUT_CANCELED', 'checkout'],
    ['ACCOUNT_STATUS_DOCUMENT_APPROVED', 'subconta'],
    ['ACCESS_TOKEN_EXPIRING_SOON', 'chave_api'],
    ['PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED', 'pix_automatico'],
    // Marcado no painel, mas fora do prefixo que o código trata: tem
    // que aparecer como NÃO mapeado, não como tratado.
    ['PIX_AUTOMATIC_RECURRING_ELIGIBILITY_UPDATED', null],
    ['PIX_AUTOMATIC_RECURRING_PAYMENT_INSTRUCTION_REFUSED', null],
    ['PAYMENT_SPLIT_CANCELLED', null],
    ['PAYMENT_CREATED', null],
    ['INVOICE_CREATED', null],
    [undefined, null],
    [null, null]
  ];
  for (const [evento, esperado] of CASOS_DE_ROTA) {
    assert.equal(classificarEvento(evento), esperado, `rota de ${evento}`);
  }

  // Todo evento com rota reconhecida tem que produzir ALGUM efeito —
  // senão `classificarEvento` diria "tratado" para algo que o
  // roteador na verdade ignora, e o log mentiria.
  for (const [evento, rota] of CASOS_DE_ROTA.filter(([, r]) => r !== null)) {
    const espiao = depsFalsas({
      buscarCobranca: cobrancaPix,
      buscarCobrancaPorCheckoutId: cobrancaPix
    });
    await processarWebhook(
      { event: evento, payment: { id: 'pay_1' }, checkout: { id: 'chk_1' }, account: { id: 'acc_1' } },
      espiao
    );
    const teveEfeito = espiao.chamadas.length > 0 || obterAlertasChaveApi().length > 0;
    assert.ok(teveEfeito, `${evento} foi classificado como ${rota} mas não fez nada`);
  }

  /** Receptor com auditoria espiã, e um console.log capturado — os dois
   *  juntos porque a mesma chamada precisa provar duas coisas: o que
   *  foi GRAVADO e o que foi IMPRESSO. */
  async function receber(corpo, retornos = {}) {
    const espiao = depsFalsas(retornos);
    const receptor = criarReceptorWebhook(espiao);
    const res = {
      _status: null, _json: null,
      status(c) { this._status = c; return this; },
      json(o) { this._json = o; return this; }
    };
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

  let a = await receber({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } }, { buscarCobranca: cobrancaPix });
  assert.equal(a.auditoria.resultado, 'tratado', 'evento com ramo: tratado');
  assert.equal(a.auditoria.rota, 'payment');
  assert.equal(a.auditoria.referenciaId, 'pay_1');
  assert.equal(a.auditoria.referenciaTipo, 'payment');
  assert.equal(a.auditoria.statusMapeado, 'confirmado');

  a = await receber({ event: 'PIX_AUTOMATIC_RECURRING_ELIGIBILITY_UPDATED', account: { id: 'acc_9' } });
  assert.equal(a.auditoria.resultado, 'nao_mapeado', 'evento sem ramo entra no log como não mapeado');
  assert.equal(a.auditoria.rota, null);
  assert.equal(a.res._status, 200, 'evento não mapeado ainda responde 200');

  a = await receber(
    { event: 'CHECKOUT_PAID', checkout: { id: 'chk_erro' } },
    { buscarCobrancaPorCheckoutId: () => { throw new Error('banco fora do ar'); } }
  );
  assert.equal(a.auditoria.resultado, 'erro', 'exceção no processamento vira resultado=erro no log');
  assert.equal(a.auditoria.detalhe, 'banco fora do ar', 'o motivo do erro é guardado');
  assert.equal(a.res._status, 200, 'erro registrado ainda responde 200');

  // A auditoria é diagnóstico. Ela quebrando não pode derrubar a
  // confirmação de pagamento — a Asaas pausa a fila depois de 15
  // falhas seguidas (CONSTRAINTS.md §2.3).
  a = await receber(
    { event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } },
    { buscarCobranca: cobrancaPix, registrarAuditoria: () => { throw new Error('tabela sumiu'); } }
  );
  assert.equal(a.res._status, 200, 'auditoria quebrada não derruba o webhook');
  assert.equal(a.espiao.chamou('notificar').length, 1, 'auditoria quebrada não impede a notificação');

  // Lei 10: o payload cru NÃO é mais impresso. Um CPF que entra pelo
  // webhook não pode sair no log da hospedagem.
  a = await receber({
    event: 'PAYMENT_CONFIRMED',
    payment: { id: 'pay_1', status: 'CONFIRMED' },
    customer: { name: 'Maria Aparecida', cpfCnpj: '52998224725', email: 'maria@exemplo.com' }
  }, { buscarCobranca: cobrancaPix });
  for (const proibido of ['52998224725', 'Maria Aparecida', 'maria@exemplo.com']) {
    assert.ok(!a.impresso.includes(proibido), `dado pessoal vazou no log: ${proibido}`);
  }
  assert.ok(a.impresso.includes('PAYMENT_CONFIRMED'), 'mas o evento continua identificável no log');
  assert.ok(a.impresso.includes('customer.cpfCnpj'), 'e o CAMINHO da chave continua visível, sem o valor');

  console.log('webhookController: caminho crítico OK');
}
