/**
 * SAN CHECKOUT — src/controllers/cobrancaConsultaController.js
 *
 * Duas formas de perguntar "o que aconteceu com esse pedido?", com
 * exposições diferentes de propósito:
 *
 *   1. `statusPublico`  — GET /api/checkout/status/:contratanteId/:pedidoId
 *      Sem autenticação, pro COMPRADOR. Alimenta a página
 *      `public/status.html`, que devolve o Pix/boleto de quem fechou a
 *      aba e precisa da segunda via. Não devolve NENHUM dado pessoal.
 *
 *   2. `consultarCobranca` — GET /api/checkout/cobranca/:contratanteId/:pedidoId
 *      Autenticada por X-Checkout-Key, pro CONTRATANTE. Devolve o mesmo
 *      payload do webhook, pra ele conciliar quando a notificação se
 *      perder (o retry é em memória: se o servidor dele cair na hora, a
 *      notificação some e o pagamento fica confirmado só do nosso lado).
 *
 *   3. `consultarAssinatura` — POST /api/checkout/consultar-assinatura
 *      A mesma rede de segurança do item 2, mas pra RECORRÊNCIA. Existe
 *      separada porque a busca é outra: cobrança de assinatura é gravada
 *      com `plano_id`, não `pedido_id`, então a rota acima nunca a
 *      alcançava — assinatura ficava com a fila de notificação frágil e
 *      sem nenhuma conciliação automática.
 *
 *      É POST, e não GET, pelo mesmo motivo de cancelar/pausar/retomar:
 *      o par que identifica o assinante inclui o CPF/CNPJ, e documento
 *      em path de URL vaza pra log de acesso, histórico e referer.
 *
 * Por que a rota pública pode ser pública: ela só é alcançável por quem
 * já tem o `pedidoId`, e desde a v3.2 o checkout exige que esse id seja
 * imprevisível (`exigirIdImprevisivel`, pedidoService.js). Sem aquela
 * regra, esta rota seria uma porta de enumeração — as duas coisas são
 * uma decisão só.
 */

import { buscarContratantePorChave } from '../services/pedidoService.js';
import {
  buscarCobrancaPorPedido,
  buscarUltimaCobrancaDaAssinatura,
  atualizarStatusCobranca
} from '../services/cobrancaService.js';
import { buscarAssinaturaAtiva } from '../services/assinaturaService.js';
import {
  recuperarCobrancaPix,
  recuperarCobrancaBoleto,
  consultarStatus,
  consultarAssinaturaNaAsaas
} from '../services/asaasService.js';
import { atualizarStatusAssinatura } from '../services/assinaturaService.js';
import { documentoValido } from '../utils/validadores.js';
import { responderErro } from '../utils/erros.js';

/** Status locais em que ainda faz sentido mostrar como pagar. */
const STATUS_AINDA_PAGAVEL = ['pendente', 'em_analise'];

/**
 * A Asaas é a fonte da verdade do pagamento; nosso banco só reflete o
 * que o webhook trouxe. Se o webhook falhou ou atrasou, o local está
 * velho — então reconsulta a Asaas quando ainda parece pendente, e
 * corrige o banco se tiver mudado.
 *
 * Silencioso de propósito: falha ao consultar a Asaas não pode derrubar
 * a tela do comprador. Cai pro status local, que é pior mas serve.
 */
async function statusAtualizado(cobranca) {
  if (!cobranca.charge_id || !STATUS_AINDA_PAGAVEL.includes(cobranca.status)) {
    return cobranca.status;
  }

  try {
    const { status: statusAsaas } = await consultarStatus(cobranca.charge_id);
    const confirmado = statusAsaas === 'RECEIVED' || statusAsaas === 'CONFIRMED';
    if (!confirmado) return cobranca.status;

    await atualizarStatusCobranca(cobranca.charge_id, 'confirmado');
    return 'confirmado';
  } catch (erro) {
    console.error(`[consulta] falha ao reconsultar ${cobranca.charge_id} na Asaas:`, erro.message);
    return cobranca.status;
  }
}

/**
 * O ESTADO DA ASSINATURA também vem da Asaas, não só o da cobrança.
 *
 * Até 16/09/2026 esta rota reconciliava só a última cobrança
 * (`statusAtualizado`) — o `status` da própria assinatura vinha 100% do
 * banco local. Isso deixava um buraco sem detecção: se
 * `cancelar/pausar/retomar-assinatura` estourasse o timeout DEPOIS de a
 * Asaas já ter processado o `DELETE`/`PUT` (só a resposta perdida), o
 * controller devolvia erro e nunca gravava o status novo — o nosso banco
 * dizia `ativa` pra sempre enquanto a Asaas já tinha cancelado.
 *
 * Por que aqui e não num job: é esta a rota que o contratante já roda
 * pra conciliar (§5.3, "rode uma vez por dia"). Um lugar a mais pra
 * manter não ganharia nada.
 *
 * Silencioso ao falhar, igual `statusAtualizado`: a Asaas fora do ar não
 * pode derrubar a conciliação inteira — cai pro que o banco sabe, que é
 * pior mas serve.
 */
const STATUS_ASAAS_PARA_LOCAL = { ACTIVE: 'ativa', INACTIVE: 'pausada' };

async function assinaturaAtualizada(assinatura) {
  if (!assinatura?.id) return { status: assinatura?.status ?? null, proximaCobranca: assinatura?.proxima_cobranca ?? null };

  try {
    const viva = await consultarAssinaturaNaAsaas(assinatura.id);

    // `null` = 404 na Asaas. NÃO vira "cancelada" automaticamente: 404
    // também é o que responde um id de outra conta ou digitado errado, e
    // marcar cancelada por engano é pior que ficar com o dado velho.
    if (!viva) {
      console.error(`[consulta] assinatura ${assinatura.id} não existe na Asaas (404) — mantendo o status local "${assinatura.status}".`);
      return { status: assinatura.status, proximaCobranca: assinatura.proxima_cobranca ?? null };
    }

    const statusReal = viva.encerrada ? 'cancelada' : (STATUS_ASAAS_PARA_LOCAL[viva.status] ?? assinatura.status);

    if (statusReal !== assinatura.status) {
      console.error(`[consulta] divergência corrigida: assinatura ${assinatura.id} estava "${assinatura.status}" aqui e "${viva.status}${viva.deleted ? '/deleted' : ''}" na Asaas.`);
      await atualizarStatusAssinatura(assinatura.id, statusReal);
    }

    // `proximaCobranca` sai do `null` eterno: `nextDueDate` existe nesta
    // resposta (o que nenhum payload de webhook trazia, que é por que o
    // campo nasceu nulo — ver docs/pendencias.md).
    return { status: statusReal, proximaCobranca: viva.proximaCobranca ?? assinatura.proxima_cobranca ?? null };
  } catch (erro) {
    console.error(`[consulta] falha ao reconsultar a assinatura ${assinatura.id} na Asaas:`, erro.message);
    return { status: assinatura.status, proximaCobranca: assinatura.proxima_cobranca ?? null };
  }
}

/** Busca as credenciais de pagamento de novo (QR, linha digitável). */
async function credenciaisDePagamento(cobranca) {
  if (cobranca.metodo_pagamento === 'pix') {
    const viva = await recuperarCobrancaPix(cobranca.charge_id);
    return viva && { qrCodeBase64: viva.qrCodeBase64, copiaECola: viva.copiaECola };
  }

  if (cobranca.metodo_pagamento === 'boleto') {
    const viva = await recuperarCobrancaBoleto(cobranca.charge_id);
    return viva && {
      boletoUrl: viva.boletoUrl,
      linhaDigitavel: viva.linhaDigitavel,
      codigoBarras: viva.codigoBarras,
      vencimento: viva.vencimento
    };
  }

  // Cartão/assinatura passam pela pop-up da Asaas — não existe
  // "segunda via" pra devolver aqui.
  return null;
}

/**
 * GET /api/checkout/status/:contratanteId/:pedidoId — PÚBLICA.
 *
 * Devolve só o necessário pra pessoa saber se pagou e, se ainda não,
 * como pagar. Nada de documento, e-mail, telefone ou endereço: quem
 * abre esta rota provou que tem o link, não que é o dono do pedido.
 */
export async function statusPublico(requisicao, resposta) {
  const { contratanteId, pedidoId } = requisicao.params;

  try {
    const cobranca = await buscarCobrancaPorPedido(contratanteId, pedidoId);
    if (!cobranca) {
      return resposta.status(404).json({ erro: 'Nenhuma cobrança encontrada para este pedido.' });
    }

    const status = await statusAtualizado(cobranca);
    const pagamento = STATUS_AINDA_PAGAVEL.includes(status)
      ? await credenciaisDePagamento(cobranca).catch(() => null)
      : null;

    resposta.json({
      pedidoId: cobranca.pedido_id,
      status,
      metodoPagamento: cobranca.metodo_pagamento,
      valorCobrado: cobranca.valor_cobrado,
      criadoEm: cobranca.criado_em,
      pagamento: pagamento ?? null
    });
  } catch (erro) {
    responderErro(resposta, erro, 'consulta.statusPublico');
  }
}

/**
 * GET /api/checkout/cobranca/:contratanteId/:pedidoId — AUTENTICADA.
 *
 * O `contratanteId` da URL precisa bater com o dono da chave: sem isso,
 * um contratante com chave válida poderia ler cobrança de outro só
 * trocando o id na URL.
 */
export async function consultarCobranca(requisicao, resposta) {
  const { contratanteId, pedidoId } = requisicao.params;
  const chave = requisicao.get('X-Checkout-Key');

  if (!chave) return resposta.status(401).json({ erro: 'X-Checkout-Key ausente.' });

  try {
    const contratante = await buscarContratantePorChave(chave);
    if (!contratante) return resposta.status(401).json({ erro: 'Chave inválida.' });
    if (contratante.id !== contratanteId) {
      return resposta.status(403).json({ erro: 'Esta chave não pertence ao contratante informado.' });
    }

    const cobranca = await buscarCobrancaPorPedido(contratanteId, pedidoId);
    if (!cobranca) {
      return resposta.status(404).json({ erro: 'Nenhuma cobrança encontrada para este pedido.' });
    }

    const status = await statusAtualizado(cobranca);

    // Mesmo formato do webhook (INTEGRACAO.md seção 4.2), de propósito:
    // o contratante reaproveita o código que já escreveu pra tratar a
    // notificação, sem um segundo parser.
    resposta.json({
      versao: 1,
      pedidoId: cobranca.pedido_id,
      chargeId: cobranca.charge_id,
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
      valorCobrado: cobranca.valor_cobrado,
      criadoEm: cobranca.criado_em
    });
  } catch (erro) {
    responderErro(resposta, erro, 'consulta.consultarCobranca');
  }
}

/**
 * POST /api/checkout/consultar-assinatura — AUTENTICADA.
 * Header: X-Checkout-Key · Body: { planoId, documento }
 *
 * Mesma autenticação e mesmo body de cancelar/pausar/retomar, de
 * propósito: quem já chama aquelas três não precisa aprender nada novo
 * pra conciliar.
 *
 * Todos os status de assinatura são aceitos na busca (inclusive
 * `cancelada`) — quem concilia precisa justamente distinguir "cancelou"
 * de "nunca existiu", e uma busca só por `ativa` devolveria 404 nos dois
 * casos.
 */
const STATUS_ASSINATURA_TODOS = ['ativa', 'pausada', 'cancelada'];

export async function consultarAssinatura(requisicao, resposta) {
  const chave = requisicao.get('X-Checkout-Key');
  const { planoId, documento } = requisicao.body ?? {};

  if (!chave) return resposta.status(401).json({ erro: 'X-Checkout-Key ausente.' });
  if (!planoId || !documento) return resposta.status(400).json({ erro: 'planoId e documento são obrigatórios.' });
  if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });

  try {
    const contratante = await buscarContratantePorChave(chave);
    if (!contratante) return resposta.status(401).json({ erro: 'Chave inválida.' });

    const assinatura = await buscarAssinaturaAtiva(
      contratante.id, planoId, documento, STATUS_ASSINATURA_TODOS
    );
    const ultima = await buscarUltimaCobrancaDaAssinatura(contratante.id, planoId, documento);

    // As duas buscas, e não só a primeira: a linha em `assinaturas` só
    // nasce quando a 1ª cobrança confirma. Uma tentativa que ficou
    // pendente (ou que foi paga e cujo webhook se perdeu) existe só em
    // `cobrancas` — e é EXATAMENTE esse o caso que a conciliação
    // precisa enxergar. Responder 404 aqui esconderia o pagamento
    // perdido, que é o problema que esta rota veio resolver.
    if (!assinatura && !ultima) {
      return resposta.status(404).json({ erro: 'Nenhuma assinatura encontrada pra esse plano/documento.' });
    }

    // Reconsulta a Asaas se a última cobrança ainda parece pendente —
    // mesma correção que a consulta de pedido faz, mesmo motivo.
    const statusUltima = ultima ? await statusAtualizado(ultima) : null;

    // E o estado da própria assinatura, que antes só vinha do banco.
    const assinaturaViva = await assinaturaAtualizada(assinatura);

    resposta.json({
      versao: 1,
      tipo: 'assinatura',
      planoId,
      documento,
      assinaturaId: assinatura?.id ?? null,
      status: assinaturaViva.status,
      valor: assinatura?.valor ?? null,
      ciclo: assinatura?.ciclo ?? null,
      proximaCobranca: assinaturaViva.proximaCobranca,
      ultimaCobranca: ultima
        ? {
            chargeId: ultima.charge_id,
            status: statusUltima,
            metodoPagamento: ultima.metodo_pagamento,
            valorCobrado: ultima.valor_cobrado,
            criadoEm: ultima.criado_em
          }
        : null
    });
  } catch (erro) {
    responderErro(resposta, erro, 'consulta.consultarAssinatura');
  }
}
