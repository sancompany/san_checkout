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

async function chamarAsaas(caminho, opcoes = {}) {
  const { baseUrl, headers } = getConfigAsaas();
  const resposta = await fetch(`${baseUrl}${caminho}`, {
    ...opcoes,
    headers: { ...headers, ...(opcoes.headers ?? {}) }
  });

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
 * Dados comerciais da conta-mãe. Só é chamado para explicar uma recusa
 * — não entra em nenhum caminho de cobrança.
 *
 * A leitura é DEFENSIVA de propósito: a documentação da Asaas não
 * publica o schema desta resposta, então depender do nome exato de um
 * campo aqui seria inventar contrato. O que interessa é uma coisa só, e
 * dá para descobrir de dois jeitos independentes: `personType`, se vier,
 * e a contagem de dígitos do documento (11 = CPF, 14 = CNPJ).
 */
export async function tipoDaContaMae() {
  const conta = await chamarAsaas('/v3/myAccount/commercialInfo', { method: 'GET' });
  const digitos = String(conta?.cpfCnpj ?? '').replace(/\D/g, '');

  let tipo = 'desconhecido';
  if (conta?.personType === 'FISICA' || digitos.length === 11) tipo = 'fisica';
  else if (conta?.personType === 'JURIDICA' || digitos.length === 14) tipo = 'juridica';

  return { tipo, companyType: conta?.companyType ?? null };
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

const DIAS_VENCIMENTO_BOLETO = 3; // VISAO_COMPLETA.md seção 4.3

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
 * (VISAO_COMPLETA.md seção 7).
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
