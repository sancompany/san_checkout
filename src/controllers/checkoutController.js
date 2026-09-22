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
import { calcularTaxa } from '../services/taxaService.js';
import {
  buscarOuCriarCliente,
  criarCobrancaPix,
  criarCobrancaBoleto,
  consultarStatus,
  recuperarCobrancaPix,
  recuperarCobrancaBoleto
} from '../services/asaasService.js';
import {
  reservarCobranca,
  completarCobranca,
  liberarReservaCobranca,
  buscarCobrancaPendenteDoPedido
} from '../services/cobrancaService.js';
import {
  documentoValido, emailValido, valorValido, nomeValido, telefoneValido,
  normalizarDocumento,
  valorCobradoAceitavel, MENSAGEM_PISO_ASAAS
} from '../utils/validadores.js';
import { responderErro } from '../utils/erros.js';
import { registrarErro } from '../services/erroService.js';

function gerarReferenciaExterna(documento) {
  return `${documento}-${Date.now()}`;
}

const dependenciasPadrao = {
  resolverPedido,
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
async function reaproveitarCobrancaPendente(deps, { contratanteId, pedidoId, metodo, recuperar }) {
  try {
    const pendente = await deps.buscarCobrancaPendenteDoPedido(contratanteId, pedidoId, metodo);
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

/**
 * Um erro da Asaas conta como "recusa limpa" — com certeza absoluta de
 * que NADA foi criado do lado dela — só quando veio um corpo de
 * resposta reconhecido num status 4xx que não seja de rate limit. Tudo
 * o mais (timeout, 5xx, 429, erro de rede sem status) é AMBÍGUO: a
 * Asaas pode ter processado e a resposta se perdido no caminho.
 */
function foiRecusaLimpaDaAsaas(erro) {
  return Boolean(
    erro?.corpoAsaas &&
    typeof erro.status === 'number' &&
    erro.status >= 400 &&
    erro.status < 500 &&
    erro.status !== 429
  );
}

/**
 * A coreografia reserva→cobra→completa, compartilhada por Pix e Boleto.
 * O que muda entre os dois é só O QUE cobrar (`cobrar`) — a ordem que
 * impede a cobrança duplicada é sempre a mesma.
 *
 * @returns {Promise<{tipo: 'corrida'}|{tipo: 'criada', reservaId: string, cobranca: object}>}
 */
async function cobrarComReserva(deps, { contratanteId, pedidoId, metodoPagamento, cobrar }) {
  const reserva = await deps.reservarCobranca({ contratanteId, pedidoId, metodoPagamento });
  if (!reserva.reservada) return { tipo: 'corrida' };

  let cobranca;
  try {
    cobranca = await cobrar();
  } catch (erroAsaas) {
    if (foiRecusaLimpaDaAsaas(erroAsaas)) {
      await deps.liberarReservaCobranca(reserva.id);
    } else {
      await deps.registrarErro(
        new Error(
          `${metodoPagamento}: criação na Asaas falhou de forma AMBÍGUA para o pedido ${pedidoId} ` +
          `(contratante ${contratanteId}, reserva ${reserva.id}) — NÃO SE SABE se a cobrança foi criada: ` +
          `${erroAsaas.message}. A reserva foi mantida de propósito (nunca solta em caso ambíguo, pra não ` +
          `permitir que uma nova tentativa crie uma segunda cobrança de verdade) — confira na Asaas por ` +
          `externalReference antes de liberar esta reserva na mão.`
        ),
        { contexto: 'checkoutController.cobrarComReserva', rota: `checkout/${metodoPagamento}`, metodo: 'POST' }
      );
    }
    throw erroAsaas;
  }

  return { tipo: 'criada', reservaId: reserva.id, cobranca };
}

export function criarCheckoutController(deps = dependenciasPadrao) {
  async function gerarPix(requisicao, resposta) {
    const { contratanteId, pedidoId } = requisicao.params;
    let { nome, email, documento, telefone } = requisicao.body ?? {};

    if (!nome || !email || !documento) {
      return resposta.status(400).json({ erro: 'Nome, e-mail e CPF/CNPJ são obrigatórios.' });
    }
    if (!nomeValido(nome)) return resposta.status(400).json({ erro: 'Nome inválido.' });
    if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });

    // O documento vira DÍGITOS aqui, e daqui para baixo é só esta forma.
    documento = normalizarDocumento(documento);
    if (!emailValido(email)) return resposta.status(400).json({ erro: 'E-mail inválido.' });
    if (telefone && !telefoneValido(telefone)) return resposta.status(400).json({ erro: 'Telefone inválido.' });

    try {
      const { contratante, pedido } = await deps.resolverPedido(contratanteId, pedidoId, { metodoRequerido: 'pix' });

      // Antes de criar: esse pedido já tem Pix pendente e pagável?
      const jaExiste = await reaproveitarCobrancaPendente(deps, {
        contratanteId, pedidoId, metodo: 'pix', recuperar: deps.recuperarCobrancaPix
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

      const { taxaAsaas, taxaPropria, valorCobrado } = calcularTaxa(valorBase, 'pix', 1, Boolean(pedido.isentarTaxa));

      if (!valorCobradoAceitavel(valorCobrado)) {
        return resposta.status(400).json({ erro: MENSAGEM_PISO_ASAAS });
      }

      const clienteId = await deps.buscarOuCriarCliente({ nome, email, documento });

      const split = contratante?.wallet_id
        ? [{ walletId: contratante.wallet_id, fixedValue: valorBase }]
        : undefined;

      const resultado = await cobrarComReserva(deps, {
        contratanteId, pedidoId, metodoPagamento: 'pix',
        cobrar: () => deps.criarCobrancaPix({
          clienteId,
          valor: valorCobrado,
          descricao: pedido.descricao ?? 'Pagamento via SAN & CO. Pay Engine',
          referenciaExterna: gerarReferenciaExterna(documento),
          split
        })
      });

      if (resultado.tipo === 'corrida') {
        const reaproveitada = await reaproveitarCobrancaPendente(deps, {
          contratanteId, pedidoId, metodo: 'pix', recuperar: deps.recuperarCobrancaPix
        });
        if (reaproveitada) {
          return resposta.json({
            chargeId: reaproveitada.chargeId,
            qrCodeBase64: reaproveitada.qrCodeBase64,
            copiaECola: reaproveitada.copiaECola,
            reaproveitada: true
          });
        }
        return resposta.status(409).json({ erro: 'Já existe uma cobrança sendo criada para este pedido. Tente novamente em instantes.' });
      }

      const { chargeId, qrCodeBase64, copiaECola } = resultado.cobranca;

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
        valorCobrado
      });

      resposta.json({ chargeId, qrCodeBase64, copiaECola });
    } catch (erro) {
      responderErro(resposta, erro, 'checkout/pix');
    }
  }

  async function statusPix(requisicao, resposta) {
    try {
      const { status } = await deps.consultarStatus(requisicao.params.chargeId);
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
  async function gerarBoleto(requisicao, resposta) {
    const { contratanteId, pedidoId } = requisicao.params;
    let { nome, email, documento, telefone } = requisicao.body ?? {};

    if (!nome || !email || !documento) {
      return resposta.status(400).json({ erro: 'Nome, e-mail e CPF/CNPJ são obrigatórios.' });
    }
    if (!nomeValido(nome)) return resposta.status(400).json({ erro: 'Nome inválido.' });
    if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });

    documento = normalizarDocumento(documento);
    if (!emailValido(email)) return resposta.status(400).json({ erro: 'E-mail inválido.' });
    if (telefone && !telefoneValido(telefone)) return resposta.status(400).json({ erro: 'Telefone inválido.' });

    try {
      const { contratante, pedido } = await deps.resolverPedido(contratanteId, pedidoId, { metodoRequerido: 'boleto' });

      // Reforço de segurança — o front já esconde o Boleto quando o
      // pedido tem expiraEm (API.md §4.1), mas o backend NUNCA
      // confia só na validação do front.
      if (pedido.expiraEm) {
        return resposta.status(400).json({ erro: 'Este pedido tem prazo de expiração e não aceita Boleto.' });
      }

      // Boleto duplicado é pior que Pix duplicado: o antigo segue pagável
      // por dias. Mesma checagem, mesmo motivo.
      const jaExiste = await reaproveitarCobrancaPendente(deps, {
        contratanteId, pedidoId, metodo: 'boleto', recuperar: deps.recuperarCobrancaBoleto
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

      const { taxaAsaas, taxaPropria, valorCobrado } = calcularTaxa(valorBase, 'boleto', 1, Boolean(pedido.isentarTaxa));

      if (!valorCobradoAceitavel(valorCobrado)) {
        return resposta.status(400).json({ erro: MENSAGEM_PISO_ASAAS });
      }

      const clienteId = await deps.buscarOuCriarCliente({ nome, email, documento });

      const split = contratante?.wallet_id
        ? [{ walletId: contratante.wallet_id, fixedValue: valorBase }]
        : undefined;

      const resultado = await cobrarComReserva(deps, {
        contratanteId, pedidoId, metodoPagamento: 'boleto',
        cobrar: () => deps.criarCobrancaBoleto({
          clienteId,
          valor: valorCobrado,
          descricao: pedido.descricao ?? 'Pagamento via SAN & CO. Pay Engine',
          referenciaExterna: gerarReferenciaExterna(documento),
          split
        })
      });

      if (resultado.tipo === 'corrida') {
        const reaproveitada = await reaproveitarCobrancaPendente(deps, {
          contratanteId, pedidoId, metodo: 'boleto', recuperar: deps.recuperarCobrancaBoleto
        });
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
        return resposta.status(409).json({ erro: 'Já existe uma cobrança sendo criada para este pedido. Tente novamente em instantes.' });
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
        valorCobrado
      });

      resposta.json({ chargeId, boletoUrl, linhaDigitavel, codigoBarras, vencimento });
    } catch (erro) {
      responderErro(resposta, erro, 'checkout/boleto');
    }
  }

  async function statusBoleto(requisicao, resposta) {
    try {
      const { status } = await deps.consultarStatus(requisicao.params.chargeId);
      resposta.json({ status });
    } catch (erro) {
      responderErro(resposta, erro, 'checkout/boleto/status');
    }
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
      resolverPedido: async () => ({
        contratante: { id: 'c1', wallet_id: null },
        pedido: { ...PEDIDO_BASE, ...ajustes.pedido }
      }),
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
      consultarStatus: async () => ({ status: 'PENDING' }),
      recuperarCobrancaPix: async (chargeId) => {
        anotar('recuperarCobrancaPix', [chargeId]);
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
        for (const linha of linhas.values()) if (linha.id === id) linha.chargeId = dados.chargeId;
      },
      liberarReservaCobranca: async (id) => {
        anotar('liberarReservaCobranca', [id]);
        for (const [chave, linha] of linhas) if (linha.id === id) linhas.delete(chave);
      },
      buscarCobrancaPendenteDoPedido: async (contratanteId, pedidoId, metodoPagamento) => {
        anotar('buscarCobrancaPendenteDoPedido', [contratanteId, pedidoId, metodoPagamento]);
        const chave = `${contratanteId}:${pedidoId}:${metodoPagamento}`;
        const linha = linhas.get(chave);
        return linha ? { charge_id: linha.chargeId } : null;
      },
      registrarErro: async (erro, ctx) => { anotar('registrarErro', [erro, ctx]); }
    };

    return {
      chamadas,
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

  const corpoValido = { nome: 'Fulano de Tal', email: 'f@teste.com', documento: '11144477735' };

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

  console.log(`checkoutController: ${checagens} checagens OK`);
}
