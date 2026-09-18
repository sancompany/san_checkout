/**
 * SAN CHECKOUT v2 — src/controllers/checkoutController.js
 * POST /api/checkout/pix/:contratanteId/:pedidoId
 * GET  /api/checkout/pix/status/:chargeId
 * POST /api/checkout/boleto/:contratanteId/:pedidoId
 * GET  /api/checkout/boleto/status/:chargeId
 *
 * Pix e Boleto — os dois métodos cobrados DIRETO na API da Asaas
 * (POST /v3/payments), sem pop-up. Boleto entrou aqui (não em
 * asaasCheckoutController.js) porque o Asaas Checkout não aceita
 * billingTypes BOLETO — confirmado em sandbox. Cartão/Assinatura
 * continuam via pop-up, em asaasCheckoutController.js.
 */

import { resolverPedido } from '../services/pedidoService.js';
import { calcularTaxa } from '../services/taxaService.js';
import {
  buscarOuCriarCliente,
  criarCobrancaPix,
  criarCobrancaBoleto,
  consultarStatus,
  recuperarCobrancaPix,
  recuperarCobrancaBoleto
} from '../services/asaasService.js';
import { registrarCobranca, buscarCobrancaPendenteDoPedido } from '../services/cobrancaService.js';
import {
  documentoValido, emailValido, valorValido, nomeValido, telefoneValido,
  normalizarDocumento,
  valorCobradoAceitavel, MENSAGEM_PISO_ASAAS
} from '../utils/validadores.js';
import { responderErro } from '../utils/erros.js';

function gerarReferenciaExterna(documento) {
  return `${documento}-${Date.now()}`;
}

/**
 * Devolve a cobrança pendente que já existe pra esse pedido+método, se
 * ainda estiver pagável na Asaas. É o que impede a duplicidade: o
 * comprador que recarrega a página e clica de novo recebe o MESMO
 * Pix/boleto, em vez de um segundo igualmente pagável.
 *
 * Qualquer erro aqui é engolido de propósito: se a consulta falhar, o
 * pior caso é cair no comportamento antigo (criar uma nova cobrança) —
 * inaceitável seria a consulta derrubar um pagamento que ia dar certo.
 *
 * @param {Function} recuperar — recuperarCobrancaPix ou recuperarCobrancaBoleto
 */
async function reaproveitarCobrancaPendente({ contratanteId, pedidoId, metodo, recuperar }) {
  try {
    const pendente = await buscarCobrancaPendenteDoPedido(contratanteId, pedidoId, metodo);
    if (!pendente?.charge_id) return null;

    const viva = await recuperar(pendente.charge_id);
    if (!viva) return null;

    console.log(`[checkout/${metodo}] reaproveitando cobrança ${pendente.charge_id} do pedido ${pedidoId} (evitou duplicidade)`);
    return viva;
  } catch (erro) {
    console.error(`[checkout/${metodo}] falha ao checar cobrança pendente do pedido ${pedidoId}:`, erro.message);
    return null;
  }
}

export async function gerarPix(requisicao, resposta) {
  const { contratanteId, pedidoId } = requisicao.params;
  let { nome, email, documento, telefone } = requisicao.body ?? {};

  if (!nome || !email || !documento) {
    return resposta.status(400).json({ erro: 'Nome, e-mail e CPF/CNPJ são obrigatórios.' });
  }
  if (!nomeValido(nome)) return resposta.status(400).json({ erro: 'Nome inválido.' });
  if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });

  /* O documento vira DÍGITOS aqui, e daqui para baixo é só esta forma.
     `552.085.198-01` e `55208519801` são o mesmo CPF, passam os dois na
     validação, e sem isto viram duas chaves diferentes no banco — a
     assinatura criada com uma forma responde 404 para quem cancela com a
     outra. Ver `normalizarDocumento` em `utils/validadores.js`. */
  documento = normalizarDocumento(documento);
  if (!emailValido(email)) return resposta.status(400).json({ erro: 'E-mail inválido.' });
  // Telefone é opcional aqui (Pix/Boleto não exigem, diferente da pop-up
  // de cartão), mas quando vem, passa pela MESMA checagem — achado no
  // ciclo de revisão do projeto inteiro em 18/09/2026: sem isto, um
  // telefone de 100 KB atravessava e ia gravado cru em `cobrancas`.
  if (telefone && !telefoneValido(telefone)) return resposta.status(400).json({ erro: 'Telefone inválido.' });

  try {
    // Nunca confia no valor mandado pelo front — resolve o pedido de
    // novo, direto na fonte, na hora de cobrar.
    //
    // `contratante` sai DAQUI e não de uma segunda consulta: o
    // `resolverPedido` já foi ao banco buscá-lo para validar o método
    // habilitado, e devolve o registro inteiro. Buscar de novo mais
    // abaixo, só para ler o `wallet_id`, era uma ida ao banco a mais no
    // caminho do dinheiro — medida em 213 ms em 12/09/2026, com o
    // backend em Oregon e o Supabase em São Paulo.
    const { contratante, pedido } = await resolverPedido(contratanteId, pedidoId, { metodoRequerido: 'pix' });

    // Antes de criar: esse pedido já tem Pix pendente e pagável?
    const jaExiste = await reaproveitarCobrancaPendente({
      contratanteId, pedidoId, metodo: 'pix', recuperar: recuperarCobrancaPix
    });
    if (jaExiste) {
      return resposta.json({
        chargeId: jaExiste.chargeId,
        qrCodeBase64: jaExiste.qrCodeBase64,
        copiaECola: jaExiste.copiaECola,
        reaproveitada: true
      });
    }

    const valorBase = Number(pedido.valorComDesconto ?? 0) + Number(pedido.frete ?? 0);
    if (!valorValido(valorBase)) {
      return resposta.status(400).json({ erro: 'Valor do pedido inválido.' });
    }

    const { taxaAsaas, taxaPropria, valorCobrado } = calcularTaxa(
      valorBase,
      'pix',
      1,
      Boolean(pedido.isentarTaxa)
    );

    // O piso é sobre o valor COBRADO, então só dá para conferir depois
    // da taxa. A tela já barra isto ao abrir (`pedidoController`); aqui
    // é a mesma regra do lado que não dá para pular chamando a API
    // direto, e ela evita uma ida à Asaas que volta 400.
    if (!valorCobradoAceitavel(valorCobrado)) {
      return resposta.status(400).json({ erro: MENSAGEM_PISO_ASAAS });
    }

    const clienteId = await buscarOuCriarCliente({ nome, email, documento });

    const split = contratante?.wallet_id
      ? [{ walletId: contratante.wallet_id, fixedValue: valorBase }]
      : undefined;

    const { chargeId, qrCodeBase64, copiaECola } = await criarCobrancaPix({
      clienteId,
      valor: valorCobrado,
      descricao: pedido.descricao ?? 'Pagamento via SAN & CO. Pay Engine',
      referenciaExterna: gerarReferenciaExterna(documento),
      split
    });

    await registrarCobranca({
      chargeId,
      contratanteId,
      pedidoId,
      documento,
      email,
      telefone,
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
      metodoPagamento: 'pix'
    });

    resposta.json({ chargeId, qrCodeBase64, copiaECola });
  } catch (erro) {
    responderErro(resposta, erro, 'checkout/pix');
  }
}

export async function statusPix(requisicao, resposta) {
  try {
    const { status } = await consultarStatus(requisicao.params.chargeId);
    resposta.json({ status });
  } catch (erro) {
    responderErro(resposta, erro, 'checkout/pix/status');
  }
}

/**
 * POST /api/checkout/boleto/:contratanteId/:pedidoId
 * Cobrança direta (sem pop-up) — mesmo modelo do Pix acima. O boleto
 * confirma via o MESMO vocabulário de webhook do Pix (PAYMENT_*, ver
 * webhookController.js), porque os dois usam charge_id desde a
 * criação — nenhuma mudança precisou entrar no webhook por causa disso.
 */
export async function gerarBoleto(requisicao, resposta) {
  const { contratanteId, pedidoId } = requisicao.params;
  let { nome, email, documento, telefone } = requisicao.body ?? {};

  if (!nome || !email || !documento) {
    return resposta.status(400).json({ erro: 'Nome, e-mail e CPF/CNPJ são obrigatórios.' });
  }
  if (!nomeValido(nome)) return resposta.status(400).json({ erro: 'Nome inválido.' });
  if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });

  // Dígitos, e daqui para baixo é só esta forma (RN-32) — a explicação
  // inteira está em `normalizarDocumento`, em `utils/validadores.js`.
  documento = normalizarDocumento(documento);
  if (!emailValido(email)) return resposta.status(400).json({ erro: 'E-mail inválido.' });
  // Mesma checagem do Pix acima, e o mesmo motivo — ver a nota lá.
  if (telefone && !telefoneValido(telefone)) return resposta.status(400).json({ erro: 'Telefone inválido.' });

  try {
    // Mesmo motivo do Pix: o contratante vem do `resolverPedido`.
    const { contratante, pedido } = await resolverPedido(contratanteId, pedidoId, { metodoRequerido: 'boleto' });

    // Reforço de segurança — o front já esconde o Boleto quando o
    // pedido tem expiraEm (API.md §4.1), mas o backend NUNCA
    // confia só na validação do front.
    if (pedido.expiraEm) {
      return resposta.status(400).json({ erro: 'Este pedido tem prazo de expiração e não aceita Boleto.' });
    }

    // Boleto duplicado é pior que Pix duplicado: o antigo segue pagável
    // por dias. Mesma checagem, mesmo motivo.
    const jaExiste = await reaproveitarCobrancaPendente({
      contratanteId, pedidoId, metodo: 'boleto', recuperar: recuperarCobrancaBoleto
    });
    if (jaExiste) {
      return resposta.json({
        chargeId: jaExiste.chargeId,
        boletoUrl: jaExiste.boletoUrl,
        linhaDigitavel: jaExiste.linhaDigitavel,
        codigoBarras: jaExiste.codigoBarras,
        vencimento: jaExiste.vencimento,
        reaproveitada: true
      });
    }

    const valorBase = Number(pedido.valorComDesconto ?? 0) + Number(pedido.frete ?? 0);
    if (!valorValido(valorBase)) {
      return resposta.status(400).json({ erro: 'Valor do pedido inválido.' });
    }

    const { taxaAsaas, taxaPropria, valorCobrado } = calcularTaxa(
      valorBase,
      'boleto',
      1,
      Boolean(pedido.isentarTaxa)
    );

    // O piso é sobre o valor COBRADO, então só dá para conferir depois
    // da taxa. A tela já barra isto ao abrir (`pedidoController`); aqui
    // é a mesma regra do lado que não dá para pular chamando a API
    // direto, e ela evita uma ida à Asaas que volta 400.
    if (!valorCobradoAceitavel(valorCobrado)) {
      return resposta.status(400).json({ erro: MENSAGEM_PISO_ASAAS });
    }

    const clienteId = await buscarOuCriarCliente({ nome, email, documento });

    const split = contratante?.wallet_id
      ? [{ walletId: contratante.wallet_id, fixedValue: valorBase }]
      : undefined;

    const { chargeId, boletoUrl, linhaDigitavel, codigoBarras, vencimento } = await criarCobrancaBoleto({
      clienteId,
      valor: valorCobrado,
      descricao: pedido.descricao ?? 'Pagamento via SAN & CO. Pay Engine',
      referenciaExterna: gerarReferenciaExterna(documento),
      split
    });

    await registrarCobranca({
      chargeId,
      contratanteId,
      pedidoId,
      documento,
      email,
      telefone,
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
      metodoPagamento: 'boleto'
    });

    resposta.json({ chargeId, boletoUrl, linhaDigitavel, codigoBarras, vencimento });
  } catch (erro) {
    responderErro(resposta, erro, 'checkout/boleto');
  }
}

export async function statusBoleto(requisicao, resposta) {
  try {
    const { status } = await consultarStatus(requisicao.params.chargeId);
    resposta.json({ status });
  } catch (erro) {
    responderErro(resposta, erro, 'checkout/boleto/status');
  }
}
