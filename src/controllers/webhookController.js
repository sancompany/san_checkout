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
 * ✅ O FORMATO foi medido em tráfego real, e o que estava escrito aqui
 * estava errado. Até 15/09/2026 este cabeçalho dizia que o `payment.id`
 * criado viria "dentro de `checkout.payment` ou solto em `payment`" e
 * que o código "tenta os dois caminhos". Não vem em nenhum dos dois: o
 * `CHECKOUT_PAID` **não carrega pagamento**. O id chega no
 * `PAYMENT_CONFIRMED` seguinte (279 ms depois, na medição), com
 * `payment.checkoutSession` apontando de volta para a sessão — e é por
 * ele que o vínculo é fechado hoje
 * (`vincularPrimeiraCobrancaDoCheckout`).
 *
 * Custou caro descobrir por medição em vez de por leitura:
 * `docs/erros/2026-09-15-confiei-que-o-checkout-paid-traria-o-id-do-pagamento.md`.
 * Toda cobrança de pop-up ficava `confirmado` com `charge_id` nulo, e
 * com ela morriam o cancelamento de assinatura e todos os ciclos
 * seguintes, sem erro em lugar nenhum.
 *
 * O que SEGUE não confirmado, e por isso continua opcional no código:
 * se `payment.cycle` e `payment.nextDueDate` vêm no `PAYMENT_CONFIRMED`
 * de uma assinatura. Os dois entram como `?? null` — a assinatura
 * existe sem eles, e inventar valor seria pior que deixar nulo.
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
  /* SEM `await`, pelo MESMO motivo que a auditoria em
     `criarReceptorWebhook` não é aguardada — e aqui o risco é maior, não
     menor: aquilo é uma escrita no nosso banco, isto é uma chamada de
     rede ao endereço de um TERCEIRO.

     O receptor faz `await processarWebhook(...)` antes de responder, e
     esta cadeia termina no endpoint do contratante. Aguardando, um
     parceiro lento (ou pendurado) atrasa a nossa resposta à Asaas — que
     conta resposta lenta como falha e PAUSA A FILA da conta depois de 15
     seguidas (CONSTRAINTS.md §2.3). Ou seja: um contratante mal-
     comportado derrubaria a confirmação de pagamento de TODOS os outros.

     A durabilidade não muda com isto: a fila de retry já é em memória e
     o `API.md` §4.3.6 documenta exatamente essa garantia ("se o processo
     reiniciar entre as tentativas, aquela notificação se perde"). O que
     muda é de quem é o problema quando o parceiro está fora do ar. */
  notificar: (url, dados, segredo) => {
    notificarContratante(url, dados, segredo)
      .catch((erro) => console.error('[webhook/asaas] notificação falhou fora do fluxo:', erro.message));
  },
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
 * Versão do contrato do webhook (API.md §10). Vai em todo
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
 *  vocabulário já documentado no API.md §4.3.4
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

  /* Primeira cobrança de um pop-up: o `charge_id` só existe AQUI.

     A Asaas não manda o id do pagamento no `CHECKOUT_PAID` — medido em
     15/09/2026 sobre os payloads crus de `webhook_eventos`, numa
     assinatura real paga no sandbox. O evento de checkout traz
     `checkout.*` e nada de `payment`. O id chega 279 ms depois, no
     `PAYMENT_CONFIRMED`, junto de `payment.checkoutSession`, que aponta
     de volta para a sessão.

     Sem este trecho a cobrança ficava `confirmado` com `charge_id`
     nulo para sempre, e a partir daí tudo que depende dele falhava em
     silêncio: o vínculo da assinatura nunca era gravado, o
     `/cancelar-assinatura` não achava o que cancelar, e cada ciclo
     seguinte caía no `registrarNovoCicloAssinatura` sem cobrança-modelo
     — o contratante nunca recebia `cobranca_confirmada`. */
  let primeiraDoCheckout = false;
  if (!cobranca) {
    cobranca = await vincularPrimeiraCobrancaDoCheckout(payment, deps);
    primeiraDoCheckout = Boolean(cobranca);
  }

  if (!cobranca) {
    // Charge_id desconhecido: só vale a pena investigar se for um
    // ciclo novo de assinatura (a Asaas manda o id da assinatura de
    // origem no campo `subscription`) — qualquer outra cobrança
    // avulsa desconhecida não é nossa, ignora.
    if (!payment?.subscription) return;
    cobranca = await registrarNovoCicloAssinatura(payment, deps);
    if (!cobranca) return;
  }

  /* `primeiraDoCheckout` fura a guarda de idempotência de propósito: o
     `CHECKOUT_PAID` já marcou esta linha como `confirmado` pelo
     `asaas_checkout_id`, então o status daqui SEMPRE bate e a guarda
     descartaria justamente o evento que traz o id que faltava. */
  if (!primeiraDoCheckout && cobranca.status === novoStatus) return; // já processado — evita duplicar notificação/e-mail

  await deps.atualizarStatusCobranca(chargeId, novoStatus);

  if (METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento)) {
    /* Aqui o trabalho ACABOU, e notificar seria um erro caro.

       Quem anuncia a primeira cobrança de uma assinatura é o
       `CHECKOUT_PAID`, com o evento `criada` (API.md §4.3.4) — que não
       carrega `chargeId` por contrato, então nada ficou faltando nele.
       Mandar `cobranca_confirmada` agora descreveria o MESMO ciclo com
       um segundo evento, e o checklist do API.md §11 manda o contratante
       creditar nos dois. Seria crédito em dobro, no caminho do dinheiro.

       Só a CONFIRMAÇÃO é engolida, e a diferença importa: se um dia o
       primeiro evento mapeado desta cobrança for outro (um estorno, um
       vencimento), ele não tem par no `CHECKOUT_PAID` para duplicar —
       e um `return` cego faria o contratante nunca saber. */
    if (primeiraDoCheckout && novoStatus === 'confirmado') return;

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
 * Amarra a assinatura da Asaas à cobrança que a originou: grava o
 * `asaas_subscription_id` na linha (é ela que vira a "cobrança-modelo"
 * dos ciclos seguintes), cria a linha em `assinaturas` — a única coisa
 * que o `/cancelar-assinatura` sabe procurar — e, se isto for uma
 * renovação, encerra a assinatura anterior.
 *
 * Existe como função porque DOIS eventos podem trazer esses dados, e
 * ninguém sabe qual virá primeiro no futuro: o `CHECKOUT_PAID` (que
 * hoje nunca traz) e o `PAYMENT_CONFIRMED` (que traz). Duplicar o bloco
 * nos dois lugares era o caminho curto — e é assim que duas cópias do
 * caminho do dinheiro divergem em silêncio na primeira manutenção.
 *
 * ── `ciclo` NUNCA vem de `payment` ────────────────────────────────────
 *
 * Veio até 15/09/2026, e estava errado: `payment.cycle` não existe em
 * nenhum payload medido — nem no `CHECKOUT_PAID` nem no
 * `PAYMENT_CONFIRMED`. Sem o `?? null` ter de onde vir, caía direto no
 * default de `assinaturaService.upsertAssinatura` (`MONTHLY`) —
 * silenciosamente errado pra qualquer plano que não seja mensal. Foi o
 * que aconteceu com a assinatura QUARTERLY do mostrai.
 *
 * A correção não é ler de outro campo do webhook: é não depender de
 * webhook nenhum. `ciclo` já é conhecido, validado, na hora em que
 * `criarCheckoutAssinatura` cria a sessão — e vai gravado na própria
 * cobrança desde o nascimento dela (`registrarCobrancaPendentePopup`).
 * `cobranca.ciclo` é sempre essa fonte; `payment.cycle` fica só como
 * fallback morto, sem custo, pro dia em que a Asaas mudar o formato.
 *
 * `proximaCobranca` NÃO tem fonte confiável hoje — `payment.nextDueDate`
 * também nunca existe, e o "nextDueDate" que MANDAMOS pra Asaas na
 * criação é a data de HOJE (a cobrança é imediata), não uma projeção da
 * próxima. Fica `null`, como sempre foi; não corrigido nesta mudança
 * (`docs/pendencias.md`).
 */
async function amarrarAssinaturaACobranca(cobranca, payment, chargeId, deps = dependenciasPadrao) {
  await deps.atualizarSubscriptionIdDaCobranca(chargeId, payment.subscription);
  await deps.upsertAssinatura({
    id: payment.subscription,
    contratanteId: cobranca.contratante_id,
    planoId: cobranca.plano_id,
    documento: cobranca.documento,
    valor: cobranca.valor_cobrado,
    ciclo: cobranca.ciclo ?? payment.cycle ?? null,
    proximaCobranca: payment.nextDueDate ?? null
  });

  // Renovação: só AGORA a antiga é cancelada — com o pagamento novo já
  // confirmado. Se a renovação tivesse falhado, o assinante continuaria
  // com a assinatura anterior, sem ficar sem nenhuma.
  await encerrarAssinaturaSubstituida(cobranca, payment.subscription, deps);
}

/**
 * Fecha o vínculo que o `CHECKOUT_PAID` não conseguiu fechar: liga o
 * `charge_id` (e, em assinatura, o `asaas_subscription_id`) à linha que
 * nasceu da pop-up.
 *
 * @returns {object|null} a cobrança já com o vínculo, ou null quando
 * este pagamento não é a primeira cobrança de um pop-up.
 *
 * ── A guarda que faz isto ser seguro ────────────────────────────────
 *
 * `if (cobranca.charge_id)` sai fora. Ela existe porque NÃO está
 * confirmado que `payment.checkoutSession` apareça só na primeira
 * cobrança — se a Asaas mandar o mesmo ponteiro nos ciclos seguintes de
 * uma assinatura, sem esta guarda cada mês sobrescreveria o `charge_id`
 * da primeira cobrança com o do ciclo novo. A linha-modelo viraria uma
 * linha mutante, o histórico sumiria, e `registrarNovoCicloAssinatura`
 * nunca mais seria chamado.
 *
 * Com a guarda, o segundo pagamento que citar esta sessão encontra o
 * `charge_id` já preenchido, devolve null, e cai no caminho de ciclo
 * novo — que é o certo. Por isso esta correção não depende de descobrir
 * como a Asaas trata `checkoutSession` na recorrência: funciona dos
 * dois jeitos.
 */
async function vincularPrimeiraCobrancaDoCheckout(payment, deps = dependenciasPadrao) {
  const asaasCheckoutId = payment?.checkoutSession;
  if (!asaasCheckoutId) return null;

  const cobranca = await deps.buscarCobrancaPorCheckoutId(asaasCheckoutId);
  if (!cobranca) {
    /* Este é o único dos três "desisto" desta função que NÃO é rotina.
       Só nós criamos sessão de checkout nesta conta da Asaas — então um
       `checkoutSession` que existe e não tem linha aqui significa que
       perdemos o registro de uma sessão que cobrou dinheiro. Nunca deve
       aparecer; se aparecer, é a pista. Os outros dois casos (sem
       `checkoutSession`, ou já vinculada) são caminho normal e saem
       calados, para o log não virar ruído. */
    console.error(
      `[webhook/pagamento] payment ${payment.id} cita a sessão ${asaasCheckoutId}, que não existe em cobrancas — ` +
      'sessão perdida ou pagamento de outra integração nesta conta Asaas.'
    );
    return null;
  }
  if (cobranca.charge_id) return null; // já vinculada — este é um ciclo, não a primeira

  await deps.vincularChargeIdAoCheckout(asaasCheckoutId, payment.id);

  // O vínculo da assinatura, ancorado no evento que de fato tem os
  // dados de pagamento. `cobranca.ciclo` já está na linha desde a
  // criação do checkout — este evento não precisa carregá-lo (ver
  // `amarrarAssinaturaACobranca`).
  if (METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento) && payment.subscription) {
    await amarrarAssinaturaACobranca(cobranca, payment, payment.id, deps);
  }

  // Devolve o estado PÓS-vínculo: quem chamou segue com a linha que
  // existe agora no banco, não com a que foi lida antes do update.
  return {
    ...cobranca,
    charge_id: payment.id,
    asaas_subscription_id: payment.subscription ?? cobranca.asaas_subscription_id ?? null
  };
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
    ciclo: modelo.ciclo,
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
    /* O `payment` pode vir em dois lugares — e, medido em 15/09/2026
       contra os payloads crus, NÃO VEM EM NENHUM DOS DOIS. Os dois
       caminhos ficam porque são baratos e cobrem o dia em que a Asaas
       passar a mandar; quem realmente fecha o vínculo hoje é o
       `PAYMENT_CONFIRMED` (ver `vincularPrimeiraCobrancaDoCheckout`). */
    const payment = corpo?.checkout?.payment ?? corpo?.payment ?? null;
    const chargeId = payment?.id ?? null;
    if (chargeId) await deps.vincularChargeIdAoCheckout(asaasCheckoutId, chargeId);
    await deps.atualizarStatusPorCheckoutId(asaasCheckoutId, 'confirmado');

    const chargeIdFinal = chargeId ?? cobranca.charge_id;

    // Assinatura: a partir daqui a Asaas revela o id da assinatura
    // (`payment.subscription`) — grava ele na cobrança (vira a
    // "cobrança-modelo" dos ciclos seguintes) e cria a linha em
    // `assinaturas` (usada só pro /cancelar-assinatura achar o id).
    // `cobranca.ciclo` já está na linha desde a criação do checkout —
    // ver `amarrarAssinaturaACobranca`.
    if (METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento) && payment?.subscription && chargeIdFinal) {
      await amarrarAssinaturaACobranca(cobranca, payment, chargeIdFinal, deps);
    }

    /* Pedido avulso sem `chargeId` não vira aviso.

       O payload de pedido (§4.3.2) carrega `chargeId`, e a chave de
       idempotência que o §4.3.6 manda o contratante usar é
       `chargeId` + `status`. Mandar `chargeId: null` é entregar um aviso
       que o contratante não consegue deduplicar nem conferir — o
       MostrAí recusou creditar exatamente por isso, e estava certo.

       Quem avisa neste caso é o `PAYMENT_CONFIRMED`, 279 ms depois, já
       com o id verdadeiro. Não se perde notificação: o que se perde é
       uma notificação inútil.

       Assinatura NÃO entra aqui: o evento `criada` (§4.3.4) não carrega
       `chargeId` por contrato — a chave dele é `planoId` + `documento`.
       Nada falta nele, então ele sai agora, como sempre saiu. */
    if (!METODOS_DE_ASSINATURA.includes(cobranca.metodo_pagamento) && !chargeIdFinal) {
      // `log`, e não `error`: com a Asaas de hoje isto acontece em TODO
      // pagamento de pop-up. Carimbar de erro um caminho normal ensina
      // o operador a ignorar o log — e aí o erro de verdade passa.
      console.log(
        `[webhook/checkout] ${asaasCheckoutId}: CHECKOUT_PAID sem id de pagamento (esperado); ` +
        'o aviso sai no PAYMENT_CONFIRMED, que traz o chargeId.'
      );
      return;
    }

    return notificarConformeMetodo(cobranca, {
      confirmado: true,
      chargeId: chargeIdFinal
    }, deps);
  }

  if (evento === 'CHECKOUT_CANCELED') {
    await deps.atualizarStatusPorCheckoutId(asaasCheckoutId, 'cancelado');

    /* RENOVAÇÃO abandonada não é a assinatura sendo cancelada — é o
       CONTRÁRIO: a antiga (`substitui_assinatura_id`) continua ativa e
       intocada, porque `encerrarAssinaturaSubstituida` só roda depois
       de o pagamento novo confirmar (ver `amarrarAssinaturaACobranca`).
       Mandar `cancelada` aqui mentiria pro contratante — o payload de
       assinatura é identificado só por `planoId`+`documento` (API.md
       §4.3.4), então ele não tem como distinguir "tentativa de
       renovação abandonada" de "o cliente cancelou de verdade": as
       duas produzem o MESMO evento, pro MESMO assinante. Um contratante
       que confia nisso pra liberar/revogar acesso revogaria de quem
       ainda está pagando. */
    if (cobranca.substitui_assinatura_id) return;

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
  // de webhook (API.md §4.3.4) — pro contratante é a mesma coisa,
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

/**
 * `POST /cancelar-assinatura` (assinaturaController.js) é o cancelamento
 * pedido pelo PRÓPRIO contratante — diferente dos outros dois lugares
 * que mandam `evento: 'cancelada'` (pop-up de cartão abandonada, e
 * autorização de Pix Automático encerrada), que reagem a algo que
 * aconteceu do lado do assinante. Mesmo payload, vocabulário único
 * (API.md §4.3.4) — só muda quem disparou.
 */
export async function notificarAssinaturaCancelada(contratante, { planoId, documento }, deps = dependenciasPadrao) {
  if (!contratante?.webhook_url) return;
  return deps.notificar(contratante.webhook_url, {
    versao: VERSAO_WEBHOOK,
    tipo: 'assinatura',
    planoId,
    documento,
    evento: 'cancelada'
  }, contratante.api_key);
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

/**
 * Teto por tentativa. O endereço do outro lado é de terceiro e pode
 * simplesmente não responder nunca — sem `AbortController` este `fetch`
 * fica pendurado para sempre, segurando um socket e a cadeia inteira que
 * o aguarda. O `pedidoService` já trata o alvo do contratante assim (45 s
 * no pull); aqui faltava, e o caminho é ainda mais sensível.
 *
 * 10 s, e não 45: o pull acontece com o comprador esperando a tela e
 * tolera cold start; isto acontece com a Asaas esperando um `200`, e
 * lentidão aqui é contada como falha por ela.
 */
const TIMEOUT_NOTIFICACAO_MS = 10_000;

async function tentarNotificar(url, dados, segredo) {
  // O corpo é serializado UMA vez e a MESMA string é assinada e
  // enviada. Serializar de novo pra mandar poderia gerar bytes
  // diferentes (ordem de chave, espaçamento) e a assinatura não
  // fecharia do outro lado.
  const corpoCru = JSON.stringify(dados);
  const timestamp = Math.floor(Date.now() / 1000);

  const controlador = new AbortController();
  const timeoutId = setTimeout(() => controlador.abort(), TIMEOUT_NOTIFICACAO_MS);

  let resposta;
  try {
    resposta = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Checkout-Signature': assinarPayload(corpoCru, segredo, timestamp),
        'X-Checkout-Timestamp': String(timestamp)
      },
      body: corpoCru,
      signal: controlador.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }

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
    /* `.unref()`: o timer não segura o processo vivo.
 
       Sem ele, uma notificação falhando mantém o event loop ocupado por
       até ~21 minutos (1 + 5 + 15), e um processo que deveria terminar
       não termina — foi assim que o autoteste abaixo travou quando foi
       escrito. Num servidor de verdade o efeito é o mesmo na hora do
       desligamento: o container demora a morrer por causa de uma
       tentativa best-effort.
 
       Não se perde garantia nenhuma: o `API.md` §4.3.6 já documenta que
       a fila de retry é em memória e que reiniciar o processo perde a
       tentativa pendente. `.unref()` só deixa de fingir o contrário. */
    setTimeout(() => notificarContratante(url, dados, segredo, tentativa + 1), atraso).unref();
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
  const { readFileSync } = await import('node:fs');
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

  /* ================================================================
     A SEQUÊNCIA REAL DA ASAAS — medida em 15/09/2026, sandbox

     O `CHECKOUT_PAID` NÃO traz o id do pagamento. Ele chega 279 ms
     depois, no `PAYMENT_CONFIRMED`, com `checkoutSession` apontando de
     volta para a sessão. Até esta correção, a cobrança ficava
     `confirmado` com `charge_id` nulo para sempre — e com ela morriam o
     cancelamento e TODOS os ciclos seguintes da assinatura.
     ================================================================ */

  const CHECKOUT_PAID_REAL = { event: 'CHECKOUT_PAID', checkout: { id: 'chk_real', status: 'PAID' } };

  /* `ciclo: 'QUARTERLY'` já está na linha DESDE A CRIAÇÃO —
     `criarCheckoutAssinatura` valida e grava (`registrarCobrancaPendentePopup`)
     antes de existir qualquer sessão na Asaas, então antes de qualquer
     webhook poder chegar. Nenhum dos dois eventos abaixo precisa
     carregar ciclo — e por isso nenhum dos dois testa `payment.cycle`
     nem `checkout.subscription.cycle`: essa fonte não existe mais no
     código, e não devia aparecer nos testes como se existisse. */
  const cobrancaAssinaturaCrua = {
    ...cobrancaPix, metodo_pagamento: 'assinatura', charge_id: null,
    asaas_checkout_id: 'chk_real', plano_id: 'plano_x', documento: '52998224725',
    contratante_id: 'mostrai', substitui_assinatura_id: null, ciclo: 'QUARTERLY'
  };

  // Passo 1 — o evento de checkout sozinho: confirma e manda 'criada'.
  deps = depsFalsas({ buscarCobrancaPorCheckoutId: cobrancaAssinaturaCrua });
  await processarWebhook(CHECKOUT_PAID_REAL, deps);
  assert.equal(deps.chamou('vincularChargeIdAoCheckout').length, 0, 'sem payment no corpo: não há charge para vincular');
  assert.deepEqual(deps.chamou('atualizarStatusPorCheckoutId')[0].args, ['chk_real', 'confirmado']);
  assert.equal(deps.chamou('notificar').length, 1, 'assinatura avisa mesmo sem chargeId — o evento criada não carrega esse campo (API.md §4.3.4)');
  assert.equal(deps.chamou('notificar')[0].args[1].evento, 'criada');

  // Passo 2 — o evento de pagamento fecha o vínculo que faltava.
  deps = depsFalsas({
    buscarCobranca: null,
    buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, status: 'confirmado' }
  });
  await processarWebhook({
    event: 'PAYMENT_CONFIRMED',
    // SEM `cycle` no payment — de propósito. É exatamente o payload
    // real: PAYMENT_CONFIRMED não carrega ciclo nenhum. Se este teste
    // ainda assim provar o ciclo certo, é `cobranca.ciclo` funcionando,
    // não um acidente de fallback.
    payment: { id: 'pay_real', subscription: 'sub_real', checkoutSession: 'chk_real' }
  }, deps);

  assert.equal(
    deps.chamou('vincularChargeIdAoCheckout').length, 1,
    'ESTE É O BUG DE 15/09: sem vincular aqui, a cobrança fica confirmado com charge_id nulo para sempre — e com ela morrem o /cancelar-assinatura e todos os ciclos seguintes'
  );
  assert.deepEqual(
    deps.chamou('vincularChargeIdAoCheckout')[0].args, ['chk_real', 'pay_real'],
    'o charge_id que o CHECKOUT_PAID não tinha é gravado aqui'
  );
  assert.equal(
    deps.chamou('atualizarSubscriptionIdDaCobranca').length, 1,
    'o vínculo da assinatura precisa ser gravado aqui — sem ele, todo ciclo seguinte fica órfão'
  );
  assert.deepEqual(
    deps.chamou('atualizarSubscriptionIdDaCobranca')[0].args, ['pay_real', 'sub_real']
  );
  assert.equal(deps.chamou('upsertAssinatura').length, 1, 'a linha em assinaturas nasce aqui (é o que o /cancelar-assinatura procura)');
  assert.equal(deps.chamou('upsertAssinatura')[0].args[0].id, 'sub_real');
  assert.equal(
    deps.chamou('upsertAssinatura')[0].args[0].ciclo, 'QUARTERLY',
    'o ciclo vem de cobranca.ciclo (gravado na CRIAÇÃO do checkout, não em nenhum webhook) — achado ao verificar ' +
    'o reparo da cobrança do mostrai, que tinha ficado MONTHLY quando o plano é QUARTERLY'
  );

  /* --- Sem ciclo gravado (linha antiga, de antes desta correção),
     cai no fallback morto de payment.cycle, e por fim em null. Nunca
     quebra — só fica sem o dado, que é o estado de sempre. --------- */
  deps = depsFalsas({
    buscarCobranca: null,
    buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, status: 'confirmado', ciclo: null }
  });
  await processarWebhook({
    event: 'PAYMENT_CONFIRMED',
    payment: { id: 'pay_sem_ciclo', subscription: 'sub_sem_ciclo', checkoutSession: 'chk_real' }
  }, deps);
  assert.equal(
    deps.chamou('upsertAssinatura')[0].args[0].ciclo, null,
    'sem cobranca.ciclo e sem payment.cycle (que não existe no payload real), o resultado é null — nunca inventa valor'
  );

  // E o mais caro: NÃO notifica de novo.
  deps = depsFalsas({
    buscarCobranca: null,
    buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, status: 'confirmado' }
  });
  await processarWebhook({
    event: 'PAYMENT_CONFIRMED',
    payment: { id: 'pay_real2', subscription: 'sub_real2', checkoutSession: 'chk_real' }
  }, deps);
  assert.equal(
    deps.chamou('notificar').length, 0,
    'o criada já saiu no CHECKOUT_PAID; um cobranca_confirmada aqui descreveria o MESMO ciclo duas vezes, e o API.md §11 manda creditar nos dois'
  );

  /* --- A guarda que impede o ciclo 2 de sobrescrever a 1ª cobrança ---
     Não está confirmado que `checkoutSession` só apareça na primeira
     cobrança. Se a Asaas mandar o mesmo ponteiro todo mês, sem esta
     guarda o charge_id da linha-modelo seria trocado a cada ciclo. */
  /* `buscarCobranca` devolve null na 1ª chamada (o ciclo ainda não
     existe) e a linha nova na 2ª — que é a releitura que
     `registrarNovoCicloAssinatura` faz depois de inserir. Um dublê que
     devolvesse null sempre esconderia a notificação do ciclo. */
  const cicloNovo = { ...cobrancaAssinaturaCrua, charge_id: 'pay_ciclo2', status: 'pendente' };
  let leiturasDoCiclo = 0;
  deps = depsFalsas({
    buscarCobranca: () => (leiturasDoCiclo++ === 0 ? null : cicloNovo),
    buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, charge_id: 'pay_real', status: 'confirmado' },
    buscarCobrancaPorSubscriptionId: { ...cobrancaAssinaturaCrua, charge_id: 'pay_real' }
  });
  await processarWebhook({
    event: 'PAYMENT_CONFIRMED',
    payment: { id: 'pay_ciclo2', subscription: 'sub_real', checkoutSession: 'chk_real' }
  }, deps);
  assert.equal(
    deps.chamou('vincularChargeIdAoCheckout').length, 0,
    'cobrança já vinculada: o ciclo novo NÃO sobrescreve o charge_id da primeira'
  );
  assert.equal(deps.chamou('registrarCicloAssinatura').length, 1, 'ele vira um ciclo novo, que é o caminho certo');
  assert.equal(
    deps.chamou('notificar')[0].args[1].evento, 'cobranca_confirmada',
    'e o ciclo novo SIM anuncia cobranca_confirmada'
  );

  /* --- Pedido avulso pela pop-up: mesmo furo, e ele notifica ---------
     Cartão avulso sofria do mesmo problema, com um agravante: o payload
     de pedido CARREGA chargeId, e a chave de idempotência do §4.3.6 é
     chargeId+status. O aviso saía com chargeId nulo — impossível de
     deduplicar. */
  const cobrancaCartaoCrua = {
    ...cobrancaPix, metodo_pagamento: 'cartao', charge_id: null, asaas_checkout_id: 'chk_cart'
  };

  deps = depsFalsas({ buscarCobrancaPorCheckoutId: cobrancaCartaoCrua });
  await processarWebhook({ event: 'CHECKOUT_PAID', checkout: { id: 'chk_cart' } }, deps);
  assert.deepEqual(deps.chamou('atualizarStatusPorCheckoutId')[0].args, ['chk_cart', 'confirmado'], 'o dinheiro entrou: o status é gravado de qualquer jeito');
  assert.equal(
    deps.chamou('notificar').length, 0,
    'pedido sem chargeId não vira aviso: o contratante não conseguiria deduplicar (§4.3.6)'
  );

  deps = depsFalsas({ buscarCobranca: null, buscarCobrancaPorCheckoutId: { ...cobrancaCartaoCrua, status: 'confirmado' } });
  await processarWebhook({
    event: 'PAYMENT_CONFIRMED',
    payment: { id: 'pay_cart', checkoutSession: 'chk_cart' }
  }, deps);
  assert.equal(deps.chamou('vincularChargeIdAoCheckout').length, 1, 'cartão avulso pela pop-up sofria do mesmo furo');
  assert.deepEqual(deps.chamou('vincularChargeIdAoCheckout')[0].args, ['chk_cart', 'pay_cart']);
  assert.equal(deps.chamou('upsertAssinatura').length, 0, 'cartão avulso não cria assinatura');
  assert.equal(deps.chamou('notificar').length, 1, 'aqui SIM o aviso sai — agora com o chargeId de verdade');
  assert.equal(deps.chamou('notificar')[0].args[1].chargeId, 'pay_cart');

  /* --- A supressão vale SÓ para a confirmação ----------------------
     Engolir qualquer evento seria pior que o bug: um estorno que chega
     antes de a cobrança estar vinculada não tem par no CHECKOUT_PAID
     para duplicar, e o contratante nunca ficaria sabendo. */
  deps = depsFalsas({
    buscarCobranca: null,
    buscarCobrancaPorCheckoutId: cobrancaAssinaturaCrua
  });
  await processarWebhook({
    event: 'PAYMENT_REFUNDED',
    payment: { id: 'pay_estorno', subscription: 'sub_real', checkoutSession: 'chk_real' }
  }, deps);
  assert.equal(deps.chamou('vincularChargeIdAoCheckout').length, 1, 'vincula igual');
  assert.equal(
    deps.chamou('notificar').length, 1,
    'mas o estorno SAI — só a confirmação é engolida, porque só ela tem par no criada'
  );
  assert.equal(deps.chamou('notificar')[0].args[1].evento, 'cobranca_estornada');

  /* --- Ordem invertida: o pagamento antes do checkout ---------------
     NÃO É MAIS UM PROBLEMA, e é o efeito colateral bom de tirar `ciclo`
     do webhook: `cobrancaAssinaturaCrua.ciclo` já está na linha desde
     a CRIAÇÃO do checkout, antes de qualquer um dos dois eventos
     poder chegar — então a ordem entre eles deixou de importar pra
     esse dado. Isto teria sido um residual real se `ciclo` continuasse
     vindo de dentro do CHECKOUT_PAID (era o desenho até um commit
     atrás desta correção); a simplificação eliminou a corrida junto
     com a complexidade. */
  deps = depsFalsas({
    buscarCobranca: null,
    buscarCobrancaPorCheckoutId: cobrancaAssinaturaCrua // status 'pendente' — CHECKOUT_PAID ainda não rodou
  });
  await processarWebhook({
    event: 'PAYMENT_CONFIRMED',
    payment: { id: 'pay_antes', subscription: 'sub_antes', checkoutSession: 'chk_real' }
  }, deps);
  assert.equal(deps.chamou('vincularChargeIdAoCheckout').length, 1, 'vincula mesmo se o pagamento chegar primeiro');
  assert.equal(deps.chamou('notificar').length, 0, 'e continua sem duplicar o criada, que virá no CHECKOUT_PAID');
  assert.equal(
    deps.chamou('upsertAssinatura')[0].args[0].ciclo, 'QUARTERLY',
    'o ciclo certo, mesmo com o pagamento chegando ANTES do checkout — porque não depende da ordem dos dois'
  );

  /* ================================================================
     RENOVAÇÃO ABANDONADA NÃO É A ASSINATURA SENDO CANCELADA

     Achado em 15/09/2026, auditando o caminho inteiro: abandonar o
     pop-up de troca de cartão (`&renovar=1`) mandava `evento: 'cancelada'`
     pro contratante — mas a assinatura ANTIGA está intocada, ativa,
     ainda sendo cobrada. O payload é identificado só por
     planoId+documento (API.md §4.3.4): o contratante não tem como
     distinguir isso de "o cliente cancelou de verdade", e revogaria
     acesso de quem ainda paga.
     ================================================================ */

  // Caso 1: assinatura NOVA (não é renovação) abandonada no pop-up —
  // continua mandando `cancelada`, como sempre (API.md §4.3.5).
  deps = depsFalsas({
    buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, substitui_assinatura_id: null }
  });
  await processarWebhook({ event: 'CHECKOUT_CANCELED', checkout: { id: 'chk_real' } }, deps);
  assert.equal(deps.chamou('notificar').length, 1, 'assinatura nova abandonada: continua avisando cancelada');
  assert.equal(deps.chamou('notificar')[0].args[1].evento, 'cancelada');

  // Caso 2: RENOVAÇÃO abandonada — a antiga continua ativa. NÃO avisa.
  deps = depsFalsas({
    buscarCobrancaPorCheckoutId: { ...cobrancaAssinaturaCrua, substitui_assinatura_id: 'sub_antiga_intocada' }
  });
  await processarWebhook({ event: 'CHECKOUT_CANCELED', checkout: { id: 'chk_real' } }, deps);
  assert.equal(
    deps.chamou('notificar').length, 0,
    'ESTE É O BUG: renovação abandonada não pode mandar cancelada — a assinatura antiga (sub_antiga_intocada) ' +
    'continua ativa, e o contratante não tem como diferenciar isso de um cancelamento de verdade'
  );
  assert.deepEqual(
    deps.chamou('atualizarStatusPorCheckoutId')[0].args, ['chk_real', 'cancelado'],
    'mas o NOSSO registro da tentativa de renovação continua sendo marcado cancelado — só o aviso é que não sai'
  );

  /* --- Pix/boleto direto não passa por aqui ------------------------- */
  deps = depsFalsas({ buscarCobranca: cobrancaPix });
  await processarWebhook({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1' } }, deps);
  assert.equal(
    deps.chamou('buscarCobrancaPorCheckoutId').length, 0,
    'cobrança achada pelo charge_id: o caminho da pop-up nem é tocado'
  );
  assert.equal(deps.chamou('notificar').length, 1, 'e o Pix direto segue notificando como sempre');

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

  /* ================================================================
     CONTRATANTE PENDURADO NÃO PODE PAUSAR A FILA DE TODO MUNDO

     O receptor faz `await processarWebhook(...)` antes de responder
     `200`, e essa cadeia chega ao endpoint do contratante. Se a
     notificação for aguardada, um parceiro que aceita a conexão e nunca
     responde segura a NOSSA resposta à Asaas — que conta lentidão como
     falha e pausa a fila da conta inteira depois de 15 seguidas
     (CONSTRAINTS.md §2.3). Um contratante quebrado derrubaria a
     confirmação de pagamento de todos os outros.

     Este teste sobe um servidor que faz exatamente isso: aceita e cala.
     ================================================================ */
  {
    const http = await import('node:http');

    const conexoesAbertas = [];
    const servidorMudo = http.createServer((_req, _res) => {
      // aceita e nunca responde — de propósito
    });
    servidorMudo.on('connection', (socket) => conexoesAbertas.push(socket));
    await new Promise((resolve) => servidorMudo.listen(0, '127.0.0.1', resolve));
    const enderecoMudo = `http://127.0.0.1:${servidorMudo.address().port}/hook`;

    const comecou = Date.now();
    await dependenciasPadrao.notificar(enderecoMudo, { versao: 1, teste: true }, 'segredo-de-teste');
    const gastou = Date.now() - comecou;

    assert.ok(
      gastou < 500,
      `a notificação segurou o fluxo por ${gastou}ms — um contratante pendurado atrasaria a resposta à Asaas, e 15 dessas pausam a fila de TODOS os contratantes`
    );

    // E o teto por tentativa existe: sem ele o socket ficaria pendurado
    // para sempre, mesmo fora do fluxo.
    const fonte = readFileSync(new URL(import.meta.url), 'utf8');
    const corpoTentar = fonte.slice(fonte.indexOf('async function tentarNotificar('));
    assert.ok(
      corpoTentar.slice(0, corpoTentar.indexOf('\n}')).includes('signal: controlador.signal'),
      'tentarNotificar precisa abortar por timeout — fetch sem signal fica pendurado para sempre no endereço de um terceiro'
    );

    for (const socket of conexoesAbertas) socket.destroy();
    await new Promise((resolve) => servidorMudo.close(resolve));
  }

  console.log('webhookController: caminho crítico OK');
}
