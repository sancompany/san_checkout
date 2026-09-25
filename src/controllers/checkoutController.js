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
 *
 * ── Reserva antes de cobrar, desde 22/09/2026 ─────────────────────────
 * Achado numa auditoria externa (Codex), confirmado lendo o código: até
 * então a ordem era checar-se-já-existe → cobrar na Asaas → só DEPOIS
 * gravar a linha local. Duas chamadas simultâneas pro mesmo pedido liam
 * as duas "nada pendente ainda" e as DUAS criavam um Pix/boleto pagável
 * de verdade na Asaas — o índice único (`idx_cobrancas_pendente_unica`)
 * só impedia a SEGUNDA LINHA no Postgres, nunca o segundo objeto
 * financeiro no PSP. Agora a ordem é reservar → cobrar → completar
 * (mesmo padrão que `asaasCheckoutController.js` já usa pro pop-up), e
 * uma falha AMBÍGUA da Asaas (timeout, 5xx) nunca libera a reserva —
 * mesma regra que `trocaExecucaoService.iniciarCobranca` já segue pro
 * acerto de troca de plano.
 */

import { resolverPedido } from '../services/pedidoService.js';
import { exigirCotacaoParaCobrar, montarTotaisPedido, marcarCotacaoUsada } from '../services/cotacaoService.js';
import {
  buscarOuCriarCliente,
  criarCobrancaPix,
  criarCobrancaBoleto,
  consultarStatus,
  recuperarCobrancaPix,
  recuperarCobrancaBoleto,
  listarPagamentosPorReferenciaExterna,
  consultarPagamento,
  excluirCobranca,
  foiRecusaLimpaDaAsaas
} from '../services/asaasService.js';
import {
  reservarCobranca,
  completarCobranca,
  liberarReservaCobranca,
  buscarCobrancaPendenteDoPedido,
  buscarReservaPendenteDoPedido,
  existeCobrancaDoMetodo,
  aplicarTransicao
} from '../services/cobrancaService.js';
import { emCentavos } from '../utils/dinheiro.js';
import { completarComOQueAAsaasSabe } from '../services/reconciliacaoService.js';
import {
  documentoValido, emailValido, nomeValido, telefoneValido, normalizarTelefone,
  normalizarDocumento,
  valorCobradoAceitavel, MENSAGEM_PISO_ASAAS
} from '../utils/validadores.js';
import { responderErro } from '../utils/erros.js';
import { registrarErro } from '../services/erroService.js';

/**
 * Derivada da RESERVA local, não de documento+timestamp — achado por
 * revisão externa (Codex, PR #39, 22/09/2026): o valor antigo
 * (`${documento}-${Date.now()}`) não sobrevivia em lugar nenhum além do
 * corpo da requisição à Asaas, então uma reserva travada por falha
 * ambígua (ver `cobrarComReserva`) não tinha como ser encontrada lá —
 * quem fosse reconciliar na mão precisava adivinhar. `reserva.id` já É
 * persistido (é a própria linha em `cobrancas`), então esta referência
 * é sempre recuperável a partir dele.
 */
function gerarReferenciaExterna(reservaId) {
  return `reserva-${reservaId}`;
}

const dependenciasPadrao = {
  resolverPedido,
  exigirCotacaoParaCobrar,
  marcarCotacaoUsada,
  buscarOuCriarCliente,
  criarCobrancaPix,
  criarCobrancaBoleto,
  consultarStatus,
  recuperarCobrancaPix,
  recuperarCobrancaBoleto,
  reservarCobranca,
  completarCobranca,
  liberarReservaCobranca,
  buscarCobrancaPendenteDoPedido,
  buscarReservaPendenteDoPedido,
  existeCobrancaDoMetodo,
  consultarPagamento,
  excluirCobranca,
  aplicarTransicao,
  listarPagamentosPorReferenciaExterna,
  completarReservaOrfa: (reservaId, pagamento) => completarComOQueAAsaasSabe(reservaId, pagamento),
  registrarErro
};

/**
 * Devolve a cobrança pendente que já existe pra esse pedido+método, se
 * ainda estiver pagável na Asaas. É o que impede a duplicidade percebida
 * pelo comprador: quem recarrega a página e clica de novo recebe o
 * MESMO Pix/boleto, em vez de um segundo igualmente pagável.
 *
 * Qualquer erro aqui é engolido de propósito: se a consulta falhar, o
 * pior caso é cair no fluxo normal (que agora reserva antes de cobrar,
 * então continua seguro) — inaceitável seria a consulta derrubar um
 * pagamento que ia dar certo.
 *
 * @param {Function} recuperar — recuperarCobrancaPix ou recuperarCobrancaBoleto
 */
async function reaproveitarCobrancaPendente(deps, { contratanteId, pedidoId, metodo, recuperar, valorCobrado }) {
  let pendente;
  try {
    pendente = await deps.buscarCobrancaPendenteDoPedido(contratanteId, pedidoId, metodo);
  } catch (erro) {
    console.error(`[checkout/${metodo}] falha ao checar cobrança pendente do pedido ${pedidoId}:`, erro.message);
    return null;
  }
  if (!pendente?.charge_id) return null;

  /* SEC-004 — o instrumento só é devolvido se continua sendo O instrumento
     deste pedido, pelo preço desta tela. Quem chega aqui já passou pela
     guarda de pedido pago e pela cotação (`cotarParaCobrar` roda ANTES,
     desde 25/09/2026); faltam duas perguntas que só a linha responde:

       - OBSOLETO (RN-51): outra cobrança do pedido liquidou e esta está
         na fila do cancelador. Nunca volta a ser entregue — nem enquanto
         a exclusão na Asaas não acontece.
       - PREÇO DIFERENTE: o pedido mudou de valor (cupom, frete) depois de
         este Pix/boleto nascer. Devolvê-lo cobraria o valor antigo com a
         tela mostrando o novo. O antigo é excluído na Asaas antes de
         nascer outro — nunca dois pagáveis ao mesmo tempo. */
  if (pendente.obsoleta_desde) return { obsoleta: true, chargeId: pendente.charge_id };
  if (valorCobrado != null && emCentavos(pendente.valor_cobrado) !== emCentavos(valorCobrado)) {
    return substituirInstrumentoDesatualizado(deps, pendente, { metodo, pedidoId });
  }
  return recuperarPeloChargeId(recuperar, pendente.charge_id, { metodo, pedidoId });
}

/**
 * O Pix/boleto pendente foi criado por OUTRO preço. Lê o estado na Asaas
 * antes de excluir (mesma regra do cancelador de irmãs, RN-51): pago não
 * se exclui nunca; pagável é excluído e a linha sai de `pendente` por CAS;
 * qualquer dúvida responde "tente de novo" sem criar nada.
 *
 * @returns {Promise<null|{pago:true, chargeId}|{indefinido:true, chargeId}>}
 *   `null` = substituído, o fluxo segue para criar o novo.
 */
async function substituirInstrumentoDesatualizado(deps, pendente, { metodo, pedidoId }) {
  const chargeId = pendente.charge_id;
  try {
    const { status, excluida } = await deps.consultarPagamento(chargeId);
    if (!excluida && ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(status)) return { pago: true, chargeId };
    if (!excluida) {
      if (!['PENDING', 'OVERDUE'].includes(status)) return { indefinido: true, chargeId };
      const r = await deps.excluirCobranca(chargeId);
      if (!r?.excluida) return { indefinido: true, chargeId };
    }
    await deps.aplicarTransicao(chargeId, { de: 'pendente', para: 'cancelado' });
    console.log(`[checkout/${metodo}] ${chargeId} do pedido ${pedidoId} tinha outro valor: excluído na Asaas antes de criar o novo`);
    return null;
  } catch (erro) {
    console.error(`[checkout/${metodo}] não foi possível substituir ${chargeId} (valor antigo) do pedido ${pedidoId}:`, erro.message);
    return { indefinido: true, chargeId };
  }
}

const MENSAGEM_INSTRUMENTO_EM_TROCA = 'Estamos atualizando o pagamento anterior deste pedido. Tente de novo em instantes — nada será cobrado duas vezes.';

/** A resposta para os desfechos do reaproveitamento que não são "o
 *  instrumento vigente" nem "pode criar": pago, obsoleto ou indefinido. */
function respostaDeInstrumentoIndisponivel(resposta, jaExiste) {
  if (jaExiste?.pago) {
    return resposta.status(409).json({ codigo: 'pagamento_em_processamento', chargeId: jaExiste.chargeId, erro: 'O pagamento anterior deste pedido já foi recebido e está sendo confirmado. Não é preciso pagar de novo.' });
  }
  if (jaExiste?.obsoleta || jaExiste?.indefinido) {
    return resposta.status(409).json({ codigo: 'cobranca_em_confirmacao', erro: MENSAGEM_INSTRUMENTO_EM_TROCA });
  }
  return null;
}

/**
 * A cobrança EXISTE (tem `charge_id`) e ainda pode estar pagável: busca de
 * novo o que a tela precisa (QR/linha digitável).
 *
 * Se a busca FALHAR, a resposta é `{ indisponivel: true }` — nunca `null`.
 * Até 25/09/2026 as duas coisas eram `null`, e `null` quer dizer "não há
 * cobrança, pode criar": o fluxo seguia para reservar, batia na reserva
 * que já existia e respondia "Já existe uma cobrança sendo criada" para
 * sempre. Foi o que o primeiro Pix real encontrou — o pagamento criado,
 * o QR indisponível (conta sem chave Pix), e o segundo clique num beco
 * sem saída. `indisponivel` vira 503 com o `chargeId`: tentar de novo é
 * seguro, é o MESMO Pix.
 */
async function recuperarPeloChargeId(recuperar, chargeId, { metodo, pedidoId }) {
  try {
    const viva = await recuperar(chargeId);
    if (!viva) return null; // não está mais pagável (pago, vencido, estornado): pode criar outra
    console.log(`[checkout/${metodo}] reaproveitando cobrança ${chargeId} do pedido ${pedidoId} (evitou duplicidade)`);
    return viva;
  } catch (erro) {
    console.error(`[checkout/${metodo}] cobrança ${chargeId} do pedido ${pedidoId} existe, mas não foi possível recuperá-la agora:`, erro.message);
    return { indisponivel: true, chargeId, motivo: erro.message };
  }
}

/**
 * A reserva que ficou SEM `charge_id` (a criação na Asaas deu timeout, ou
 * a resposta se perdeu) é conferida NA HORA pela referência que ela levou
 * — em vez de esperar o reconciliador de 5 em 5 minutos com o pagador
 * parado diante de "Já existe uma cobrança sendo criada". Achou: amarra o
 * `charge_id` à reserva e recupera. Não achou: ainda não se sabe, e a
 * resposta diz isso. Nunca cria nada.
 */
async function recuperarReservaSemCobranca(deps, { contratanteId, pedidoId, metodo, recuperar }) {
  try {
    const reserva = await deps.buscarReservaPendenteDoPedido(contratanteId, pedidoId, metodo);
    if (!reserva) return null;
    const encontrados = await deps.listarPagamentosPorReferenciaExterna(gerarReferenciaExterna(reserva.id));
    const vivo = encontrados.find((p) => p && !p.deleted);
    if (!vivo?.id) return null;
    await deps.completarReservaOrfa(reserva.id, vivo);
    console.log(`[checkout/${metodo}] reserva ${reserva.id} do pedido ${pedidoId} existia na Asaas como ${vivo.id} — amarrada na hora`);
    return recuperarPeloChargeId(recuperar, vivo.id, { metodo, pedidoId });
  } catch (erro) {
    console.error(`[checkout/${metodo}] falha ao conferir a reserva sem cobrança do pedido ${pedidoId}:`, erro.message);
    return null;
  }
}

const MENSAGEM_PIX_SEM_QR = 'Seu Pix foi criado, mas o QR Code não pôde ser gerado agora. Tente de novo em instantes — é o mesmo Pix, você não será cobrado duas vezes.';
const MENSAGEM_BOLETO_INDISPONIVEL = 'Seu boleto foi criado, mas não conseguimos exibi-lo agora. Tente de novo em instantes — é o mesmo boleto, você não será cobrado duas vezes.';
const MENSAGEM_EM_CONFIRMACAO = 'Estamos confirmando uma tentativa anterior deste pagamento. Tente de novo em instantes — nada será cobrado duas vezes.';

/**
 * A coreografia reserva→cobra→completa, compartilhada por Pix e Boleto.
 * O que muda entre os dois é só O QUE cobrar (`cobrar`) — a ordem que
 * impede a cobrança duplicada é sempre a mesma.
 *
 * @returns {Promise<{tipo: 'corrida'}|{tipo: 'criada', reservaId: string, cobranca: object}|{tipo: 'criada_sem_qr', reservaId: string, chargeId: string}>}
 */
async function cobrarComReserva(deps, { contratanteId, pedidoId, metodoPagamento, cobrar }) {
  const reserva = await deps.reservarCobranca({ contratanteId, pedidoId, metodoPagamento });
  if (!reserva.reservada) return { tipo: 'corrida' };

  let cobranca;
  try {
    // `reserva.id` chega até quem monta o pedido pra Asaas — é dele que
    // `gerarReferenciaExterna` deriva o `externalReference`, pra uma
    // reserva travada (caso ambíguo, abaixo) ser recuperável na Asaas
    // pelo próprio id da linha local.
    cobranca = await cobrar(reserva.id);
  } catch (erroAsaas) {
    /* O pagamento FOI criado e a Asaas nos deu o id; só a segunda chamada
       (o QR Code) falhou. Não é caso ambíguo: sabemos exatamente o que
       existe. A reserva é completada pelo chamador com esse `chargeId`
       JÁ, e o pagador recebe "tente de novo" — antes a linha ficava sem
       `charge_id` até o reconciliador passar, 5 minutos depois
       (primeiro Pix real, 25/09/2026). */
    if (erroAsaas?.pagamentoJaCriado && erroAsaas.chargeId) {
      await deps.registrarErro(
        new Error(`${metodoPagamento}: a cobrança ${erroAsaas.chargeId} do pedido ${pedidoId} (contratante ${contratanteId}) foi CRIADA, mas a busca do QR falhou: ${erroAsaas.message}. A reserva ${reserva.id} foi completada com o chargeId; o pagador pode tentar de novo e recebe o mesmo Pix.`),
        { contexto: 'checkoutController.cobrarComReserva.semQr', rota: `checkout/${metodoPagamento}`, metodo: 'POST' }
      );
      return { tipo: 'criada_sem_qr', reservaId: reserva.id, chargeId: erroAsaas.chargeId };
    }
    if (foiRecusaLimpaDaAsaas(erroAsaas)) {
      await deps.liberarReservaCobranca(reserva.id);
    } else {
      await deps.registrarErro(
        new Error(
          `${metodoPagamento}: criação na Asaas falhou de forma AMBÍGUA para o pedido ${pedidoId} ` +
          `(contratante ${contratanteId}, reserva ${reserva.id}) — NÃO SE SABE se a cobrança foi criada: ` +
          `${erroAsaas.message}. A reserva foi mantida de propósito (nunca solta em caso ambíguo, pra não ` +
          `permitir que uma nova tentativa crie uma segunda cobrança de verdade) — confira na Asaas por ` +
          `externalReference "reserva-${reserva.id}" antes de liberar esta reserva na mão.`
        ),
        { contexto: 'checkoutController.cobrarComReserva', rota: `checkout/${metodoPagamento}`, metodo: 'POST' }
      );
    }
    throw erroAsaas;
  }

  return { tipo: 'criada', reservaId: reserva.id, cobranca };
}

export function criarCheckoutController(deps = dependenciasPadrao) {
  /**
   * O PORTÃO DA COTAÇÃO (C-02), compartilhado por Pix e Boleto. Relê o
   * pull (o pedido pode ter sido pago/cancelado/expirado desde a tela),
   * exige a cotação que a tela recebeu, e devolve os TOTAIS gravados
   * nela — é isso que se cobra, nunca o pull novo. Divergência vira 409
   * com cotação nova (a tela reconfirma).
   */
  async function cotarParaCobrar({ contratanteId, pedidoId, cotacaoId, metodo }) {
    const { contratante, pedido } = await deps.resolverPedido(contratanteId, pedidoId, { metodoRequerido: metodo });
    const totaisNovos = montarTotaisPedido(pedido);
    if (!totaisNovos) {
      const erro = new Error('Valor do pedido inválido.');
      erro.status = 400;
      throw erro;
    }
    const cotacao = await deps.exigirCotacaoParaCobrar({
      cotacaoId, contratanteId: contratante.id, tipo: 'pedido', referenciaId: pedidoId, origemNova: pedido, totaisNovos
    });
    return { contratante, pedido, cotacao, total: cotacao.totais?.[metodo] ?? null };
  }

  async function gerarPix(requisicao, resposta) {
    const { contratanteId, pedidoId } = requisicao.params;
    let { nome, email, documento, telefone, cotacaoId } = requisicao.body ?? {};

    if (!nome || !email || !documento) {
      return resposta.status(400).json({ erro: 'Nome, e-mail e CPF/CNPJ são obrigatórios.' });
    }
    if (!nomeValido(nome)) return resposta.status(400).json({ erro: 'Nome inválido.' });
    if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });

    // O documento vira DÍGITOS aqui, e daqui para baixo é só esta forma.
    documento = normalizarDocumento(documento);
    if (!emailValido(email)) return resposta.status(400).json({ erro: 'E-mail inválido.' });
    if (telefone && !telefoneValido(telefone)) return resposta.status(400).json({ erro: 'Telefone inválido.' });
    // Uma forma só daqui para baixo: `+55 16 98765-4321` e `16987654321` são o mesmo telefone.
    if (telefone) telefone = normalizarTelefone(telefone);

    try {
      // Antes de criar: esse pedido já tem Pix pendente e pagável? Um
      // Pix já criado foi cobrado pela cotação da hora dele — reaproveitar
      // é o que impede o segundo Pix igualmente pagável.
      const respostaPix = (cobranca) => (cobranca.indisponivel
        ? resposta.status(503).json({ codigo: 'qr_indisponivel', chargeId: cobranca.chargeId, erro: MENSAGEM_PIX_SEM_QR })
        : resposta.json({ chargeId: cobranca.chargeId, qrCodeBase64: cobranca.qrCodeBase64, copiaECola: cobranca.copiaECola, reaproveitada: true }));

      /* A guarda de pedido pago (RN-04.1) e a cotação vêm ANTES do
         reaproveitamento (SEC-004, 25/09/2026). Na ordem antiga, um POST
         direto recebia de volta o Pix pendente de um pedido já pago no
         cartão, ou o QR do preço antigo com a tela mostrando o novo. */
      const { contratante, pedido, cotacao, total } = await cotarParaCobrar({ contratanteId, pedidoId, cotacaoId, metodo: 'pix' });
      if (!total) return resposta.status(400).json({ erro: 'Valor do pedido inválido.' });
      const { taxaAsaas, taxaPropria, valorCobrado } = total;

      const jaExiste = await reaproveitarCobrancaPendente(deps, {
        contratanteId, pedidoId, metodo: 'pix', recuperar: deps.recuperarCobrancaPix, valorCobrado
      });
      const indisponivel = respostaDeInstrumentoIndisponivel(resposta, jaExiste);
      if (indisponivel) return indisponivel;
      if (jaExiste) return respostaPix(jaExiste);

      const valorBase = Number(cotacao.totais.valorBase);

      if (!valorCobradoAceitavel(valorCobrado)) {
        return resposta.status(400).json({ erro: MENSAGEM_PISO_ASAAS });
      }

      const clienteId = await deps.buscarOuCriarCliente({ nome, email, documento });

      const split = contratante?.wallet_id
        ? [{ walletId: contratante.wallet_id, fixedValue: valorBase }]
        : undefined;

      const resultado = await cobrarComReserva(deps, {
        contratanteId, pedidoId, metodoPagamento: 'pix',
        cobrar: (reservaId) => deps.criarCobrancaPix({
          clienteId,
          valor: valorCobrado,
          descricao: pedido.descricao ?? 'Pagamento via SAN & CO. Pay Engine',
          referenciaExterna: gerarReferenciaExterna(reservaId),
          split
        })
      });

      if (resultado.tipo === 'corrida') {
        const reaproveitada = await reaproveitarCobrancaPendente(deps, {
          contratanteId, pedidoId, metodo: 'pix', recuperar: deps.recuperarCobrancaPix, valorCobrado
        }) ?? await recuperarReservaSemCobranca(deps, {
          contratanteId, pedidoId, metodo: 'pix', recuperar: deps.recuperarCobrancaPix
        });
        const indisponivelNaCorrida = respostaDeInstrumentoIndisponivel(resposta, reaproveitada);
        if (indisponivelNaCorrida) return indisponivelNaCorrida;
        if (reaproveitada) return respostaPix(reaproveitada);
        return resposta.status(409).json({ codigo: 'cobranca_em_confirmacao', erro: MENSAGEM_EM_CONFIRMACAO });
      }

      const dadosDaLinha = {
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
        cotacaoId: cotacao.id
      };

      if (resultado.tipo === 'criada_sem_qr') {
        // O Pix existe: a linha ganha o `chargeId` e o pagador AGORA, e o
        // próximo clique cai no `reaproveitar` acima, que busca o QR de novo.
        await deps.completarCobranca(resultado.reservaId, { chargeId: resultado.chargeId, ...dadosDaLinha });
        void deps.marcarCotacaoUsada(cotacao.id);
        return resposta.status(503).json({ codigo: 'qr_indisponivel', chargeId: resultado.chargeId, erro: MENSAGEM_PIX_SEM_QR });
      }

      const { chargeId, qrCodeBase64, copiaECola } = resultado.cobranca;

      await deps.completarCobranca(resultado.reservaId, { chargeId, ...dadosDaLinha });
      void deps.marcarCotacaoUsada(cotacao.id);

      resposta.json({ chargeId, qrCodeBase64, copiaECola });
    } catch (erro) {
      responderErro(resposta, erro, 'checkout/pix');
    }
  }

  /**
   * GET /pix/status/:chargeId e /boleto/status/:chargeId — PÚBLICAS.
   * Só consultam a Asaas para uma cobrança que é NOSSA e deste método
   * (SEC-017): a chamada sai com a chave da conta-mãe, e sem a pergunta
   * ao banco qualquer id da conta virava consulta autenticada. O 404 é
   * nosso e genérico — antes, um id inexistente devolvia o texto de erro
   * da Asaas (INFO-11).
   */
  async function statusDaCobranca(requisicao, resposta, metodo) {
    try {
      const { chargeId } = requisicao.params;
      if (!(await deps.existeCobrancaDoMetodo(chargeId, metodo))) {
        return resposta.status(404).json({ erro: 'Cobrança não encontrada.' });
      }
      const { status } = await deps.consultarStatus(chargeId);
      resposta.json({ status });
    } catch (erro) {
      responderErro(resposta, erro, `checkout/${metodo}/status`);
    }
  }

  async function statusPix(requisicao, resposta) {
    return statusDaCobranca(requisicao, resposta, 'pix');
  }

  /**
   * POST /api/checkout/boleto/:contratanteId/:pedidoId
   * Cobrança direta (sem pop-up) — mesmo modelo do Pix acima. O boleto
   * confirma via o MESMO vocabulário de webhook do Pix (PAYMENT_*, ver
   * webhookController.js), porque os dois usam charge_id desde a
   * criação — nenhuma mudança precisou entrar no webhook por causa disso.
   */
  async function gerarBoleto(requisicao, resposta) {
    const { contratanteId, pedidoId } = requisicao.params;
    let { nome, email, documento, telefone, cotacaoId } = requisicao.body ?? {};

    if (!nome || !email || !documento) {
      return resposta.status(400).json({ erro: 'Nome, e-mail e CPF/CNPJ são obrigatórios.' });
    }
    if (!nomeValido(nome)) return resposta.status(400).json({ erro: 'Nome inválido.' });
    if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });

    documento = normalizarDocumento(documento);
    if (!emailValido(email)) return resposta.status(400).json({ erro: 'E-mail inválido.' });
    if (telefone && !telefoneValido(telefone)) return resposta.status(400).json({ erro: 'Telefone inválido.' });
    // Uma forma só daqui para baixo: `+55 16 98765-4321` e `16987654321` são o mesmo telefone.
    if (telefone) telefone = normalizarTelefone(telefone);

    try {
      // Mesma ordem do Pix (SEC-004): guarda e cotação ANTES de devolver
      // o boleto pendente — e boleto duplicado é pior que Pix duplicado,
      // porque o antigo segue pagável por dias.
      const { contratante, pedido, cotacao, total } = await cotarParaCobrar({ contratanteId, pedidoId, cotacaoId, metodo: 'boleto' });

      // Reforço de segurança — o front já esconde o Boleto quando o
      // pedido tem expiraEm (API.md §4.1), mas o backend NUNCA
      // confia só na validação do front.
      if (pedido.expiraEm) {
        return resposta.status(400).json({ erro: 'Este pedido tem prazo de expiração e não aceita Boleto.' });
      }
      if (!total) return resposta.status(400).json({ erro: 'Valor do pedido inválido.' });
      const { taxaAsaas, taxaPropria, valorCobrado } = total;

      const jaExiste = await reaproveitarCobrancaPendente(deps, {
        contratanteId, pedidoId, metodo: 'boleto', recuperar: deps.recuperarCobrancaBoleto, valorCobrado
      });
      const indisponivel = respostaDeInstrumentoIndisponivel(resposta, jaExiste);
      if (indisponivel) return indisponivel;
      if (jaExiste?.indisponivel) {
        return resposta.status(503).json({ codigo: 'boleto_indisponivel', chargeId: jaExiste.chargeId, erro: MENSAGEM_BOLETO_INDISPONIVEL });
      }
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

      const valorBase = Number(cotacao.totais.valorBase);

      if (!valorCobradoAceitavel(valorCobrado)) {
        return resposta.status(400).json({ erro: MENSAGEM_PISO_ASAAS });
      }

      const clienteId = await deps.buscarOuCriarCliente({ nome, email, documento });

      const split = contratante?.wallet_id
        ? [{ walletId: contratante.wallet_id, fixedValue: valorBase }]
        : undefined;

      const resultado = await cobrarComReserva(deps, {
        contratanteId, pedidoId, metodoPagamento: 'boleto',
        cobrar: (reservaId) => deps.criarCobrancaBoleto({
          clienteId,
          valor: valorCobrado,
          descricao: pedido.descricao ?? 'Pagamento via SAN & CO. Pay Engine',
          referenciaExterna: gerarReferenciaExterna(reservaId),
          split
        })
      });

      if (resultado.tipo === 'corrida') {
        const reaproveitada = await reaproveitarCobrancaPendente(deps, {
          contratanteId, pedidoId, metodo: 'boleto', recuperar: deps.recuperarCobrancaBoleto, valorCobrado
        }) ?? await recuperarReservaSemCobranca(deps, {
          contratanteId, pedidoId, metodo: 'boleto', recuperar: deps.recuperarCobrancaBoleto
        });
        const indisponivelNaCorrida = respostaDeInstrumentoIndisponivel(resposta, reaproveitada);
        if (indisponivelNaCorrida) return indisponivelNaCorrida;
        if (reaproveitada?.indisponivel) {
          return resposta.status(503).json({ codigo: 'boleto_indisponivel', chargeId: reaproveitada.chargeId, erro: MENSAGEM_BOLETO_INDISPONIVEL });
        }
        if (reaproveitada) {
          return resposta.json({
            chargeId: reaproveitada.chargeId,
            boletoUrl: reaproveitada.boletoUrl,
            linhaDigitavel: reaproveitada.linhaDigitavel,
            codigoBarras: reaproveitada.codigoBarras,
            vencimento: reaproveitada.vencimento,
            reaproveitada: true
          });
        }
        return resposta.status(409).json({ codigo: 'cobranca_em_confirmacao', erro: MENSAGEM_EM_CONFIRMACAO });
      }

      const { chargeId, boletoUrl, linhaDigitavel, codigoBarras, vencimento } = resultado.cobranca;

      await deps.completarCobranca(resultado.reservaId, {
        chargeId,
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
        cotacaoId: cotacao.id
      });
      void deps.marcarCotacaoUsada(cotacao.id);

      resposta.json({ chargeId, boletoUrl, linhaDigitavel, codigoBarras, vencimento });
    } catch (erro) {
      responderErro(resposta, erro, 'checkout/boleto');
    }
  }

  async function statusBoleto(requisicao, resposta) {
    return statusDaCobranca(requisicao, resposta, 'boleto');
  }

  return { gerarPix, statusPix, gerarBoleto, statusBoleto };
}

export const { gerarPix, statusPix, gerarBoleto, statusBoleto } = criarCheckoutController();

/* ------------------------------------------------------------------
   Autoteste — `node src/controllers/checkoutController.js`
   Sem rede, sem banco: trava a ORDEM (reserva antes de chamar a
   Asaas) e os dois desfechos de falha (recusa limpa libera a reserva;
   falha ambígua não libera e registra em Lei 8) — achado de auditoria
   externa (Codex, 22/09/2026), confirmado lendo o código antes de
   corrigir.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('checkoutController.js')) {
  const { strict: assert } = await import('node:assert');
  let checagens = 0;
  const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

  const PEDIDO_BASE = {
    valorComDesconto: 100, frete: 0, valorCheio: 100, desconto: 0,
    taxaDoProjeto: 0, itens: null, descricao: 'pedido de teste'
  };

  /**
   * `linhas` simula a tabela `cobrancas` de verdade: uma reserva nasce
   * SEM chargeId (`reservarCobranca`), e só ganha um quando
   * `completarCobranca` roda — exatamente como no banco real. É por
   * isso que `buscarCobrancaPendenteDoPedido` só acha a linha depois
   * que a PRIMEIRA chamada terminou, e é isso que o teste 3 (corrida
   * com a primeira já tendo chargeId) precisa pra ser um cenário real,
   * não um chumbado.
   */
  function costura(ajustes = {}) {
    const chamadas = [];
    const anotar = (nome, args) => chamadas.push({ nome, args });
    const linhas = new Map();
    let proximoId = 1;

    const deps = {
      resolverPedido: async () => {
        anotar('resolverPedido', []);
        if (ajustes.pedidoPago) {
          const e = new Error('Este pedido já foi pago.'); e.status = 409; e.codigo = 'pedido_ja_pago'; throw e;
        }
        return { contratante: { id: 'c1', wallet_id: null }, pedido: { ...PEDIDO_BASE, ...ajustes.pedido } };
      },
      /* A cotação (C-02) no dublê: o portão real está no autoteste de
         `cotacaoService`; aqui ele devolve o retrato do próprio pedido
         (o que a tela teria mostrado) — ou lança o 409 quando o teste
         pede, para provar que o POST não cobra sem cotação válida. */
      exigirCotacaoParaCobrar: async ({ cotacaoId, totaisNovos }) => {
        anotar('exigirCotacaoParaCobrar', [cotacaoId]);
        if (ajustes.cotacaoDivergente) {
          const erro = new Error('O valor desta cobrança mudou.');
          erro.status = 409; erro.codigo = 'cotacao_alterada'; erro.cotacao = { id: 'cot_nova', totais: totaisNovos };
          throw erro;
        }
        return { id: cotacaoId ?? 'cot_1', totais: ajustes.totaisDaCotacao ?? totaisNovos };
      },
      marcarCotacaoUsada: async (id) => { anotar('marcarCotacaoUsada', [id]); },
      buscarOuCriarCliente: async () => { anotar('buscarOuCriarCliente', []); return 'cus_1'; },
      criarCobrancaPix: async (dados) => {
        anotar('criarCobrancaPix', [dados]);
        if (ajustes.erroNaCobranca) throw ajustes.erroNaCobranca;
        // Ponto de reentrância pro teste de corrida de verdade: dispara
        // ENQUANTO esta chamada ainda está em andamento — reserva já
        // feita, chargeId ainda não — pra simular a SEGUNDA requisição
        // chegando no meio do caminho da primeira.
        if (ajustes.duranteACobranca) await ajustes.duranteACobranca();
        return { chargeId: 'pay_1', qrCodeBase64: 'QR', copiaECola: 'COPIA' };
      },
      criarCobrancaBoleto: async () => { anotar('criarCobrancaBoleto', []); return {}; },
      consultarStatus: async (chargeId) => { anotar('consultarStatus', [chargeId]); return { status: 'PENDING' }; },
      existeCobrancaDoMetodo: async (chargeId, metodo) => {
        anotar('existeCobrancaDoMetodo', [chargeId, metodo]);
        return (ajustes.cobrancasNossas ?? []).includes(`${metodo}:${chargeId}`);
      },
      recuperarCobrancaPix: async (chargeId) => {
        anotar('recuperarCobrancaPix', [chargeId]);
        if (ajustes.qrFalhaAoRecuperar?.()) throw new Error('Você não possui uma chave Pix cadastrada para recebimentos de cobranças via Pix.');
        return { chargeId, qrCodeBase64: 'QR-reaproveitado', copiaECola: 'COPIA-reaproveitada' };
      },
      recuperarCobrancaBoleto: async () => null,
      reservarCobranca: async ({ contratanteId, pedidoId, metodoPagamento }) => {
        anotar('reservarCobranca', [{ contratanteId, pedidoId, metodoPagamento }]);
        const chave = `${contratanteId}:${pedidoId}:${metodoPagamento}`;
        if (linhas.has(chave)) return { reservada: false };
        const id = `res_${proximoId++}`;
        linhas.set(chave, { id, chargeId: null });
        return { reservada: true, id };
      },
      completarCobranca: async (id, dados) => {
        anotar('completarCobranca', [id, dados]);
        for (const linha of linhas.values()) if (linha.id === id) { linha.chargeId = dados.chargeId; linha.valorCobrado = dados.valorCobrado; }
      },
      liberarReservaCobranca: async (id) => {
        anotar('liberarReservaCobranca', [id]);
        for (const [chave, linha] of linhas) if (linha.id === id) linhas.delete(chave);
      },
      buscarCobrancaPendenteDoPedido: async (contratanteId, pedidoId, metodoPagamento) => {
        anotar('buscarCobrancaPendenteDoPedido', [contratanteId, pedidoId, metodoPagamento]);
        const chave = `${contratanteId}:${pedidoId}:${metodoPagamento}`;
        const linha = linhas.get(chave);
        // Como no banco: `charge_id is not null`, com o valor e a marca de obsoleta da linha.
        return linha?.chargeId ? { charge_id: linha.chargeId, valor_cobrado: linha.valorCobrado ?? null, obsoleta_desde: linha.obsoletaDesde ?? null } : null;
      },
      buscarReservaPendenteDoPedido: async (contratanteId, pedidoId, metodoPagamento) => {
        anotar('buscarReservaPendenteDoPedido', [contratanteId, pedidoId, metodoPagamento]);
        const linha = linhas.get(`${contratanteId}:${pedidoId}:${metodoPagamento}`);
        return linha && !linha.chargeId ? { id: linha.id } : null;
      },
      listarPagamentosPorReferenciaExterna: async (ref) => {
        anotar('listarPagamentosPorReferenciaExterna', [ref]);
        return ajustes.naAsaasPorReferencia?.[ref] ?? [];
      },
      completarReservaOrfa: async (id, pagamento) => {
        anotar('completarReservaOrfa', [id, pagamento]);
        // O reconciliador real grava o valor que a Asaas diz (`completarComOQueAAsaasSabe`).
        for (const linha of linhas.values()) if (linha.id === id) { linha.chargeId = pagamento.id; linha.valorCobrado = pagamento.value ?? null; }
      },
      consultarPagamento: async (chargeId) => { anotar('consultarPagamento', [chargeId]); return ajustes.estadoNaAsaas?.[chargeId] ?? { status: 'PENDING', excluida: false }; },
      excluirCobranca: async (chargeId) => {
        anotar('excluirCobranca', [chargeId]);
        if (ajustes.exclusaoFalha) throw ajustes.exclusaoFalha;
        return { excluida: ajustes.exclusaoNaoConfirmada ? false : true };
      },
      aplicarTransicao: async (chargeId, { de, para }) => {
        anotar('aplicarTransicao', [chargeId, de, para]);
        for (const [chave, linha] of linhas) if (linha.chargeId === chargeId && de === 'pendente') linhas.delete(chave); // sai de `pendente`: o índice único libera
        return true;
      },
      registrarErro: async (erro, ctx) => { anotar('registrarErro', [erro, ctx]); }
    };

    return {
      chamadas,
      linhas,
      nomes: () => chamadas.map((c) => c.nome),
      chamou: (nome) => chamadas.some((c) => c.nome === nome),
      ...criarCheckoutController(deps)
    };
  }

  const pedido = (params, body) => ({ params, body });
  function respostaFalsa() {
    const r = { codigo: 200, corpo: null };
    r.status = (c) => { r.codigo = c; return r; };
    r.json = (c) => { r.corpo = c; return r; };
    return r;
  }

  const corpoValido = { nome: 'Fulano de Tal', email: 'f@teste.com', documento: '11144477735', cotacaoId: 'cot_1' };

  /* --- 0. C-02: sem cotação válida NÃO cobra; cobra o que a cotação diz --- */
  {
    const tc = costura({ cotacaoDivergente: true });
    const rc = respostaFalsa();
    await tc.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_0' }, corpoValido), rc);
    conferir(rc.codigo === 409 && rc.corpo?.codigo === 'cotacao_alterada', `cotação divergente responde 409 cotacao_alterada, veio ${rc.codigo}`);
    conferir(rc.corpo?.cotacao?.id === 'cot_nova', 'e leva a cotação NOVA no corpo, para a tela reconfirmar');
    conferir(!tc.chamou('reservarCobranca') && !tc.chamou('criarCobrancaPix'), 'C-02: com cotação divergente, NADA é reservado nem criado na Asaas');

    // o total cobrado é o da COTAÇÃO, não o do pull novo
    const totaisAntigos = { valorBase: 100, pix: { taxaAsaas: 1, taxaPropria: 1.4, taxasTotais: 2.4, valorCobrado: 102.4 } };
    const t0 = costura({ totaisDaCotacao: totaisAntigos, pedido: { valorComDesconto: 999 } });
    await t0.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_0b' }, corpoValido), respostaFalsa());
    const criada = t0.chamadas.find((c) => c.nome === 'criarCobrancaPix');
    conferir(criada?.args[0].valor === 102.4, `C-02: cobra o total da cotação (102.4), nunca o pull novo (veio ${criada?.args[0].valor})`);
    const completada = t0.chamadas.find((c) => c.nome === 'completarCobranca');
    conferir(completada?.args[1].cotacaoId === 'cot_1', 'a cobrança guarda de qual cotação nasceu');
  }

  /* --- 1. caminho feliz: reserva ANTES de chamar a Asaas ------------ */
  let t = costura();
  let r = respostaFalsa();
  await t.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_1' }, corpoValido), r);
  conferir(r.codigo === 200 || r.corpo?.chargeId === 'pay_1', 'Pix criado com sucesso devolve o chargeId');
  const nomes = t.nomes();
  conferir(
    nomes.indexOf('reservarCobranca') < nomes.indexOf('criarCobrancaPix'),
    'A RESERVA ACONTECE ANTES DE CHAMAR A ASAAS — é isso que fecha a corrida'
  );
  conferir(
    nomes.indexOf('criarCobrancaPix') < nomes.indexOf('completarCobranca'),
    'só completa a linha DEPOIS de a Asaas confirmar'
  );
  conferir(t.chamou('completarCobranca'), 'a reserva é completada com os dados reais');
  conferir(!t.chamou('liberarReservaCobranca'), 'sucesso nunca libera a reserva — ela virou a cobrança de verdade');

  /* --- 2. CORRIDA DE VERDADE: a segunda requisição chega ENQUANTO a
     primeira ainda está entre reservar e completar (chargeId ainda não
     existe) — o cenário exato do achado de auditoria (Codex,
     22/09/2026). A segunda nunca chega a chamar a Asaas. ------------ */
  let requisicaoConcorrente = null;
  t = costura({ duranteACobranca: async () => { if (requisicaoConcorrente) await requisicaoConcorrente(); } });
  const r2 = respostaFalsa();
  requisicaoConcorrente = () => t.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_2' }, corpoValido), r2);
  await t.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_2' }, corpoValido), respostaFalsa());
  conferir(
    t.chamadas.filter((c) => c.nome === 'criarCobrancaPix').length === 1,
    'A SEGUNDA CHAMADA, CHEGANDO NO MEIO DA PRIMEIRA, NUNCA CRIA UMA SEGUNDA COBRANÇA NA ASAAS — achado de auditoria (Codex, 22/09/2026)'
  );
  conferir(
    t.chamadas.filter((c) => c.nome === 'reservarCobranca').length === 2,
    'as duas tentaram reservar — só a primeira conseguiu'
  );
  conferir(r2.codigo === 409, `sem chargeId ainda (a primeira não terminou), a segunda responde 409 (tente de novo), veio ${r2.codigo}`);

  /* --- 3. recarregar DEPOIS que a primeira já terminou: reaproveita - */
  t = costura();
  await t.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_3' }, corpoValido), respostaFalsa());
  const r3 = respostaFalsa();
  await t.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_3' }, corpoValido), r3);
  conferir(r3.corpo?.chargeId === 'pay_1' && r3.corpo?.reaproveitada === true, 'com a primeira já concluída, um F5 reaproveita em vez de 409');
  conferir(
    t.chamadas.filter((c) => c.nome === 'criarCobrancaPix').length === 1,
    'e continua nunca criando uma segunda cobrança na Asaas'
  );

  /* --- 4. recusa LIMPA da Asaas libera a reserva -------------------- */
  const erroLimpo = new Error('CPF inválido pra essa operadora');
  erroLimpo.status = 400;
  erroLimpo.corpoAsaas = { errors: [{ description: 'CPF inválido' }] };
  t = costura({ erroNaCobranca: erroLimpo });
  await t.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_4' }, corpoValido), respostaFalsa());
  conferir(t.chamou('liberarReservaCobranca'), 'recusa limpa (400, com corpo) LIBERA a reserva — sabidamente nada foi criado');
  conferir(!t.chamou('registrarErro'), 'e não precisa de Lei 8 — não é um estado ambíguo');

  /* --- 5. falha AMBÍGUA (timeout) NUNCA libera a reserva ------------- */
  const erroTimeout = new Error('A Asaas não respondeu a tempo. Tente de novo em instantes.');
  erroTimeout.status = 504;
  t = costura({ erroNaCobranca: erroTimeout });
  await t.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_5' }, corpoValido), respostaFalsa());
  conferir(!t.chamou('liberarReservaCobranca'), 'TIMEOUT NUNCA LIBERA A RESERVA — não dá pra saber se a Asaas processou');
  conferir(t.chamou('registrarErro'), 'o estado ambíguo fica registrado em Lei 8 pra reconciliação manual');
  const erroRegistrado = t.chamadas.find((c) => c.nome === 'registrarErro');
  conferir(erroRegistrado.args[0].message.includes('ped_5'), 'o erro registrado nomeia o pedido, pra achar a reserva depois');

  /* --- 6. falha 5xx (não timeout) também não libera ------------------ */
  const erro5xx = new Error('erro interno da Asaas');
  erro5xx.status = 500;
  erro5xx.corpoAsaas = { errors: [{ description: 'internal' }] };
  t = costura({ erroNaCobranca: erro5xx });
  await t.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_6' }, corpoValido), respostaFalsa());
  conferir(!t.chamou('liberarReservaCobranca'), '5xx da Asaas também é ambíguo, mesmo com corpo — não libera');

  /* --- 7. 429 (rate limit) também é ambíguo, não uma recusa limpa --- */
  const erro429 = new Error('muitas requisições');
  erro429.status = 429;
  erro429.corpoAsaas = { errors: [{ description: 'rate limit' }] };
  t = costura({ erroNaCobranca: erro429 });
  await t.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_7' }, corpoValido), respostaFalsa());
  conferir(!t.chamou('liberarReservaCobranca'), '429 não é recusa limpa — o efeito colateral do lado da Asaas é desconhecido');

  /* --- 8. `pagamentoJaCriado` vence o status — mesmo um 4xx com corpo
     NUNCA libera quando o pagamento já existe do lado da Asaas. É o
     cenário exato do achado de revisão (Codex, PR #39, 22/09/2026):
     `criarCobrancaPix` cria o pagamento numa chamada e busca o QR Code
     noutra — se a segunda falhar "limpo", o pagamento continua
     existindo, e soltar a reserva abriria a mesma corrida do AUD-001
     por outra porta. --------------------------------------------- */
  const erroQrJaCriado = new Error('Pix pay_ja_criado foi criado na Asaas, mas a busca do QR Code falhou: 404');
  erroQrJaCriado.status = 404;
  erroQrJaCriado.corpoAsaas = { errors: [{ description: 'not found' }] };
  erroQrJaCriado.pagamentoJaCriado = true;
  t = costura({ erroNaCobranca: erroQrJaCriado });
  await t.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_8' }, corpoValido), respostaFalsa());
  conferir(
    !t.chamou('liberarReservaCobranca'),
    '`pagamentoJaCriado` NUNCA libera a reserva, mesmo com status 4xx e corpo — o pagamento já existe'
  );
  conferir(t.chamou('registrarErro'), 'e vira Lei 8 — o QR falhar é problema operacional (conta sem chave Pix)');

  /* --- 8b. O PRIMEIRO PIX REAL (25/09/2026, 01:24 UTC), na ordem em que
     aconteceu: o pagamento é criado, o QR falha porque a conta de
     produção não tinha chave Pix, o pagador clica de novo, e — depois de
     a chave existir — clica mais uma vez. Antes da correção: o 1º
     clique deixava a reserva SEM chargeId, o 2º respondia 409 "Já existe
     uma cobrança sendo criada" (beco sem saída), e só o reconciliador,
     5 minutos depois, amarrava o pagamento. -------------------------- */
  {
    let temChavePix = false;
    const erroSemChave = new Error('Pix pay_x9eixae4vkg6ugzg foi criado na Asaas, mas a busca do QR Code falhou: Você não possui uma chave Pix cadastrada para recebimentos de cobranças via Pix.');
    erroSemChave.status = 400;
    erroSemChave.corpoAsaas = { errors: [{ description: 'Você não possui uma chave Pix cadastrada para recebimentos de cobranças via Pix.' }] };
    erroSemChave.pagamentoJaCriado = true;
    erroSemChave.chargeId = 'pay_x9eixae4vkg6ugzg';
    const tr = costura({ erroNaCobranca: erroSemChave, qrFalhaAoRecuperar: () => !temChavePix });

    const r1 = respostaFalsa();
    await tr.gerarPix(pedido({ contratanteId: 'testemaster', pedidoId: 'ped_isento' }, corpoValido), r1);
    conferir(r1.codigo === 503 && r1.corpo?.codigo === 'qr_indisponivel', `1º clique: 503 qr_indisponivel, veio ${r1.codigo} ${JSON.stringify(r1.corpo)}`);
    conferir(r1.corpo?.chargeId === 'pay_x9eixae4vkg6ugzg', '1º clique: a resposta leva o chargeId do Pix que existe');
    const completou = tr.chamadas.find((c) => c.nome === 'completarCobranca');
    conferir(completou?.args[1].chargeId === 'pay_x9eixae4vkg6ugzg', '1º clique: a reserva é completada com o chargeId NA HORA — não 5 minutos depois pelo reconciliador');
    conferir(completou?.args[1].documento === '11144477735', '1º clique: e com o pagador (o reconciliador não tem como recuperar)');
    conferir(!tr.chamou('liberarReservaCobranca'), '1º clique: a reserva nunca é solta — o Pix existe');

    const r2 = respostaFalsa();
    await tr.gerarPix(pedido({ contratanteId: 'testemaster', pedidoId: 'ped_isento' }, corpoValido), r2);
    conferir(r2.codigo === 503 && r2.corpo?.codigo === 'qr_indisponivel', `2º clique, ainda sem chave: 503 qr_indisponivel — nunca o 409 "sendo criada"; veio ${r2.codigo}`);
    conferir(tr.chamadas.filter((c) => c.nome === 'criarCobrancaPix').length === 1, '2º clique: nenhum segundo Pix é criado');

    temChavePix = true;
    const r3 = respostaFalsa();
    await tr.gerarPix(pedido({ contratanteId: 'testemaster', pedidoId: 'ped_isento' }, corpoValido), r3);
    conferir(r3.codigo === 200 && r3.corpo?.chargeId === 'pay_x9eixae4vkg6ugzg' && r3.corpo?.qrCodeBase64, `3º clique, com chave: o MESMO Pix com QR; veio ${r3.codigo}`);
    conferir(tr.chamadas.filter((c) => c.nome === 'criarCobrancaPix').length === 1, '3º clique: continua um Pix só');
  }

  /* --- 8c. Reserva sem chargeId (a criação deu timeout): o clique
     seguinte confere NA HORA pela referência externa, em vez de 409
     até o reconciliador passar. ---------------------------------------- */
  {
    const erroT = new Error('A Asaas não respondeu a tempo.');
    erroT.status = 504;
    const valorPix = montarTotaisPedido(PEDIDO_BASE).pix.valorCobrado;
    let tt = costura({ erroNaCobranca: erroT, naAsaasPorReferencia: { 'reserva-res_1': [{ id: 'pay_perdido', status: 'PENDING', value: valorPix }] } });
    await tt.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_t' }, corpoValido), respostaFalsa());
    const rt = respostaFalsa();
    await tt.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_t' }, corpoValido), rt);
    conferir(tt.chamadas.some((c) => c.nome === 'completarReservaOrfa' && c.args[1].id === 'pay_perdido'), 'o Pix achado pela referência COMPLETA a reserva (valor da Asaas + eventos reenfileirados), não só amarra o id');
    conferir(rt.codigo === 200 && rt.corpo?.chargeId === 'pay_perdido', `e o pagador recebe o QR dele; veio ${rt.codigo}`);
    conferir(tt.chamadas.filter((c) => c.nome === 'criarCobrancaPix').length === 1, 'sem criar outro');

    tt = costura({ erroNaCobranca: erroT });
    await tt.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_t2' }, corpoValido), respostaFalsa());
    const rn = respostaFalsa();
    await tt.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_t2' }, corpoValido), rn);
    conferir(rn.codigo === 409 && rn.corpo?.codigo === 'cobranca_em_confirmacao', `nada na Asaas ainda: 409 cobranca_em_confirmacao; veio ${rn.codigo}`);
    conferir(!tt.chamou('liberarReservaCobranca'), 'e a reserva ambígua continua de pé');
  }

  /* --- 9. `referenciaExterna` vem do id da RESERVA, não de
     documento+timestamp — é o que torna uma reserva travada (caso 5/6/7
     acima) localizável na Asaas por quem for reconciliar na mão
     (achado de revisão externa, mesma rodada). --------------------- */
  t = costura();
  await t.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_9' }, corpoValido), respostaFalsa());
  const chamadaCriarPix = t.chamadas.find((c) => c.nome === 'criarCobrancaPix');
  conferir(
    /^reserva-res_\d+$/.test(chamadaCriarPix.args[0].referenciaExterna),
    `referenciaExterna precisa ser derivada do id da reserva local (formato "reserva-<id>"), veio "${chamadaCriarPix.args[0].referenciaExterna}"`
  );

  /* --- 11. SEC-004: o instrumento pendente só volta DEPOIS da guarda de
     pedido pago e da cotação, e só se for o instrumento vigente pelo
     preço desta tela. ------------------------------------------------- */
  {
    // (a) pedido pago no cartão, Pix pendente ainda existe NO MESMO banco: não é devolvido.
    const ajustesA = {};
    const a1 = costura(ajustesA);
    await a1.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_pago' }, corpoValido), respostaFalsa()); // cria o Pix
    conferir([...a1.linhas.values()].some((l) => l.chargeId === 'pay_1'), 'controle: o Pix pendente existe na linha');
    const nomesA = a1.nomes();
    conferir(nomesA.indexOf('resolverPedido') < nomesA.indexOf('buscarCobrancaPendenteDoPedido'), 'a ordem: pull/guarda → cotação → reaproveitamento');
    ajustesA.pedidoPago = true; // o cartão pagou; o Pix ainda não foi excluído
    const antes = a1.chamadas.length;
    const ra = respostaFalsa();
    await a1.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_pago' }, corpoValido), ra);
    conferir(ra.codigo === 409 && ra.corpo?.codigo === 'pedido_ja_pago', `pedido pago: 409 pedido_ja_pago, veio ${ra.codigo} ${JSON.stringify(ra.corpo)}`);
    const depois = a1.chamadas.slice(antes).map((c) => c.nome);
    conferir(!depois.includes('buscarCobrancaPendenteDoPedido') && !depois.includes('recuperarCobrancaPix'), `pedido pago: o Pix pendente NÃO volta — nem é procurado (chamou ${depois.join(', ')})`);

    // (b) instrumento OBSOLETO (RN-51): nunca volta a ser entregue.
    const tbo = costura();
    await tbo.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_obs' }, corpoValido), respostaFalsa());
    for (const linha of tbo.linhas.values()) linha.obsoletaDesde = '2026-09-25T12:00:00Z';
    const rb = respostaFalsa();
    await tbo.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_obs' }, corpoValido), rb);
    conferir(rb.codigo === 409 && rb.corpo?.codigo === 'cobranca_em_confirmacao', `obsoleto: 409, veio ${rb.codigo}`);
    conferir(tbo.chamadas.filter((c) => c.nome === 'recuperarCobrancaPix').length === 0, 'obsoleto: o QR antigo não é recuperado');
    conferir(tbo.chamadas.filter((c) => c.nome === 'criarCobrancaPix').length === 1, 'obsoleto: e nenhum Pix novo nasce enquanto o antigo não sai');

    // (c) PREÇO MUDOU: o antigo é excluído na Asaas ANTES de nascer o novo.
    const ajustesPreco = { pedido: {} };
    const tc = costura(ajustesPreco);
    await tc.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_preco' }, corpoValido), respostaFalsa());
    ajustesPreco.pedido = { valorComDesconto: 80, valorCheio: 80 };
    const rc = respostaFalsa();
    await tc.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_preco' }, corpoValido), rc);
    const nomesC = tc.nomes();
    conferir(tc.chamou('excluirCobranca'), 'preço mudou: o Pix antigo é excluído na Asaas');
    conferir(nomesC.indexOf('consultarPagamento') < nomesC.indexOf('excluirCobranca'), 'lê o estado ANTES de excluir');
    conferir(nomesC.lastIndexOf('excluirCobranca') < nomesC.lastIndexOf('criarCobrancaPix'), 'e só DEPOIS cria o novo — nunca dois pagáveis');
    const novo = tc.chamadas.filter((c) => c.nome === 'criarCobrancaPix').at(-1).args[0];
    conferir(novo.valor === montarTotaisPedido({ ...PEDIDO_BASE, valorComDesconto: 80, valorCheio: 80 }).pix.valorCobrado, `o novo Pix cobra o preço NOVO (veio ${novo.valor})`);
    conferir(rc.corpo?.chargeId === 'pay_1' && !rc.corpo?.reaproveitada, 'e a resposta é o Pix novo, não o reaproveitado');

    // (d) preço mudou mas o antigo JÁ FOI PAGO: não exclui, não cria outro.
    const ajustesPago2 = { pedido: {}, estadoNaAsaas: { pay_1: { status: 'RECEIVED', excluida: false } } };
    const td = costura(ajustesPago2);
    await td.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_pago2' }, corpoValido), respostaFalsa());
    ajustesPago2.pedido = { valorComDesconto: 80, valorCheio: 80 };
    const rd = respostaFalsa();
    await td.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_pago2' }, corpoValido), rd);
    conferir(rd.codigo === 409 && rd.corpo?.codigo === 'pagamento_em_processamento', `antigo pago: 409 pagamento_em_processamento, veio ${rd.codigo}`);
    conferir(!td.chamou('excluirCobranca'), 'antigo pago: NUNCA se exclui o que foi pago');
    conferir(td.chamadas.filter((c) => c.nome === 'criarCobrancaPix').length === 1, 'antigo pago: nenhum Pix novo');

    // (e) preço mudou e a exclusão FALHA: nada novo nasce.
    const ajustesFalha = { pedido: {}, exclusaoFalha: Object.assign(new Error('A Asaas não respondeu a tempo.'), { status: 504 }) };
    const te = costura(ajustesFalha);
    await te.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_falha' }, corpoValido), respostaFalsa());
    ajustesFalha.pedido = { valorComDesconto: 80, valorCheio: 80 };
    const re = respostaFalsa();
    await te.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_falha' }, corpoValido), re);
    conferir(re.codigo === 409 && re.corpo?.codigo === 'cobranca_em_confirmacao', `exclusão falhou: 409 tente de novo, veio ${re.codigo}`);
    conferir(te.chamadas.filter((c) => c.nome === 'criarCobrancaPix').length === 1, 'exclusão falhou: nenhum Pix novo');

    // (e2) a Asaas responde 200 mas NÃO confirma a exclusão (`deleted: false`): nada novo nasce.
    const ajustesNaoConf = { pedido: {}, exclusaoNaoConfirmada: true };
    const te2 = costura(ajustesNaoConf);
    await te2.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_nconf' }, corpoValido), respostaFalsa());
    ajustesNaoConf.pedido = { valorComDesconto: 80, valorCheio: 80 };
    const re2 = respostaFalsa();
    await te2.gerarPix(pedido({ contratanteId: 'c1', pedidoId: 'ped_nconf' }, corpoValido), re2);
    conferir(re2.codigo === 409 && te2.chamadas.filter((c) => c.nome === 'criarCobrancaPix').length === 1, `exclusão não confirmada: 409 e nenhum Pix novo, veio ${re2.codigo}`);
    conferir(!te2.chamou('aplicarTransicao'), 'e a linha antiga continua pendente — ninguém a dá por cancelada');

    // (f) boleto: mesma guarda antes do reaproveitamento.
    const tf = costura({ pedidoPago: true });
    const rf = respostaFalsa();
    await tf.gerarBoleto(pedido({ contratanteId: 'c1', pedidoId: 'ped_bol' }, corpoValido), rf);
    conferir(rf.codigo === 409 && !tf.chamou('buscarCobrancaPendenteDoPedido'), 'boleto de pedido pago: 409 sem nem procurar o pendente');
  }

  /* --- 10. SEC-017: a rota PÚBLICA de status só vai à Asaas (com a
     chave da conta-mãe) para uma cobrança que é NOSSA e do método da
     rota. Id de outro objeto da conta, ou de outro método, é 404 nosso —
     sem consulta autenticada e sem o texto de erro da Asaas. ---------- */
  {
    const ts = costura({ cobrancasNossas: ['pix:pay_nosso', 'boleto:pay_boleto'] });
    const rOk = respostaFalsa();
    await ts.statusPix(pedido({ chargeId: 'pay_nosso' }), rOk);
    conferir(rOk.codigo === 200 && rOk.corpo?.status === 'PENDING', `cobrança nossa: 200 com o status; veio ${rOk.codigo}`);
    conferir(ts.chamadas.filter((c) => c.nome === 'consultarStatus').length === 1, 'e só então consulta a Asaas');

    for (const [rota, chargeId, nome] of [
      ['statusPix', 'pay_de_outro', 'id que não é nosso'],
      ['statusPix', 'pay_boleto', 'id nosso, mas de BOLETO, na rota do Pix'],
      ['statusBoleto', 'pay_nosso', 'id nosso, mas de PIX, na rota do boleto']
    ]) {
      const tn = costura({ cobrancasNossas: ['pix:pay_nosso', 'boleto:pay_boleto'] });
      const rn = respostaFalsa();
      await tn[rota](pedido({ chargeId }), rn);
      conferir(rn.codigo === 404 && rn.corpo?.erro === 'Cobrança não encontrada.', `${nome}: 404 nosso; veio ${rn.codigo} ${JSON.stringify(rn.corpo)}`);
      conferir(!tn.chamou('consultarStatus'), `${nome}: a Asaas NUNCA é consultada`);
    }
    const tb = costura({ cobrancasNossas: ['boleto:pay_boleto'] });
    const rb = respostaFalsa();
    await tb.statusBoleto(pedido({ chargeId: 'pay_boleto' }), rb);
    conferir(rb.codigo === 200 && rb.corpo?.status === 'PENDING', `boleto nosso: 200; veio ${rb.codigo}`);
  }

  console.log(`checkoutController: ${checagens} checagens OK`);
}
