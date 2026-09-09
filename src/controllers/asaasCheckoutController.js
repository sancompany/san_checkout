/**
 * SAN CHECKOUT v2 — src/controllers/asaasCheckoutController.js
 * Fluxo do Asaas Checkout (pop-up hospedada) — Cartão e Assinatura.
 * Boleto NÃO usa mais este fluxo: confirmado em sandbox que o Asaas
 * Checkout só aceita billingTypes CREDIT_CARD/PIX (Boleto dá erro
 * "O campo billingTypes é inválido") — Boleto migrou pra cobrança
 * direta (POST /v3/payments), igual o Pix, ver `checkoutController.js`
 * e `asaasService.criarCobrancaBoleto`.
 *
 * ⚠️ CONFIRMADO EM SANDBOX: telefone é obrigatório em `customerData`
 * (a Asaas recusa sem ele) — por isso o front agora pede telefone
 * junto de nome/e-mail/CPF. O nome do campo é `phone` (confirmado
 * contra o schema oficial `CheckoutSessionCustomerDataDTO` da própria
 * Asaas) — a mensagem de erro cita "phoneNumber", mas isso é só o
 * rótulo interno usado na validação, não a chave JSON de verdade; não
 * tentar `phoneNumber` de novo achando que é isso. O nome do campo pra
 * CPF (`cpfCnpj`) segue por analogia com o resto da API — não deu
 * erro, mas também não foi confirmado byte a byte contra a doc.
 * (O `callback`, que também estava sinalizado aqui, já foi confirmado
 * como obrigatório e adicionado em `asaasService.criarSessaoAsaasCheckout`.)
 *
 * ⚠️ CONFIRMADO EM SANDBOX (segunda rodada): endereço completo também
 * é obrigatório em `customerData` ("O campo address deve ser
 * informado") — antifraude da Asaas pra Cartão/Assinatura. Campos:
 * `address` (rua), `addressNumber`, `complement` (opcional),
 * `province` (= BAIRRO, não estado, apesar do nome em inglês),
 * `postalCode`, e `city` — este último é o CÓDIGO IBGE NUMÉRICO do
 * município (ex.: 4205407), não o nome da cidade (confirmado no
 * schema oficial `CheckoutSessionCustomerDataDTO`). O front resolve
 * esse código a partir do CEP via ViaCEP (ver
 * public/js/utils/cep.js) e manda pronto como `cidadeIbge`.
 */

import { resolverPedido, resolverPlano } from '../services/pedidoService.js';
import { calcularTaxa, metodoCartaoPorParcelas } from '../services/taxaService.js';
import { criarSessaoAsaasCheckout } from '../services/asaasService.js';
import { montarUrlCheckoutSession } from '../config/asaas.js';
import { registrarCobrancaPendentePopup, buscarCobrancaPorCheckoutId } from '../services/cobrancaService.js';
import { documentoValido, emailValido, valorValido, telefoneValido, cepValido } from '../utils/validadores.js';
import { responderErro } from '../utils/erros.js';

function parcelasValidas(valor) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero >= 1 && numero <= 12;
}

export async function criarCheckoutCartao(requisicao, resposta) {
  const { contratanteId, pedidoId } = requisicao.params;
  const {
    nome, email, documento, telefone, parcelas,
    endereco, enderecoNumero, complemento, bairro, cep, cidade, uf, cidadeIbge
  } = requisicao.body ?? {};

  if (!nome || !email || !documento || !telefone) {
    return resposta.status(400).json({ erro: 'Nome, e-mail, CPF/CNPJ e telefone são obrigatórios.' });
  }
  if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });
  if (!emailValido(email)) return resposta.status(400).json({ erro: 'E-mail inválido.' });
  if (!telefoneValido(telefone)) return resposta.status(400).json({ erro: 'Telefone inválido.' });
  if (!parcelasValidas(parcelas)) return resposta.status(400).json({ erro: 'Número de parcelas inválido (1 a 12).' });

  // Antifraude da Asaas pra Cartão — ver nota no topo do arquivo.
  if (!endereco || !enderecoNumero || !bairro || !cep || !cidadeIbge) {
    return resposta.status(400).json({ erro: 'Endereço completo (rua, número, bairro e CEP) é obrigatório.' });
  }
  if (!cepValido(cep)) return resposta.status(400).json({ erro: 'CEP inválido.' });

  const numeroParcelas = Number(parcelas);

  try {
    const { contratante, pedido } = await resolverPedido(contratanteId, pedidoId);

    const valorBase = Number(pedido.valorComDesconto ?? 0) + Number(pedido.frete ?? 0);
    if (!valorValido(valorBase)) {
      return resposta.status(400).json({ erro: 'Valor do pedido inválido.' });
    }

    const metodoTaxa = metodoCartaoPorParcelas(numeroParcelas);
    const { taxaAsaas, taxaPropria, valorCobrado } = calcularTaxa(
      valorBase,
      metodoTaxa,
      numeroParcelas,
      Boolean(pedido.isentarTaxa)
    );

    const splits = contratante?.wallet_id
      ? [{ walletId: contratante.wallet_id, fixedValue: valorBase }]
      : undefined;

    const { asaasCheckoutId } = await criarSessaoAsaasCheckout({
      billingTypes: ['CREDIT_CARD'],
      chargeTypes: numeroParcelas > 1 ? ['DETACHED', 'INSTALLMENT'] : ['DETACHED'],
      itens: [{
        name: pedido.descricao ?? 'Pagamento via SAN & CO. Pay Engine',
        quantity: 1,
        value: valorCobrado
      }],
      ...(numeroParcelas > 1 ? { installment: { maxInstallmentCount: numeroParcelas } } : {}),
      customerData: {
        name: nome,
        email,
        cpfCnpj: documento,
        phone: telefone,
        address: endereco,
        addressNumber: enderecoNumero,
        ...(complemento ? { complement: complemento } : {}),
        province: bairro,
        postalCode: String(cep).replace(/\D/g, ''),
        city: Number(cidadeIbge)
      },
      splits
    });

    await registrarCobrancaPendentePopup({
      asaasCheckoutId,
      contratanteId,
      pedidoId,
      documento,
      email,
      telefone,
      endereco,
      enderecoNumero,
      complemento,
      bairro,
      cep,
      cidade,
      uf,
      cidadeIbge,
      itens: pedido.itens ?? null,
      valorCheio: pedido.valorCheio,
      desconto: pedido.desconto,
      cupom: pedido.cupom,
      valorComDesconto: pedido.valorComDesconto,
      frete: pedido.frete,
      taxaDoProjeto: pedido.taxaDoProjeto,
      taxaAsaas,
      taxaPropria,
      taxaIsenta: Boolean(pedido.isentarTaxa),
      valorCobrado,
      metodoPagamento: 'cartao_credito',
      parcelas: numeroParcelas
    });

    resposta.json({
      checkoutUrl: montarUrlCheckoutSession(asaasCheckoutId),
      asaasCheckoutId
    });
  } catch (erro) {
    if (erro.corpoAsaas) console.error('[checkout/cartao] corpoAsaas:', erro.corpoAsaas);
    responderErro(resposta, erro, 'checkout/cartao');
  }
}

function formatarDataHoraAsaas(data) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${data.getFullYear()}-${pad(data.getMonth() + 1)}-${pad(data.getDate())} `
    + `${pad(data.getHours())}:${pad(data.getMinutes())}:${pad(data.getSeconds())}`;
}

/**
 * POST /api/checkout/assinatura/:contratanteId/:planoId
 * Cria a sessão RECURRENT — o pagador digita o cartão uma única vez na
 * pop-up e a Asaas passa a cobrar sozinha todo ciclo (ver
 * VISAO_COMPLETA.md seção 4.4). Só cartão — Pix Automático foi
 * descartado por decisão do operador.
 *
 * ⚠️ NÃO IMPLEMENTADO NESTA PARTE: o webhook de cobranças de ciclos
 * seguintes (`tipo: "assinatura"`, eventos criada/cobranca_confirmada/
 * cobranca_falhou/cancelada, ver INTEGRACAO.md 6.1) ainda não existe
 * no `webhookController.js` — só a criação da assinatura em si.
 */
export async function criarCheckoutAssinatura(requisicao, resposta) {
  const { contratanteId, planoId } = requisicao.params;
  const {
    nome, email, documento, telefone,
    endereco, enderecoNumero, complemento, bairro, cep, cidade, uf, cidadeIbge
  } = requisicao.body ?? {};

  if (!nome || !email || !documento || !telefone) {
    return resposta.status(400).json({ erro: 'Nome, e-mail, CPF/CNPJ e telefone são obrigatórios.' });
  }
  if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });
  if (!emailValido(email)) return resposta.status(400).json({ erro: 'E-mail inválido.' });
  if (!telefoneValido(telefone)) return resposta.status(400).json({ erro: 'Telefone inválido.' });

  // Antifraude da Asaas pra Cartão — assinatura também é cartão (ver
  // nota no topo do arquivo).
  if (!endereco || !enderecoNumero || !bairro || !cep || !cidadeIbge) {
    return resposta.status(400).json({ erro: 'Endereço completo (rua, número, bairro e CEP) é obrigatório.' });
  }
  if (!cepValido(cep)) return resposta.status(400).json({ erro: 'CEP inválido.' });

  try {
    const { contratante, plano } = await resolverPlano(contratanteId, planoId);

    const valor = Number(plano.valor ?? 0);
    if (!valorValido(valor)) {
      return resposta.status(400).json({ erro: 'Valor do plano inválido.' });
    }

    // Nesta leva, assinatura NÃO aplica taxaPropria/taxaAsaas — cobra
    // o valor do plano exatamente como veio. Se isso deve mudar, é
    // decisão pendente, ainda não tomada (ver VISAO_COMPLETA.md).
    const splits = contratante?.wallet_id
      ? [{ walletId: contratante.wallet_id, fixedValue: valor }]
      : undefined;

    const { asaasCheckoutId } = await criarSessaoAsaasCheckout({
      billingTypes: ['CREDIT_CARD'],
      chargeTypes: ['RECURRENT'],
      itens: [{
        name: plano.nome ?? 'Assinatura via SAN & CO. Pay Engine',
        quantity: 1,
        value: valor
      }],
      subscription: {
        cycle: plano.ciclo ?? 'MONTHLY',
        nextDueDate: formatarDataHoraAsaas(new Date())
      },
      customerData: {
        name: nome,
        email,
        cpfCnpj: documento,
        phone: telefone,
        address: endereco,
        addressNumber: enderecoNumero,
        ...(complemento ? { complement: complemento } : {}),
        province: bairro,
        postalCode: String(cep).replace(/\D/g, ''),
        city: Number(cidadeIbge)
      },
      splits
    });

    await registrarCobrancaPendentePopup({
      asaasCheckoutId,
      contratanteId,
      planoId,
      documento,
      email,
      telefone,
      endereco,
      enderecoNumero,
      complemento,
      bairro,
      cep,
      cidade,
      uf,
      cidadeIbge,
      valorCheio: valor,
      valorComDesconto: valor,
      taxaAsaas: 0,
      taxaPropria: 0,
      taxaIsenta: true, // nesta leva, assinatura nunca aplica taxa — não é uma isenção concedida, é a simplificação atual
      valorCobrado: valor,
      metodoPagamento: 'assinatura',
      parcelas: 1
    });

    resposta.json({
      checkoutUrl: montarUrlCheckoutSession(asaasCheckoutId),
      asaasCheckoutId
    });
  } catch (erro) {
    if (erro.corpoAsaas) console.error('[checkout/assinatura] corpoAsaas:', erro.corpoAsaas);
    responderErro(resposta, erro, 'checkout/assinatura');
  }
}

/**
 * GET /api/checkout/asaas-checkout/status/:asaasCheckoutId
 * Usado pelo polling do front enquanto a pop-up está aberta (Cartão,
 * Boleto e, mais adiante, Assinatura reaproveitam este mesmo
 * endpoint). O status vem do NOSSO banco (atualizado pelo
 * webhookController quando CHECKOUT_PAID/CANCELED/EXPIRED chegar) —
 * nunca consultando a Asaas na hora, pra não duplicar a fonte de
 * verdade do webhook.
 */
export async function consultarStatusCheckout(requisicao, resposta) {
  try {
    const cobranca = await buscarCobrancaPorCheckoutId(requisicao.params.asaasCheckoutId);
    if (!cobranca) return resposta.status(404).json({ erro: 'Sessão não encontrada.' });

    // Traduz nosso status interno de volta pro vocabulário que o front
    // já espera (mesmo nome de evento que a Asaas usa).
    const mapa = { pendente: 'PENDING', confirmado: 'CHECKOUT_PAID', cancelado: 'CHECKOUT_CANCELED', expirado: 'CHECKOUT_EXPIRED' };
    resposta.json({ status: mapa[cobranca.status] ?? cobranca.status });
  } catch (erro) {
    responderErro(resposta, erro, 'asaas-checkout/status');
  }
}
