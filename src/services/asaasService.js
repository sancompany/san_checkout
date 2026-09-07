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

async function chamarAsaas(caminho, opcoes = {}) {
  const { baseUrl, headers } = getConfigAsaas();
  const resposta = await fetch(`${baseUrl}${caminho}`, {
    ...opcoes,
    headers: { ...headers, ...(opcoes.headers ?? {}) }
  });

  const corpo = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    const descricao = corpo.errors?.[0]?.description || `Asaas respondeu ${resposta.status}`;
    const erro = new Error(descricao);
    erro.status = resposta.status;
    erro.corpoAsaas = corpo;
    throw erro;
  }

  return corpo;
}

/** Busca cliente por CPF; cria se não existir. */
export async function buscarOuCriarCliente({ nome, email, cpf }) {
  const busca = await chamarAsaas(`/v3/customers?cpfCnpj=${cpf}`, { method: 'GET' });
  if (busca.data?.length) return busca.data[0].id;

  const novo = await chamarAsaas('/v3/customers', {
    method: 'POST',
    body: JSON.stringify({ name: nome, email, cpfCnpj: cpf, externalReference: cpf })
  });

  return novo.id;
}

function dataDeHoje() {
  return new Date().toISOString().slice(0, 10);
}

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
 * Tenta cancelar a nota fiscal vinculada a uma cobrança —
 * `POST /v3/invoices/{id}/cancel`. Pode falhar por regra da
 * prefeitura (nem toda cidade permite cancelamento automático) — quem
 * chama isso (`refundController.js`) NUNCA deve deixar essa falha
 * travar o estorno do dinheiro em si.
 */
export async function cancelarNotaFiscal(notaFiscalId) {
  return chamarAsaas(`/v3/invoices/${notaFiscalId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}
