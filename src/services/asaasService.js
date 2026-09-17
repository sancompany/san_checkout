/**
 * SAN CHECKOUT v2 — src/services/asaasService.js
 * Toda chamada real à API da Asaas passa por aqui.
 *
 * AVISO DE CONHECIMENTO: os nomes de campo/endpoints abaixo seguem a
 * documentação mais recente consultada nesta conversa (server base
 * https://api-sandbox.asaas.com, paths /v3/...). Se algo vier com erro
 * de campo desconhecido, confira https://docs.asaas.com antes de mexer
 * em outra coisa.
 */

import { getConfigAsaas, montarCallbackPadrao } from '../config/asaas.js';

/**
 * O que a Asaas respondeu, em uma linha legível — SEM dado de pessoa.
 *
 * Existe porque `Asaas respondeu 403` não é diagnóstico: foi exatamente
 * o que a tela mostrou quando a criação de subconta falhou em
 * 12/09/2026, e a razão real ficou dentro de um corpo que ninguém via.
 * O formato `{errors:[{code, description}]}` é o comum, mas nem todo
 * erro da Asaas vem assim — 401 e 403, em particular, costumam vir com
 * outra forma, e é justamente aí que a mensagem some.
 *
 * Redigido pela Lei 10: a resposta pode ecoar o que foi enviado
 * (documento, e-mail, telefone). Sequência de 8+ dígitos e endereço de
 * e-mail saem; texto longo é cortado.
 */
function resumirRespostaAsaas(corpo) {
  const limpar = (texto) => String(texto)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\d[\d.\-/\s]{7,}\d/g, '[numero]')
    .slice(0, 300);

  const erros = Array.isArray(corpo?.errors) ? corpo.errors : null;
  if (erros?.length) {
    return erros
      .map((e) => limpar([e?.code, e?.description].filter(Boolean).join(': ') || JSON.stringify(e)))
      .join(' | ');
  }

  // Sem o formato conhecido: entrega o que der, ainda redigido. Chaves
  // vazias viram '(corpo vazio)' — que também é informação: quer dizer
  // que a recusa veio sem explicação nenhuma.
  const texto = limpar(JSON.stringify(corpo ?? {}));
  return texto === '{}' || texto === 'null' ? '(corpo vazio)' : texto;
}

/**
 * Teto para TODA chamada à Asaas.
 *
 * Sem ele, `fetch` espera para sempre: a Asaas fora do ar (ou uma
 * conexão que morre sem RST) pendurava indefinidamente o pedido do
 * comprador esperando o QR Code, a consulta de status, o estorno e o
 * cancelamento de assinatura — todos passam por aqui. O navegador
 * desistia sozinho e o servidor continuava segurando o socket.
 *
 * 20 s: acima do pior tempo real observado em sandbox e bem abaixo da
 * paciência de quem está com o cartão na mão. Falhar rápido e dizer o
 * que houve é melhor que pendurar — quem chama já trata o erro.
 */
const TIMEOUT_ASAAS_MS = 20_000;

async function chamarAsaas(caminho, opcoes = {}) {
  const { baseUrl, headers } = getConfigAsaas();

  const controlador = new AbortController();
  const timeoutId = setTimeout(() => controlador.abort(), TIMEOUT_ASAAS_MS);

  let resposta;
  try {
    resposta = await fetch(`${baseUrl}${caminho}`, {
      ...opcoes,
      headers: { ...headers, ...(opcoes.headers ?? {}) },
      signal: controlador.signal
    });
  } catch (erroRede) {
    // `AbortError` vira mensagem de gente, não rastro de biblioteca.
    if (erroRede.name === 'AbortError') {
      const erro = new Error('A Asaas não respondeu a tempo. Tente de novo em instantes.');
      erro.status = 504;
      throw erro;
    }
    throw erroRede;
  } finally {
    clearTimeout(timeoutId);
  }

  const corpo = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    const resumo = resumirRespostaAsaas(corpo);
    const descricao = corpo.errors?.[0]?.description || `${resposta.status} — ${resumo}`;

    // No log SEMPRE, mesmo quando a descrição chega bonita na tela: é o
    // único lugar que guarda a rota e o status juntos.
    console.error(`[asaas] ${opcoes.method ?? 'GET'} ${caminho} → ${resposta.status}: ${resumo}`);

    const erro = new Error(descricao);
    erro.status = resposta.status;
    erro.corpoAsaas = corpo;
    erro.resumoAsaas = resumo;
    throw erro;
  }

  return corpo;
}

/**
 * O tipo de pessoa da conta-mãe, para explicar uma recusa de subconta.
 * Não entra em nenhum caminho de cobrança.
 *
 * ── Lê DOIS endpoints, e a diferença entre eles é o ponto ───────────
 * A Asaas guarda duas identidades separadas, e elas podem discordar:
 *
 *   `/v3/myAccount`                — o REGISTRO da conta
 *   `/v3/myAccount/commercialInfo` — as informações COMERCIAIS enviadas
 *
 * Medido no sandbox em 17/09/2026: o registro vinha `FISICA` com CPF
 * enquanto o comercial vinha `JURIDICA` com CNPJ, na mesma conta, com
 * `commercialInfo: APPROVED`. Preencher o CNPJ da empresa nas
 * informações comerciais **não converte** a conta em pessoa jurídica.
 *
 * **A regra de subconta olha o REGISTRO.** Até 17/09 esta função lia só
 * o comercial, via JURIDICA, e mandava o operador dizer ao suporte que
 * o tipo de conta não era o problema — quando era exatamente ele. Isso
 * custou uma investigação inteira no rastro errado
 * (`docs/erros/2026-09-17-diagnostico-de-subconta-lia-o-endpoint-errado.md`).
 *
 * A leitura de cada um continua DEFENSIVA: a doc da Asaas não publica o
 * schema, então o tipo sai de dois sinais independentes — `personType`,
 * se vier, e a contagem de dígitos do documento (11 = CPF, 14 = CNPJ).
 */
function classificar(corpo) {
  const digitos = String(corpo?.cpfCnpj ?? '').replace(/\D/g, '');
  if (corpo?.personType === 'FISICA' || digitos.length === 11) return 'fisica';
  if (corpo?.personType === 'JURIDICA' || digitos.length === 14) return 'juridica';
  return 'desconhecido';
}

export async function tipoDaContaMae() {
  const registro = await chamarAsaas('/v3/myAccount', { method: 'GET' });

  // O comercial é complemento, não fonte: se falhar, o registro já
  // responde a pergunta que importa.
  let comercial = null;
  try {
    comercial = await chamarAsaas('/v3/myAccount/commercialInfo', { method: 'GET' });
  } catch { /* segue com o registro */ }

  const tipo = classificar(registro);
  const tipoComercial = comercial ? classificar(comercial) : 'desconhecido';

  return {
    tipo,
    tipoComercial,
    // `divergem` é o que explica a confusão: conta PF com comercial PJ
    // parece PJ em todo lugar do painel, menos na regra de subconta.
    divergem: tipo !== 'desconhecido' && tipoComercial !== 'desconhecido' && tipo !== tipoComercial,
    companyType: comercial?.companyType ?? registro?.companyType ?? null
  };
}

/** Busca cliente por CPF/CNPJ; cria se não existir. */
export async function buscarOuCriarCliente({ nome, email, documento }) {
  const busca = await chamarAsaas(`/v3/customers?cpfCnpj=${documento}`, { method: 'GET' });
  if (busca.data?.length) return busca.data[0].id;

  // `notificationDisabled: true` é obrigatório aqui: sem isso a Asaas
  // liga 8 notificações automáticas por cliente (e-mail e SMS), e passa
  // a cobrar o comprador EM NOME DELA — o que quebra o whitelabel (o
  // comprador nunca ouviu falar da Asaas), gera custo por SMS/voz, e
  // contraria a decisão já tomada neste projeto de que o e-mail ao
  // pagador é responsabilidade de cada contratante (foi por isso que o
  // emailService.js foi removido).
  //
  // Vale só pra cliente NOVO. Cliente que já existe na conta Asaas
  // mantém as notificações que tinha — ver scripts/desligar-notificacoes-asaas.js.
  const novo = await chamarAsaas('/v3/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: nome,
      email,
      cpfCnpj: documento,
      externalReference: documento,
      notificationDisabled: true
    })
  });

  return novo.id;
}

/**
 * Taxas reais DESTA conta Asaas (`GET /v3/myAccount/fees/`).
 *
 * Existe pra que `taxaService.js` pare de depender só da tabela
 * chumbada: no dia em que a Asaas reajustar, ou em que uma taxa melhor
 * for negociada por volume, a tabela fixa continuaria cobrando o número
 * velho do comprador — sem erro nenhum, silenciosamente.
 *
 * Os nomes de campo abaixo vieram da definição OpenAPI publicada da
 * Asaas (schema `MyAccountGetAccountFeesResponseDTO`), não de chute.
 * Cada método tem forma própria — Pix pode ser taxa fixa OU percentual
 * com piso e teto, cartão vem por faixa de parcela.
 */
export async function buscarTaxasDaConta() {
  const taxas = await chamarAsaas('/v3/myAccount/fees/', { method: 'GET' });
  return taxas?.payment ?? null;
}

function dataDeHoje() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Status da Asaas em que a cobrança ainda pode ser paga — ou seja, em
 * que faz sentido devolver a MESMA cobrança pro comprador em vez de
 * criar outra. Qualquer outro status (RECEIVED, CONFIRMED, REFUNDED,
 * OVERDUE...) significa que aquela cobrança acabou, e uma nova pode ser
 * criada.
 */
const STATUS_AINDA_PAGAVEL = ['PENDING', 'AWAITING_RISK_ANALYSIS'];

/**
 * Cria uma cobrança Pix e já busca o QR Code.
 * @param {{ clienteId, valor, descricao, referenciaExterna, split? }} dados
 */
export async function criarCobrancaPix({ clienteId, valor, descricao, referenciaExterna, split }) {
  const cobranca = await chamarAsaas('/v3/payments', {
    method: 'POST',
    body: JSON.stringify({
      customer: clienteId,
      billingType: 'PIX',
      value: valor,
      dueDate: dataDeHoje(),
      description: descricao,
      externalReference: referenciaExterna,
      ...(split ? { split } : {})
    })
  });

  const qr = await chamarAsaas(`/v3/payments/${cobranca.id}/pixQrCode`, { method: 'GET' });

  return {
    chargeId: cobranca.id,
    qrCodeBase64: qr.encodedImage,
    copiaECola: qr.payload
  };
}

const DIAS_VENCIMENTO_BOLETO = 3; // API.md §6.1 (o que o boleto exige do comprador)

function dataVencimentoBoleto() {
  const data = new Date();
  data.setDate(data.getDate() + DIAS_VENCIMENTO_BOLETO);
  return data.toISOString().slice(0, 10);
}

/**
 * Cria uma cobrança de Boleto DIRETO (POST /v3/payments), sem passar
 * pelo Asaas Checkout — confirmado em sandbox que o Asaas Checkout só
 * aceita billingTypes CREDIT_CARD/PIX, Boleto não é suportado por ele.
 * Isso não reabre exposição de PCI (Boleto nunca envolve dado de
 * cartão) — só muda a exibição de pop-up pra inline, igual o Pix já
 * faz.
 * @param {{ clienteId, valor, descricao, referenciaExterna, split? }} dados
 */
export async function criarCobrancaBoleto({ clienteId, valor, descricao, referenciaExterna, split }) {
  const cobranca = await chamarAsaas('/v3/payments', {
    method: 'POST',
    body: JSON.stringify({
      customer: clienteId,
      billingType: 'BOLETO',
      value: valor,
      dueDate: dataVencimentoBoleto(),
      description: descricao,
      externalReference: referenciaExterna,
      ...(split ? { split } : {})
    })
  });

  // ⚠️ NÃO CONFIRMADO em sandbox: nome exato dos campos devolvidos por
  // GET /v3/payments/{id}/identificationField. Tenta os nomes mais
  // comuns da API da Asaas; se vier diferente, ainda sobra o
  // bankSlipUrl (link do boleto), que a própria criação já devolve —
  // a linha digitável aqui é só um extra de copia-e-cola.
  let linhaDigitavel = null;
  let codigoBarras = null;
  try {
    const identificacao = await chamarAsaas(`/v3/payments/${cobranca.id}/identificationField`, { method: 'GET' });
    linhaDigitavel = identificacao?.identificationField ?? null;
    codigoBarras = identificacao?.barCode ?? null;
  } catch (erroIdentificacao) {
    console.error('[asaasService.criarCobrancaBoleto] falha ao buscar linha digitável:', erroIdentificacao.message);
  }

  return {
    chargeId: cobranca.id,
    boletoUrl: cobranca.bankSlipUrl ?? null,
    linhaDigitavel,
    codigoBarras,
    vencimento: cobranca.dueDate ?? null
  };
}

/**
 * Cria uma sessão Asaas Checkout (pop-up hospedada) — usada por
 * Cartão, Boleto e Assinatura. Devolve o id da sessão; a URL de
 * exibição é montada por `montarUrlCheckoutSession` (config/asaas.js),
 * porque o domínio muda por ambiente.
 *
 * @param {object} params
 * @param {string[]} params.billingTypes — ex: ['CREDIT_CARD'], ['BOLETO']
 * @param {string[]} params.chargeTypes — ex: ['DETACHED'] ou ['DETACHED','INSTALLMENT'] ou ['RECURRENT']
 * @param {Array<{name:string, description?:string, quantity:number, value:number}>} params.itens
 * @param {object} [params.installment] — { maxInstallmentCount } quando aceitar parcelamento
 * @param {object} [params.subscription] — { cycle, nextDueDate, endDate } quando RECURRENT
 * @param {object} [params.customerData] — pré-preenche nome/e-mail/CPF na pop-up
 * @param {Array} [params.splits]
 * @param {number} params.minutesToExpire
 */
export async function criarSessaoAsaasCheckout({
  billingTypes,
  chargeTypes,
  itens,
  installment,
  subscription,
  customerData,
  splits,
  minutesToExpire = 60
}) {
  const resposta = await chamarAsaas('/v3/checkouts', {
    method: 'POST',
    body: JSON.stringify({
      billingTypes,
      chargeTypes,
      minutesToExpire,
      items: itens,
      callback: montarCallbackPadrao(),
      ...(installment ? { installment } : {}),
      ...(subscription ? { subscription } : {}),
      ...(customerData ? { customerData } : {}),
      ...(splits ? { splits } : {})
    })
  });

  return { asaasCheckoutId: resposta.id };
}

/** Status atual de uma cobrança. */
export async function consultarStatus(chargeId) {
  const cobranca = await chamarAsaas(`/v3/payments/${chargeId}`, { method: 'GET' });
  return { status: cobranca.status };
}

/**
 * Recupera uma cobrança Pix já criada — QR e copia-e-cola de novo, sem
 * criar outra. Usado quando o comprador volta pra página de um pedido
 * que já tem Pix pendente.
 *
 * Devolve `null` se a cobrança não estiver mais pagável (paga,
 * estornada, vencida, removida) — aí o chamador cria uma nova.
 */
export async function recuperarCobrancaPix(chargeId) {
  const cobranca = await chamarAsaas(`/v3/payments/${chargeId}`, { method: 'GET' });
  if (!STATUS_AINDA_PAGAVEL.includes(cobranca.status)) return null;

  const qr = await chamarAsaas(`/v3/payments/${chargeId}/pixQrCode`, { method: 'GET' });
  return {
    chargeId: cobranca.id,
    status: cobranca.status,
    qrCodeBase64: qr.encodedImage,
    copiaECola: qr.payload
  };
}

/**
 * Equivalente pro boleto. `bankSlipUrl` e vencimento vêm da própria
 * cobrança; a linha digitável é buscada como na criação.
 */
export async function recuperarCobrancaBoleto(chargeId) {
  const cobranca = await chamarAsaas(`/v3/payments/${chargeId}`, { method: 'GET' });
  if (!STATUS_AINDA_PAGAVEL.includes(cobranca.status)) return null;

  let linhaDigitavel = null;
  let codigoBarras = null;
  try {
    const identificacao = await chamarAsaas(`/v3/payments/${chargeId}/identificationField`, { method: 'GET' });
    linhaDigitavel = identificacao?.identificationField ?? null;
    codigoBarras = identificacao?.barCode ?? null;
  } catch (erroIdentificacao) {
    console.error('[asaasService.recuperarCobrancaBoleto] falha ao buscar linha digitável:', erroIdentificacao.message);
  }

  return {
    chargeId: cobranca.id,
    status: cobranca.status,
    boletoUrl: cobranca.bankSlipUrl ?? null,
    linhaDigitavel,
    codigoBarras,
    vencimento: cobranca.dueDate ?? null
  };
}

/**
 * Estorna uma cobrança (tudo ou nada — nunca parcial nesta versão).
 * A Asaas permite parcial de verdade, mas o San Checkout não usa isso.
 *
 * Boleto usa um ENDPOINT DIFERENTE e um fluxo ASSÍNCRONO (confirmado
 * na doc da Asaas): a chamada abaixo só INICIA o estorno — o pagador
 * ainda precisa preencher um link bancário antes do dinheiro voltar
 * de verdade. Pix/Cartão continuam síncronos, mesmo endpoint de
 * sempre. Ver `refundController.js`, que usa `assincrono` pra decidir
 * entre os status locais `estornado` e `estorno_solicitado`
 * (API.md §5.4).
 * @param {string} chargeId
 * @param {{ metodoPagamento?: string }} [opcoes]
 */
export async function estornarCobranca(chargeId, { metodoPagamento } = {}) {
  const assincrono = metodoPagamento === 'boleto';
  const caminho = assincrono
    ? `/v3/payments/${chargeId}/bankSlip/refund`
    : `/v3/payments/${chargeId}/refund`;

  const resultado = await chamarAsaas(caminho, {
    method: 'POST',
    body: JSON.stringify({})
  });

  return { status: resultado.status, assincrono };
}

/**
 * Cancela uma assinatura (RECURRENT) — para a geração de novas
 * cobranças a partir daí (cobranças já geradas/pagas não são afetadas).
 * `DELETE /v3/subscriptions/{id}` — confirmado na doc da Asaas.
 */
export async function cancelarAssinatura(subscriptionId) {
  return chamarAsaas(`/v3/subscriptions/${subscriptionId}`, { method: 'DELETE' });
}

/**
 * Estado ATUAL da assinatura na Asaas — `GET /v3/subscriptions/{id}`.
 *
 * Existe pra reconciliação (`consultarAssinatura`, API.md §5.3): o nosso
 * banco só sabe o que uma chamada nossa conseguiu confirmar, e se o
 * `DELETE`/`PUT` foi processado lá mas a resposta se perdeu no caminho
 * (timeout, ver `TIMEOUT_ASAAS_MS`), `assinaturas.status` fica
 * desatualizado pra sempre, sem nada que detecte.
 *
 * ⚠️ MEDIDO AO VIVO em 16/09/2026, contra o sandbox, e o resultado
 * derrubou a leitura ingênua: uma assinatura **cancelada por `DELETE`
 * responde `200`** (não 404) com `deleted: true` **e
 * `status: "INACTIVE"` — o MESMO status de uma assinatura pausada.**
 * Quem distingue cancelada de pausada é só o `deleted`; mapear pelo
 * `status` sozinho marcaria toda assinatura cancelada como `pausada`.
 * Por isso `encerrada` olha `deleted` ANTES do status.
 *
 * Medição (sub_qut6521d50496vkn, cancelada nesta mesma data):
 *   `{ deleted: true, status: "INACTIVE", cycle: "YEARLY", nextDueDate: … }`
 * contra a ativa do MostrAí (sub_xjsad6cpqor5pars):
 *   `{ deleted: false, status: "ACTIVE", cycle: "QUARTERLY", … }`
 *
 * O ramo do `404` fica: não é o que uma assinatura deletada devolve,
 * mas continua sendo o que um id de OUTRA conta (ou inexistente)
 * devolve — e esse não pode virar "cancelada" automática.
 *
 *   - objeto com `deleted: true`  → `{ encerrada: true }`
 *   - `404`                       → `null` (quem chama decide)
 *   - qualquer outro erro         → propaga (rede, 401, 5xx)
 *
 * @returns {Promise<{status: string, deleted: boolean, encerrada: boolean, proximaCobranca: string|null}|null>}
 */
export async function consultarAssinaturaNaAsaas(subscriptionId) {
  let corpo;
  try {
    corpo = await chamarAsaas(`/v3/subscriptions/${subscriptionId}`, { method: 'GET' });
  } catch (erro) {
    if (erro.status === 404) return null;
    throw erro;
  }

  const status = corpo?.status ?? null;
  const deleted = corpo?.deleted === true;

  return {
    status,
    deleted,
    // `EXPIRED` é a assinatura que chegou ao fim (endDate/maxPayments) —
    // pro nosso vocabulário, encerrada do mesmo jeito que a deletada.
    encerrada: deleted || status === 'EXPIRED',
    proximaCobranca: corpo?.nextDueDate ?? null,
    // Quem cobra é a Asaas: se o `ciclo` do nosso registro divergir
    // deste, o errado é o nosso (foi o caso das assinaturas nascidas
    // antes da correção de 15/09, gravadas como MONTHLY).
    ciclo: corpo?.cycle ?? null
  };
}

/**
 * Pausa ou retoma uma assinatura — `PUT /v3/subscriptions/{id}` com
 * `status: INACTIVE | ACTIVE` (enum confirmado na definição OpenAPI da
 * Asaas: `SubscriptionUpdateRequestSubscriptionStatus`).
 *
 * Pausar NÃO é cancelar: cancelar (DELETE) é definitivo, e o assinante
 * teria que assinar de novo do zero. Pausado, o mesmo vínculo volta a
 * cobrar quando for reativado.
 *
 * @param {'INACTIVE'|'ACTIVE'} status
 */
export async function alterarStatusAssinatura(subscriptionId, status) {
  return chamarAsaas(`/v3/subscriptions/${subscriptionId}`, {
    method: 'PUT',
    body: JSON.stringify({ status })
  });
}

/* ------------------------------------------------------------------
   Pix Automático — recorrência SEM cartão
------------------------------------------------------------------ */

/**
 * Ciclo do plano (vocabulário da assinatura por cartão) → frequência do
 * Pix Automático.
 *
 * ⚠️ Os dois vocabulários NÃO são iguais, e é uma armadilha silenciosa:
 * a assinatura por cartão usa `YEARLY`, o Pix Automático usa
 * `ANNUALLY`. E o Pix Automático não tem quinzenal nem bimestral. Por
 * isso este mapa é explícito e o que não estiver aqui é recusado com
 * mensagem clara, em vez de virar erro obscuro da Asaas.
 *
 * Enum confirmado na definição OpenAPI
 * (`...SaveRequestPixAutomaticRecurringFrequency`).
 */
const FREQUENCIA_PIX_AUTOMATICO = {
  WEEKLY: 'WEEKLY',
  MONTHLY: 'MONTHLY',
  QUARTERLY: 'QUARTERLY',
  SEMIANNUALLY: 'SEMIANNUALLY',
  YEARLY: 'ANNUALLY'
};

export function frequenciaPixAutomatico(ciclo) {
  return FREQUENCIA_PIX_AUTOMATICO[ciclo] ?? null;
}

export const CICLOS_SEM_PIX_AUTOMATICO = ['BIWEEKLY', 'BIMONTHLY'];

/** Quanto tempo o QR da primeira cobrança fica válido. */
const EXPIRACAO_QR_SEGUNDOS = 3600;

/**
 * Cria uma autorização de Pix Automático (`POST /v3/pix/automatic/authorizations`).
 *
 * É a recorrência sem cartão: o pagador lê UM QR Code no app do banco e,
 * naquele mesmo ato, paga a primeira cobrança E autoriza os débitos
 * seguintes ("Jornada 3" da doc da Asaas). Resolve as duas maiores
 * perdas da assinatura por cartão — quem não tem cartão de crédito, e o
 * churn involuntário de cartão vencido/sem limite.
 *
 * `paymentCreationMode: 'SUBSCRIPTION'` deixa a Asaas gerar as cobranças
 * de cada ciclo sozinha, igual à assinatura por cartão — as confirmações
 * chegam como PAYMENT_* no webhook que já existe.
 *
 * `retryPolicy: 'ALLOW_THREE_IN_SEVEN_DAYS'` é dunning nativo: se um
 * débito falhar por saldo, a Asaas tenta de novo em vez de perder o
 * ciclo.
 *
 * ⚠️ NUNCA TESTADO — depende de a Asaas ter habilitado Pix Automático
 * nesta conta. Se a chamada voltar com erro de permissão, é isso.
 */
export async function criarAutorizacaoPixAutomatico({
  clienteId,
  contratoId,
  frequencia,
  valor,
  descricao,
  inicioEm
}) {
  const resposta = await chamarAsaas('/v3/pix/automatic/authorizations', {
    method: 'POST',
    body: JSON.stringify({
      customerId: clienteId,
      contractId: contratoId,
      frequency: frequencia,
      startDate: inicioEm,
      value: valor,
      description: descricao,
      paymentCreationMode: 'SUBSCRIPTION',
      retryPolicy: 'ALLOW_THREE_IN_SEVEN_DAYS',
      immediateQrCode: {
        expirationSeconds: EXPIRACAO_QR_SEGUNDOS,
        originalValue: valor,
        description: descricao
      }
    })
  });

  return {
    autorizacaoId: resposta.id,
    status: resposta.status,
    qrCodeBase64: resposta.encodedImage ?? null,
    copiaECola: resposta.payload ?? null,
    assinaturaId: resposta.subscriptionId ?? null
  };
}

/**
 * Cria uma subconta (POST /v3/accounts) — modelo NÃO-BaaS: a Asaas
 * manda um e-mail de ativação pro endereço informado, e quem completa
 * o cadastro/documentos é quem tiver acesso a esse e-mail (aqui,
 * sempre o operador — nunca o contratante final).
 *
 * Requer conta-mãe pessoa jurídica (CNPJ) — a Asaas recusa a chamada
 * pra conta-mãe pessoa física. Sujeito a período de avaliação
 * regulatória pra clientes novos usando essa API (limites de
 * subcontas/cobranças no início — ver "FAQ Período de Avaliação" na
 * doc da Asaas).
 *
 * ⚠️ NÃO CONFIRMADO em produção ainda: os valores aceitos por
 * `companyType` (usado só quando `documento` é CNPJ) — a doc mostra
 * "MEI" como exemplo; os outros valores usados aqui (LIMITED,
 * INDIVIDUAL, ASSOCIATION) vêm do conhecimento geral da API da Asaas,
 * não foram vistos escritos nesta doc. Se a Asaas recusar com campo
 * inválido, confira https://docs.asaas.com antes de mexer em outra
 * coisa.
 *
 * @param {object} dados
 * @param {string} dados.nome
 * @param {string} dados.email
 * @param {string} dados.documentoDigitos — CPF (11) ou CNPJ (14), só dígitos
 * @param {string} [dados.telefone]
 * @param {string} [dados.celular]
 * @param {string} dados.endereco
 * @param {string} dados.enderecoNumero
 * @param {string} [dados.complemento]
 * @param {string} dados.bairro
 * @param {string} dados.cepDigitos
 * @param {number} dados.faturamento — incomeValue
 * @param {string} [dados.tipoEmpresa] — companyType, só se documento for CNPJ
 * @param {string} [dados.dataNascimento] — birthDate (YYYY-MM-DD), só se documento for CPF
 */
export async function criarSubconta({
  nome,
  email,
  documentoDigitos,
  telefone,
  celular,
  endereco,
  enderecoNumero,
  complemento,
  bairro,
  cepDigitos,
  faturamento,
  tipoEmpresa,
  dataNascimento
}) {
  const ehPessoaFisica = documentoDigitos.length === 11;

  const resposta = await chamarAsaas('/v3/accounts', {
    method: 'POST',
    body: JSON.stringify({
      name: nome,
      email,
      cpfCnpj: documentoDigitos,
      phone: telefone || undefined,
      mobilePhone: celular || undefined,
      address: endereco,
      addressNumber: enderecoNumero,
      complement: complemento || undefined,
      province: bairro,
      postalCode: cepDigitos,
      incomeValue: faturamento,
      ...(ehPessoaFisica ? { birthDate: dataNascimento } : { companyType: tipoEmpresa })
    })
  });

  return {
    asaasAccountId: resposta.id ?? null,
    walletId: resposta.walletId ?? null,
    apiKey: resposta.apiKey ?? null
  };
}
