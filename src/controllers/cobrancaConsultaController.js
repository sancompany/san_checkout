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
  buscarCobrancaPorSubscriptionId,
  aplicarTransicao
} from '../services/cobrancaService.js';
import {
  buscarAssinaturaAtiva,
  atualizarStatusAssinatura,
  atualizarCicloAssinatura,
  atualizarValorAssinatura
} from '../services/assinaturaService.js';
import {
  recuperarCobrancaPix,
  recuperarCobrancaBoleto,
  consultarStatus,
  consultarAssinaturaNaAsaas
} from '../services/asaasService.js';
import { documentoValido, normalizarDocumento } from '../utils/validadores.js';
import { responderErro } from '../utils/erros.js';
import { VERSAO_WEBHOOK, valorDivergenteDaCobranca } from './webhookController.js';

/** Status locais em que ainda faz sentido mostrar como pagar. */
/* ⚠️ A MESMA lista existe em `services/metricaService.js`, com o nome
   `EM_ABERTO`. As duas ficam separadas de propósito: aqui a pergunta é
   "vale reconsultar a Asaas?", lá é "conta como aberta na métrica?" —
   são decisões que podem divergir (um status novo pode contar como
   aberto sem valer uma ida à Asaas). O ponteiro existe para quem mexer
   numa OLHAR a outra, que é o que faltava: valores iguais sem nada
   ligando os dois lugares dessincronizam calados. */
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
    const { status: statusAsaas, valor, installment } = await consultarStatus(cobranca.charge_id);
    const confirmado = statusAsaas === 'RECEIVED' || statusAsaas === 'CONFIRMED';
    if (!confirmado) return cobranca.status;
    /* O mesmo binding de valor do webhook (C1-10): o pago com valor
       diferente do que cobramos não confirma sozinho — lá ele vira
       divergência com dono; aqui, a tela do comprador não pode passar
       por cima disso. */
    if (valorDivergenteDaCobranca(cobranca, { value: valor, installment })) return cobranca.status;

    /* Por CAS sobre o status que se LEU (SEC-022, 25/09/2026): um
       estorno ou chargeback que o webhook gravou entre a leitura e esta
       escrita não é apagado por um `confirmado` atrasado. Perdeu a
       corrida, vale o que está no banco. */
    const gravou = await aplicarTransicao(cobranca.charge_id, { de: cobranca.status, para: 'confirmado' });
    return gravou ? 'confirmado' : cobranca.status;
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
    valor: assinatura?.valor ?? null,
    // Sem ida à Asaas não há divergência a denunciar: `null` aqui
    // significa "não comparei", e não "estava igual".
    divergenciaDeValor: null,
    proximaCobranca: assinatura?.proxima_cobranca ?? null
  };
}

/** Centavos, que é como a Asaas guarda. Comparar preço em reais com
 *  ponto flutuante inventa divergência onde não há (e uma divergência
 *  falsa reescreveria o nosso registro a cada conciliação). */
const emCentavos = (n) => Math.round(Number(n) * 100);

/**
 * Número de dinheiro, ou `null` — e o `null` tem de ser `null` mesmo.
 *
 * ⚠️ Esta função existe por causa de um furo que a revisão pegou no
 * mesmo dia em que a reconciliação de `valor` foi escrita:
 * `Number.isFinite(Number(null))` é **`true`**, porque `Number(null)` é
 * `0`. E `consultarAssinaturaNaAsaas` devolve `valor: corpo?.value ??
 * null` — ou seja, `null` explícito quando a Asaas não manda o campo.
 *
 * Com o teste `Number.isFinite(Number(...))`, uma assinatura cuja
 * resposta viesse sem `value` seria lida como **R$ 0,00 na Asaas**,
 * divergente do nosso registro: gravaria zero no banco e devolveria
 * `valor: 0` ao contratante — no campo que ele acabou de ganhar
 * permissão para confiar.
 *
 * O autoteste não pegou porque o dublê OMITIA a chave (`undefined`, que
 * dá `NaN` e é recusado) em vez de mandar `null`, que é a forma real.
 * É a mesma lição do dublê de pedido com o formato de item errado.
 */
function dinheiroOuNulo(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  // String numérica é aceita porque driver de banco pode devolver
  // `numeric` como texto; string vazia e qualquer outra coisa, não.
  if (typeof valor === 'string' && valor.trim() !== '' && Number.isFinite(Number(valor))) {
    return Number(valor);
  }
  return null;
}

/** Injetável só pro autoteste: a reconciliação decide status e ciclo, e
 *  não dá pra afirmar nada sobre ela sem falsear a resposta da Asaas. */
const dependenciasDaConciliacao = {
  consultarAssinaturaNaAsaas,
  atualizarStatusAssinatura,
  atualizarCicloAssinatura,
  atualizarValorAssinatura
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

    /* VALOR — decisão do dono em 18/09/2026: reconciliar (RN-34).
       O porquê inteiro está em `assinaturaService.atualizarValorAssinatura`;
       em uma linha: quem debita o cartão é a Asaas, então o nosso número
       divergente não é uma opinião, é informação falsa.

       Reconciliar E DENUNCIAR: o valor corrigido volta em `valor`, e a
       divergência volta em `divergenciaDeValor` — o contratante precisa
       saber que o preço do assinante dele mudou fora do nosso fluxo,
       porque é ele que fala com o assinante (RN-35). Corrigir calado
       trocaria um número errado por uma mudança invisível.

       Comparação em CENTAVOS: em reais, `30` e `30.000000000000004`
       seriam divergência, e a "correção" reescreveria a linha a cada
       conciliação. */
    const valorLocal = dinheiroOuNulo(assinatura.valor);
    const valorNaAsaas = dinheiroOuNulo(viva.valor);
    const temValorDaAsaas = valorNaAsaas !== null;
    const valorDivergiu = temValorDaAsaas
      && valorLocal !== null
      && emCentavos(valorNaAsaas) !== emCentavos(valorLocal);

    if (valorDivergiu) {
      console.error(`[consulta] valor corrigido: assinatura ${assinatura.id} estava ${valorLocal} aqui e ${valorNaAsaas} na Asaas — quem cobra é ela.`);
      await deps.atualizarValorAssinatura(assinatura.id, valorNaAsaas);
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
      valor: temValorDaAsaas ? valorNaAsaas : valorLocal,
      divergenciaDeValor: valorDivergiu ? { nosso: valorLocal, asaas: valorNaAsaas } : null,
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
      // O pagador CONCLUIU a pop-up e o dinheiro ainda não foi confirmado
      // (RN-47): a tela não pode dizer "aguardando pagamento" — isso
      // convida a pagar de novo (25/09/2026).
      emProcessamento: status === 'pendente' && Boolean(cobranca.sessao_concluida_em),
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
      versao: VERSAO_WEBHOOK,
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
  let { planoId, documento } = requisicao.body ?? {};

  if (!chave) return resposta.status(401).json({ erro: 'X-Checkout-Key ausente.' });
  if (!planoId || !documento) return resposta.status(400).json({ erro: 'planoId e documento são obrigatórios.' });
  if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });

  // Dígitos, e daqui para baixo é só esta forma (RN-32) — a explicação
  // inteira está em `normalizarDocumento`, em `utils/validadores.js`.
  documento = normalizarDocumento(documento);

  try {
    const contratante = await buscarContratantePorChave(chave);
    if (!contratante) return resposta.status(401).json({ erro: 'Chave inválida.' });

    const assinatura = await buscarAssinaturaAtiva(
      contratante.id, planoId, documento, STATUS_ASSINATURA_TODOS
    );
    /* A última cobrança sai pela ASSINATURA quando ela existe, e só cai
       na busca por plano+documento quando não existe.

       O motivo é a troca de plano (17/09/2026): as cobranças ficam
       gravadas sob o plano que valia na época, então logo depois de uma
       troca a busca por `planoId` não acha nada e esta rota responderia
       `ultimaCobranca: null` para uma assinatura que já cobrou — e é
       justamente `ultimaCobranca.valorCobrado` que o `API.md` §5.3 manda
       o contratante usar como valor de verdade (RN-34).

       A busca por plano+documento continua atrás, e não só quando falta
       a linha em `assinaturas`: ela é a rede para o caso em que o
       vínculo ficou pela metade — `atualizarSubscriptionIdDaCobranca`
       apenas registra o erro e segue, então uma falha passageira do
       banco pode deixar a assinatura criada e a cobrança sem o id dela,
       para sempre. É também o caso para que essa busca nasceu: um
       pagamento cujo webhook se perdeu, visível só em `cobrancas`. */
    const ultima = (assinatura ? await buscarCobrancaPorSubscriptionId(assinatura.id) : null)
      ?? await buscarUltimaCobrancaDaAssinatura(contratante.id, planoId, documento);

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
      versao: VERSAO_WEBHOOK,
      tipo: 'assinatura',
      planoId,
      documento,
      assinaturaId: assinatura?.id ?? null,
      status: assinaturaViva.status,
      /* Reconciliado contra a Asaas desde 18/09/2026 (RN-34). Este
         campo era o único que saía do nosso banco sem reconferência, e
         o `API.md` §5.3 avisava o integrador para não confiar nele —
         o aviso saiu junto com a causa. */
      valor: assinaturaViva.valor,
      divergenciaDeValor: assinaturaViva.divergenciaDeValor,
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
    const gravado = { status: [], ciclo: [], valor: [] };
    return {
      gravado,
      deps: {
        consultarAssinaturaNaAsaas: async () => respostaDaAsaas,
        atualizarStatusAssinatura: async (id, status) => { gravado.status.push([id, status]); },
        atualizarCicloAssinatura: async (id, ciclo) => { gravado.ciclo.push([id, ciclo]); },
        atualizarValorAssinatura: async (id, valor) => { gravado.valor.push([id, valor]); }
      }
    };
  }

  const noBanco = {
    id: 'sub_qut6521d50496vkn', status: 'ativa', ciclo: 'MONTHLY', valor: 30, proxima_cobranca: null
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

  /* --- 7b. VALOR: reconcilia E denuncia (RN-34, decisão de 18/09) ---
     Era o único campo que a conciliação devolvia sem reconferir, e o
     `API.md` §5.3 chegava a avisar o integrador para não confiar nele.
     Decisão do dono: reconciliar. Quem debita o cartão é a Asaas — o
     nosso número divergente não é opinião, é informação falsa. */
  c = costura({
    status: 'ACTIVE', deleted: false, encerrada: false,
    proximaCobranca: '2026-10-18', ciclo: 'MONTHLY', valor: 45
  });
  r = await assinaturaAtualizada(noBanco, c.deps);
  conferir(r.valor === 45, `o valor devolvido é o da Asaas, veio ${r.valor}`);
  conferir(
    c.gravado.valor.some(([, v]) => v === 45),
    'e a divergência é GRAVADA — senão a correção vale só para esta resposta e volta na próxima'
  );
  conferir(
    r.divergenciaDeValor?.nosso === 30 && r.divergenciaDeValor?.asaas === 45,
    `a divergência é DENUNCIADA na resposta, veio ${JSON.stringify(r.divergenciaDeValor)}`
  );

  /* Controle positivo: valor igual não escreve nem denuncia. Sem este
     par, um "reconcilia sempre" reescreveria a linha a cada conciliação
     e inventaria divergência em toda chamada. */
  c = costura({
    status: 'ACTIVE', deleted: false, encerrada: false,
    proximaCobranca: '2026-10-18', ciclo: 'MONTHLY', valor: 30
  });
  r = await assinaturaAtualizada(noBanco, c.deps);
  conferir(c.gravado.valor.length === 0, 'valor igual não vira escrita');
  conferir(r.divergenciaDeValor === null, 'nem denúncia');
  conferir(r.valor === 30, 'e o valor devolvido continua sendo o certo');

  /* Ponto flutuante não pode inventar divergência: em reais,
     `30.000000000000004 !== 30`. A comparação é em centavos. */
  c = costura({
    status: 'ACTIVE', deleted: false, encerrada: false,
    proximaCobranca: '2026-10-18', ciclo: 'MONTHLY', valor: 30.000000000000004
  });
  r = await assinaturaAtualizada(noBanco, c.deps);
  conferir(c.gravado.valor.length === 0, 'diferença de ponto flutuante não é divergência');
  conferir(r.divergenciaDeValor === null, 'e não é denunciada');

  /* Asaas sem `value` na resposta: mantém o nosso, não anula. Anular
     seria a mesma classe do "ausência virou zero" que este projeto já
     pagou duas vezes na tela.

     ⚠️ Os DOIS casos abaixo, e a diferença entre eles é o furo que a
     revisão pegou: `consultarAssinaturaNaAsaas` devolve `valor: null`
     EXPLÍCITO quando a Asaas não manda `value`, e `Number(null)` é `0`.
     A primeira versão deste teste só omitia a chave (`undefined`, que dá
     `NaN`) e por isso passava sobre um código que, com `null`, gravaria
     **zero** no banco e devolveria R$ 0,00 ao contratante. Dublê que não
     tem a forma real não prova nada. */
  for (const [rotulo, respostaDaAsaas] of [
    ['chave omitida', { status: 'ACTIVE', deleted: false, encerrada: false, proximaCobranca: '2026-10-18', ciclo: 'MONTHLY' }],
    ['valor null explícito (a forma REAL)', { status: 'ACTIVE', deleted: false, encerrada: false, proximaCobranca: '2026-10-18', ciclo: 'MONTHLY', valor: null }]
  ]) {
    c = costura(respostaDaAsaas);
    r = await assinaturaAtualizada(noBanco, c.deps);
    conferir(r.valor === 30, `${rotulo}: mantém o nosso valor — veio ${r.valor}`);
    conferir(r.valor !== 0, `${rotulo}: e NUNCA vira zero`);
    conferir(c.gravado.valor.length === 0, `${rotulo}: e não grava nada`);
    conferir(r.divergenciaDeValor === null, `${rotulo}: e não denuncia divergência`);
  }

  /* `numeric` do banco pode chegar como STRING dependendo do driver.
     String numérica é dinheiro; string vazia não é. */
  c = costura({ status: 'ACTIVE', deleted: false, encerrada: false, proximaCobranca: '2026-10-18', ciclo: 'MONTHLY', valor: 45 });
  r = await assinaturaAtualizada({ ...noBanco, valor: '30.00' }, c.deps);
  conferir(r.valor === 45 && r.divergenciaDeValor?.nosso === 30, `valor local em string é comparado como número, veio ${JSON.stringify(r.divergenciaDeValor)}`);

  c = costura({ status: 'ACTIVE', deleted: false, encerrada: false, proximaCobranca: '2026-10-18', ciclo: 'MONTHLY', valor: 45 });
  r = await assinaturaAtualizada({ ...noBanco, valor: '' }, c.deps);
  conferir(c.gravado.valor.length === 0, 'valor local vazio não é comparado — sem base, não há divergência a afirmar');

  /* Asaas fora do ar e 404: o valor vem do banco, sem denúncia. */
  r = await assinaturaAtualizada(noBanco, costura(null).deps);
  conferir(r.valor === 30 && r.divergenciaDeValor === null, '404 devolve o valor do banco, sem denunciar divergência');
  r = await assinaturaAtualizada(noBanco, {
    consultarAssinaturaNaAsaas: async () => { throw new Error('asaas fora do ar'); },
    atualizarStatusAssinatura: async () => {},
    atualizarCicloAssinatura: async () => {},
    atualizarValorAssinatura: async () => {}
  });
  conferir(r.valor === 30 && r.divergenciaDeValor === null, 'Asaas fora do ar idem');

  /* --- 8. a última cobrança segue a ASSINATURA, não o plano ------
     Achado no ciclo 4 da revisão da troca de plano: as cobranças ficam
     gravadas sob o plano que valia na época, então logo depois de uma
     troca a busca por `planoId` não acha nada — e esta rota responderia
     `ultimaCobranca: null` para uma assinatura que já cobrou, bem no
     campo que o `API.md` §5.3 manda o contratante usar como valor de
     verdade (RN-34).

     A checagem é no texto-fonte, como a de `sem-consulta-repetida.js` e
     pelo mesmo motivo: exercitar o handler inteiro exigiria banco;
     provar que a âncora não voltou a ser o plano não exige nada. */
  {
    const { readFileSync } = await import('node:fs');
    const fonte = readFileSync(new URL('./cobrancaConsultaController.js', import.meta.url), 'utf8');
    const trecho = fonte.slice(fonte.indexOf('export async function consultarAssinatura'));

    conferir(
      /assinatura \? await buscarCobrancaPorSubscriptionId\(assinatura\.id\) : null/.test(trecho),
      'havendo assinatura, a última cobrança tem que ser procurada pelo id dela — o plano muda, a assinatura não'
    );
    conferir(
      /\?\?\s*await buscarUltimaCobrancaDaAssinatura\(/.test(trecho),
      'e a busca por plano+documento fica ATRÁS, como rede: sem ela, um vínculo pela metade viraria "nenhuma cobrança"'
    );
  }

  console.log(`cobrancaConsultaController: ${checagens} checagens OK`);
}
