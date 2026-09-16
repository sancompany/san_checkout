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
import {
  buscarAssinaturaAtiva,
  atualizarStatusAssinatura,
  atualizarCicloAssinatura
} from '../services/assinaturaService.js';
import {
  recuperarCobrancaPix,
  recuperarCobrancaBoleto,
  consultarStatus,
  consultarAssinaturaNaAsaas
} from '../services/asaasService.js';
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

function comoEstaNoBanco(assinatura) {
  return {
    status: assinatura?.status ?? null,
    ciclo: assinatura?.ciclo ?? null,
    proximaCobranca: assinatura?.proxima_cobranca ?? null
  };
}

/** Injetável só pro autoteste: a reconciliação decide status e ciclo, e
 *  não dá pra afirmar nada sobre ela sem falsear a resposta da Asaas. */
const dependenciasDaConciliacao = {
  consultarAssinaturaNaAsaas,
  atualizarStatusAssinatura,
  atualizarCicloAssinatura
};

export async function assinaturaAtualizada(assinatura, deps = dependenciasDaConciliacao) {
  if (!assinatura?.id) return comoEstaNoBanco(assinatura);

  try {
    const viva = await deps.consultarAssinaturaNaAsaas(assinatura.id);

    // `null` = 404 na Asaas. NÃO vira "cancelada" automaticamente: 404
    // também é o que responde um id de outra conta ou digitado errado, e
    // marcar cancelada por engano é pior que ficar com o dado velho.
    // (Medido em 16/09: assinatura DELETADA não devolve 404 — devolve
    // 200 com `deleted: true`. Então este ramo é id inválido mesmo.)
    if (!viva) {
      console.error(`[consulta] assinatura ${assinatura.id} não existe na Asaas (404) — mantendo o status local "${assinatura.status}".`);
      return comoEstaNoBanco(assinatura);
    }

    /* `deleted` ANTES do status, e a ordem é a correção inteira: uma
       assinatura cancelada responde `status: "INACTIVE"` — o MESMO de
       uma pausada (medido em 16/09). Olhar só o status marcaria toda
       cancelada como `pausada`. */
    const statusReal = viva.encerrada ? 'cancelada' : (STATUS_ASAAS_PARA_LOCAL[viva.status] ?? assinatura.status);

    if (statusReal !== assinatura.status) {
      console.error(`[consulta] divergência corrigida: assinatura ${assinatura.id} estava "${assinatura.status}" aqui e "${viva.status}${viva.deleted ? '/deleted' : ''}" na Asaas.`);
      await deps.atualizarStatusAssinatura(assinatura.id, statusReal);
    }

    // Ciclo: quem cobra é a Asaas, então divergência aqui é erro NOSSO —
    // e é o rastro que as assinaturas criadas antes de 15/09 deixaram no
    // banco (gravadas `MONTHLY` por ler um campo de webhook inexistente).
    // A correção na origem só valeu pras novas; esta alcança as velhas.
    const cicloReal = viva.ciclo ?? assinatura.ciclo ?? null;
    if (viva.ciclo && viva.ciclo !== assinatura.ciclo) {
      console.error(`[consulta] ciclo corrigido: assinatura ${assinatura.id} estava "${assinatura.ciclo}" aqui e "${viva.ciclo}" na Asaas.`);
      await deps.atualizarCicloAssinatura(assinatura.id, viva.ciclo);
    }

    /* `proximaCobranca` sai do `null` eterno: `nextDueDate` existe nesta
       resposta (o que nenhum payload de webhook trazia, que é por que o
       campo nasceu nulo — ver docs/pendencias.md).

       Mas ela é `null` para assinatura encerrada, e não é detalhe: a
       Asaas CONTINUA devolvendo `nextDueDate` de uma assinatura
       deletada (medido em 16/09: `sub_qut6521d50496vkn`, cancelada,
       responde `nextDueDate: "2027-09-16"`). Repassar isso diria ao
       contratante que existe uma cobrança marcada para uma assinatura
       que nunca mais vai cobrar. */
    return {
      status: statusReal,
      ciclo: cicloReal,
      proximaCobranca: statusReal === 'cancelada'
        ? null
        : (viva.proximaCobranca ?? assinatura.proxima_cobranca ?? null)
    };
  } catch (erro) {
    console.error(`[consulta] falha ao reconsultar a assinatura ${assinatura.id} na Asaas:`, erro.message);
    return comoEstaNoBanco(assinatura);
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
      ciclo: assinaturaViva.ciclo,
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

/* ------------------------------------------------------------------
   Autoteste — `node src/controllers/cobrancaConsultaController.js`

   Cobre a reconciliação da assinatura (`assinaturaAtualizada`), que é o
   único lugar onde a conciliação decide status e ciclo contra a Asaas.

   As duas regras que ele trava vieram de MEDIÇÃO, não de leitura de
   documentação (16/09/2026, `GET /v3/subscriptions/{id}` rodado dentro
   do container de produção contra o sandbox):

     1. Assinatura CANCELADA responde HTTP 200 com `deleted: true` e
        `status: "INACTIVE"` — o MESMO status de uma pausada. Quem olhar
        o status antes do `deleted` marca toda cancelada como `pausada`.
     2. A resposta traz `cycle`, e ela é a fonte da verdade: quem cobra é
        a Asaas. `sub_qut6521d50496vkn` estava `YEARLY` lá e `MONTHLY`
        aqui — rastro das assinaturas nascidas antes da correção de
        15/09. Sem esta correção, essas linhas ficam erradas para sempre.

   404 continua NÃO virando cancelada: medido que a deletada não dá 404,
   então 404 sobrou para id de outra conta ou digitado errado.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('cobrancaConsultaController.js')) {
  const { strict: assert } = await import('node:assert');

  let checagens = 0;
  const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

  /** Falseia a Asaas e anota tudo que a reconciliação tentou gravar. */
  function costura(respostaDaAsaas) {
    const gravado = { status: [], ciclo: [] };
    return {
      gravado,
      deps: {
        consultarAssinaturaNaAsaas: async () => respostaDaAsaas,
        atualizarStatusAssinatura: async (id, status) => { gravado.status.push([id, status]); },
        atualizarCicloAssinatura: async (id, ciclo) => { gravado.ciclo.push([id, ciclo]); }
      }
    };
  }

  const noBanco = {
    id: 'sub_qut6521d50496vkn', status: 'ativa', ciclo: 'MONTHLY', proxima_cobranca: null
  };

  /* --- 1. cancelada: `deleted` manda, apesar do INACTIVE --- */
  let c = costura({
    status: 'INACTIVE', deleted: true, encerrada: true,
    proximaCobranca: null, ciclo: 'YEARLY'
  });
  let r = await assinaturaAtualizada(noBanco, c.deps);
  conferir(r.status === 'cancelada', `cancelada na Asaas tem que virar "cancelada" aqui, veio "${r.status}"`);
  conferir(r.status !== 'pausada', 'cancelada NÃO pode ser confundida com pausada (as duas são INACTIVE)');
  conferir(
    c.gravado.status.some(([, s]) => s === 'cancelada'),
    'a divergência tem que ser GRAVADA, não só devolvida — senão volta na consulta seguinte'
  );

  /* --- 1b. cancelada NÃO promete próxima cobrança --- */
  c = costura({
    status: 'INACTIVE', deleted: true, encerrada: true,
    proximaCobranca: '2027-09-16', ciclo: 'YEARLY'
  });
  r = await assinaturaAtualizada(noBanco, c.deps);
  conferir(
    r.proximaCobranca === null,
    `cancelada não pode prometer cobrança futura, veio "${r.proximaCobranca}" (a Asaas devolve nextDueDate mesmo para deletada)`
  );

  /* --- 2. pausada de verdade: mesmo status, sem `deleted` --- */
  c = costura({
    status: 'INACTIVE', deleted: false, encerrada: false,
    proximaCobranca: '2026-10-16', ciclo: 'MONTHLY'
  });
  r = await assinaturaAtualizada(noBanco, c.deps);
  conferir(r.status === 'pausada', `INACTIVE sem deleted é pausada, veio "${r.status}"`);

  /* --- 3. o ciclo errado no banco é corrigido pelo da Asaas --- */
  c = costura({
    status: 'ACTIVE', deleted: false, encerrada: false,
    proximaCobranca: '2027-09-16', ciclo: 'YEARLY'
  });
  r = await assinaturaAtualizada(noBanco, c.deps);
  conferir(r.ciclo === 'YEARLY', `o ciclo devolvido tem que ser o da Asaas, veio "${r.ciclo}"`);
  conferir(
    c.gravado.ciclo.some(([, ciclo]) => ciclo === 'YEARLY'),
    'o ciclo divergente tem que ser gravado — a correção de origem só valeu pras assinaturas novas'
  );
  conferir(r.proximaCobranca === '2027-09-16', 'proximaCobranca sai do null eterno: vem do nextDueDate');

  /* --- 4. ciclo igual não escreve à toa --- */
  c = costura({
    status: 'ACTIVE', deleted: false, encerrada: false,
    proximaCobranca: null, ciclo: 'MONTHLY'
  });
  await assinaturaAtualizada(noBanco, c.deps);
  conferir(c.gravado.ciclo.length === 0, 'ciclo igual ao do banco não pode virar escrita');
  conferir(c.gravado.status.length === 0, 'status igual ao do banco não pode virar escrita');

  /* --- 5. 404 NÃO vira cancelada, e não apaga o que o banco sabe --- */
  c = costura(null);
  r = await assinaturaAtualizada(noBanco, c.deps);
  conferir(r.status === 'ativa', `404 tem que manter o status local, veio "${r.status}"`);
  conferir(r.ciclo === 'MONTHLY', '404 não pode zerar o ciclo local');
  conferir(c.gravado.status.length === 0, '404 não pode gravar nada');

  /* --- 6. Asaas fora do ar cai pro banco, sem derrubar a conciliação --- */
  r = await assinaturaAtualizada(noBanco, {
    consultarAssinaturaNaAsaas: async () => { throw new Error('asaas fora do ar'); },
    atualizarStatusAssinatura: async () => {},
    atualizarCicloAssinatura: async () => {}
  });
  conferir(r.status === 'ativa' && r.ciclo === 'MONTHLY', 'Asaas fora do ar cai pro que o banco sabe');

  /* --- 7. sem assinatura local não explode --- */
  r = await assinaturaAtualizada(null, costura(null).deps);
  conferir(r.status === null && r.ciclo === null, 'sem linha local devolve nulos, não estoura');

  console.log(`cobrancaConsultaController: ${checagens} checagens OK`);
}
