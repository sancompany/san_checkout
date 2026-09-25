/**
 * SAN CHECKOUT v2 — src/controllers/trocaAprovacaoController.js
 * As DUAS rotas do PAGADOR na tela `/troca` — nenhuma das duas usa
 * `X-Checkout-Key` (o pagador não tem uma): a credencial é o token
 * opaco que veio no fragmento da URL, enviado no CORPO do POST (nunca
 * query string — o mesmo motivo do fragmento: não vazar em log de
 * acesso, proxy ou `Referer`).
 *
 *   `POST /troca/contexto` — o que a tela mostra ANTES de aprovar.
 *     Nunca devolve cartão, documento nem chave de ninguém.
 *   `POST /troca/aprovar` — idempotente e CAS-driven
 *     (`trocaExecucaoService.js`): a primeira chamada sobre um token
 *     `PENDING_APPROVAL` dispara a cobrança; qualquer chamada seguinte
 *     (duplo clique, poll de `PAYMENT_UNKNOWN`) só reconsulta e nunca
 *     cobra de novo.
 *
 * Desenho completo:
 * `docs/specs/2026-09-20-troca-de-plano-redireciona-pagador.md`.
 */

import { buscarIntencao, expirarSePassouDoPrazo } from '../services/trocaIntencaoService.js';
import { criarExecutorDeTroca } from '../services/trocaExecucaoService.js';
import { responderErro } from '../utils/erros.js';

const EM_PROCESSAMENTO = ['PENDING_APPROVAL', 'PROCESSING_PAYMENT', 'PAYMENT_UNKNOWN', 'PAYMENT_CONFIRMED', 'APPLYING_PLAN', 'RECONCILIATION_REQUIRED'];

/** O `id` da intenção (a migration 0011 é `uuid primary key`) é o
 *  token inteiro — recusar cedo o que não tem essa forma evita uma ida
 *  ao banco que o Postgres recusaria de qualquer jeito (`invalid input
 *  syntax for type uuid`), e faz o 404 de "token errado" e o de "token
 *  bem formado mas inexistente" se parecerem, sem vazar qual dos dois
 *  é o caso. */
const FORMATO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Estado → código HTTP. Fonte única: as duas rotas usam a MESMA
 *  função, para nunca responderem coisas diferentes sobre o mesmo
 *  estado. */
function codigoDoEstado(status) {
  if (status === 'COMPLETED') return 200;
  if (status === 'PAYMENT_DECLINED') return 402;
  if (status === 'STALE') return 409;
  if (status === 'EXPIRED') return 410;
  if (EM_PROCESSAMENTO.includes(status)) return 202;
  return 202; // estado desconhecido: nunca inventa sucesso nem falha
}

function corpoDoEstado(intencao) {
  const base = { status: intencao.status };
  if (intencao.status === 'COMPLETED') {
    return {
      ...base,
      planoNovoNome: intencao.plano_novo_nome,
      valor: Number(intencao.valor_novo),
      ciclo: intencao.ciclo_novo,
      acerto: { cobrado: true, valor: Number(intencao.valor_acerto) }
    };
  }
  if (intencao.status === 'PAYMENT_DECLINED') {
    return { ...base, code: 'PLAN_CHANGE_DECLINED', erro: 'O acerto não foi aprovado no cartão salvo. O plano não foi alterado.' };
  }
  if (intencao.status === 'STALE') {
    return { ...base, code: 'PLAN_CHANGE_STALE', erro: 'Este link não reflete mais o estado atual da assinatura. Peça um novo link ao contratante.' };
  }
  if (intencao.status === 'EXPIRED') {
    return { ...base, code: 'PLAN_CHANGE_EXPIRED', erro: 'Este link expirou. Peça um novo link ao contratante.' };
  }
  return { ...base, mensagem: 'Ainda processando — tente novamente em instantes.' };
}

const dependenciasPadrao = {
  buscarIntencao,
  expirarSePassouDoPrazo,
  executor: criarExecutorDeTroca()
};

export function criarTrocaContexto(deps = dependenciasPadrao) {
  return async function trocaContexto(requisicao, resposta) {
    try {
      const { token } = requisicao.body ?? {};
      if (!token) return resposta.status(400).json({ erro: 'token é obrigatório.' });
      if (typeof token !== 'string' || !FORMATO_UUID.test(token)) return resposta.status(404).json({ erro: 'Link inválido ou já usado.' }); // só texto: um objeto com toString forjado lançava (CP2-11)

      let intencao = await deps.buscarIntencao(token);
      if (!intencao) return resposta.status(404).json({ erro: 'Link inválido ou já usado.' });

      if (intencao.status === 'PENDING_APPROVAL') {
        const expirada = await deps.expirarSePassouDoPrazo(token);
        if (expirada) intencao = expirada;
      }

      if (intencao.status !== 'PENDING_APPROVAL') {
        return resposta.status(codigoDoEstado(intencao.status)).json(corpoDoEstado(intencao));
      }

      /* Só o que a tela precisa para mostrar o acerto ANTES de aprovar —
         nunca cartão, nunca documento, nunca a chave de ninguém. */
      resposta.status(200).json({
        status: intencao.status,
        planoNome: intencao.plano_nome,
        planoNovoNome: intencao.plano_novo_nome,
        cicloAtual: intencao.ciclo_atual,
        cicloNovo: intencao.ciclo_novo,
        valorAtual: Number(intencao.valor_atual),
        valorNovo: Number(intencao.valor_novo),
        credito: Number(intencao.credito),
        debito: Number(intencao.debito),
        valorAcerto: Number(intencao.valor_acerto),
        diasRestantes: intencao.dias_restantes,
        expiresAt: intencao.expira_em
      });
    } catch (erro) {
      responderErro(resposta, erro, 'trocaAprovacao.contexto');
    }
  };
}

export function criarTrocaAprovar(deps = dependenciasPadrao) {
  return async function trocaAprovar(requisicao, resposta) {
    try {
      const { token } = requisicao.body ?? {};
      if (!token) return resposta.status(400).json({ erro: 'token é obrigatório.' });
      if (typeof token !== 'string' || !FORMATO_UUID.test(token)) return resposta.status(404).json({ erro: 'Link inválido ou já usado.' }); // só texto: um objeto com toString forjado lançava (CP2-11)

      const existente = await deps.buscarIntencao(token);
      if (!existente) return resposta.status(404).json({ erro: 'Link inválido ou já usado.' });

      if (existente.status === 'PENDING_APPROVAL') {
        await deps.executor.iniciarCobranca(token);
      } else if (['PROCESSING_PAYMENT', 'PAYMENT_UNKNOWN'].includes(existente.status)) {
        /* Idempotente: uma segunda chamada (duplo clique, ou o front
           fazendo poll enquanto o veredito ainda não fechou) NUNCA cobra
           de novo — só reconsulta o que já foi cobrado. */
        await deps.executor.reclassificarPendente(existente);
      }
      // Qualquer outro estado (COMPLETED, PAYMENT_DECLINED, STALE,
      // EXPIRED, RECONCILIATION_REQUIRED) é terminal ou fora do que esta
      // chamada resolve — nada a fazer, só responder o que já é verdade.

      /* A fonte da resposta é sempre uma releitura, nunca o retorno da
         função acima: as três origens (aqui, o sweeper, o webhook) podem
         ter avançado o estado entre o início desta chamada e agora. */
      const atual = await deps.buscarIntencao(token);
      resposta.status(codigoDoEstado(atual.status)).json(corpoDoEstado(atual));
    } catch (erro) {
      responderErro(resposta, erro, 'trocaAprovacao.aprovar');
    }
  };
}

export const trocaContexto = criarTrocaContexto();
export const trocaAprovar = criarTrocaAprovar();

/* ------------------------------------------------------------------
   Autoteste — `node src/controllers/trocaAprovacaoController.js`
   A coreografia de cobrar já tem o autoteste dela
   (`trocaExecucaoService.js`); aqui o que se trava é o MAPEAMENTO
   estado → HTTP, e que as duas rotas nunca vazam dado sensível.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('trocaAprovacaoController.js')) {
  const { strict: assert } = await import('node:assert');
  let checagens = 0;
  const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

  const INTENCAO_BASE = {
    id: '11111111-1111-4111-8111-111111111111', status: 'PENDING_APPROVAL',
    plano_nome: 'Mensal', plano_novo_nome: 'Anual',
    ciclo_atual: 'MONTHLY', ciclo_novo: 'YEARLY',
    valor_atual: 100, valor_novo: 900,
    credito: 20, debito: 0, valor_acerto: 80,
    dias_restantes: 12, expira_em: '2026-09-25T15:15:00.000Z',
    charge_id: null, mutation_version_snapshot: 1, assinatura_id: 'sub_1'
  };

  function costura({ intencaoInicial, avancarPara } = {}) {
    const chamadas = [];
    const banco = new Map([['11111111-1111-4111-8111-111111111111', { ...INTENCAO_BASE, ...intencaoInicial }]]);

    const deps = {
      buscarIntencao: async (id) => { chamadas.push(['buscarIntencao', id]); return banco.get(id) ? { ...banco.get(id) } : null; },
      expirarSePassouDoPrazo: async (id) => {
        chamadas.push(['expirarSePassouDoPrazo', id]);
        const i = banco.get(id);
        if (!i || i.status !== 'PENDING_APPROVAL' || !avancarPara?.viaExpiracao) return null;
        i.status = 'EXPIRED';
        return { ...i };
      },
      executor: {
        iniciarCobranca: async (id) => {
          chamadas.push(['iniciarCobranca', id]);
          if (avancarPara) banco.get(id).status = avancarPara;
        },
        reclassificarPendente: async (intencao) => {
          chamadas.push(['reclassificarPendente', intencao.id]);
          if (avancarPara) banco.get(intencao.id).status = avancarPara;
        }
      }
    };

    return {
      chamadas,
      chamou: (nome) => chamadas.some((c) => c[0] === nome),
      contexto: criarTrocaContexto(deps),
      aprovar: criarTrocaAprovar(deps)
    };
  }

  const pedido = (body) => ({ body });
  function respostaFalsa() {
    const r = { codigo: 200, corpo: null };
    r.status = (c) => { r.codigo = c; return r; };
    r.json = (c) => { r.corpo = c; return r; };
    return r;
  }

  /* --- /troca/contexto ------------------------------------------- */
  let t = costura();
  let r = respostaFalsa();
  await t.contexto(pedido({}), r);
  conferir(r.codigo === 400, `sem token é 400, veio ${r.codigo}`);

  t = costura();
  r = respostaFalsa();
  await t.contexto(pedido({ token: 'nao-existe' }), r);
  conferir(r.codigo === 404, `token inexistente é 404, veio ${r.codigo}`);
  conferir(!t.chamou('buscarIntencao'), 'token mal formado nem chega a ir ao banco — recusa cedo o que o Postgres recusaria (uuid inválido)');

  t = costura();
  r = respostaFalsa();
  await t.contexto(pedido({ token: '11111111-1111-4111-8111-111111111111' }), r);
  conferir(r.codigo === 200, `token pendente válido é 200, veio ${r.codigo}`);
  conferir(r.corpo.valorAcerto === 80, 'traz o valor do acerto');
  conferir(r.corpo.planoNovoNome === 'Anual', 'e o nome do plano novo');
  for (const chaveProibida of ['cartaoToken', 'documento', 'clienteId', 'apiKey', 'api_key', 'chargeId', 'charge_id']) {
    conferir(!(chaveProibida in r.corpo), `/troca/contexto NUNCA devolve "${chaveProibida}"`);
  }

  t = costura({ intencaoInicial: { status: 'COMPLETED' } });
  r = respostaFalsa();
  await t.contexto(pedido({ token: '11111111-1111-4111-8111-111111111111' }), r);
  conferir(r.codigo === 200, `contexto de uma intenção já concluída é 200, veio ${r.codigo}`);
  conferir(r.corpo.status === 'COMPLETED', 'e diz que já concluiu');

  /* Token vencido: `/troca/contexto` expira SOB DEMANDA (não depende do
     sweeper já ter rodado) e responde 410, não 200 com dado velho. */
  const contextoComTokenVencido = criarTrocaContexto({
    buscarIntencao: async () => ({ ...INTENCAO_BASE }), // ainda PENDING_APPROVAL na leitura
    expirarSePassouDoPrazo: async () => ({ ...INTENCAO_BASE, status: 'EXPIRED' }) // mas já passou do prazo
  });
  r = respostaFalsa();
  await contextoComTokenVencido(pedido({ token: '11111111-1111-4111-8111-111111111111' }), r);
  conferir(r.codigo === 410, `link vencido responde 410 em /troca/contexto, veio ${r.codigo}`);
  conferir(r.corpo.code === 'PLAN_CHANGE_EXPIRED', 'com o código de expirado');

  /* --- /troca/aprovar ------------------------------------------- */
  t = costura();
  r = respostaFalsa();
  await t.aprovar(pedido({}), r);
  conferir(r.codigo === 400, `aprovar sem token é 400, veio ${r.codigo}`);

  t = costura();
  r = respostaFalsa();
  await t.aprovar(pedido({ token: 'nao-existe' }), r);
  conferir(r.codigo === 404, `aprovar token inexistente é 404, veio ${r.codigo}`);
  conferir(!t.chamou('buscarIntencao'), 'idem: token mal formado não chega ao banco em /troca/aprovar');

  // CP2-11: token que não é texto (um objeto com `toString` forjado lançava no `.test`) é 404, nas duas rotas
  for (const rota of ['contexto', 'aprovar']) {
    t = costura();
    r = respostaFalsa();
    await t[rota](pedido({ token: { toString: 'x' } }), r);
    conferir(r.codigo === 404 && !t.chamou('buscarIntencao'), `CP2-11: /troca/${rota} com token objeto é 404 sem ir ao banco, veio ${r.codigo}`);
  }

  t = costura({ avancarPara: 'COMPLETED' });
  r = respostaFalsa();
  await t.aprovar(pedido({ token: '11111111-1111-4111-8111-111111111111' }), r);
  conferir(r.codigo === 200, `aprovação que conclui responde 200, veio ${r.codigo}`);
  conferir(t.chamou('iniciarCobranca'), 'PENDING_APPROVAL chama iniciarCobranca');
  conferir(!t.chamou('reclassificarPendente'), 'e não reclassifica — é a primeira vez');
  conferir(r.corpo.acerto.cobrado === true, 'e a resposta confirma o acerto cobrado');

  t = costura({ avancarPara: 'PAYMENT_UNKNOWN' });
  r = respostaFalsa();
  await t.aprovar(pedido({ token: '11111111-1111-4111-8111-111111111111' }), r);
  conferir(r.codigo === 202, `ficou ambíguo: 202, poll de novo, veio ${r.codigo}`);

  t = costura({ intencaoInicial: { status: 'PAYMENT_UNKNOWN', charge_id: 'pay_1' }, avancarPara: 'COMPLETED' });
  r = respostaFalsa();
  await t.aprovar(pedido({ token: '11111111-1111-4111-8111-111111111111' }), r);
  conferir(t.chamou('reclassificarPendente'), 'segunda chamada sobre PAYMENT_UNKNOWN reclassifica');
  conferir(!t.chamou('iniciarCobranca'), 'NUNCA cobra de novo numa segunda chamada');
  conferir(r.codigo === 200, `e resolve para 200 quando o veredito fecha PAID, veio ${r.codigo}`);

  t = costura({ intencaoInicial: { status: 'PAYMENT_DECLINED' } });
  r = respostaFalsa();
  await t.aprovar(pedido({ token: '11111111-1111-4111-8111-111111111111' }), r);
  conferir(r.codigo === 402, `intenção já recusada responde 402, veio ${r.codigo}`);
  conferir(!t.chamou('iniciarCobranca') && !t.chamou('reclassificarPendente'), 'estado terminal não dispara nada de novo');

  t = costura({ intencaoInicial: { status: 'STALE' } });
  r = respostaFalsa();
  await t.aprovar(pedido({ token: '11111111-1111-4111-8111-111111111111' }), r);
  conferir(r.codigo === 409, `STALE responde 409, veio ${r.codigo}`);

  t = costura({ intencaoInicial: { status: 'EXPIRED' } });
  r = respostaFalsa();
  await t.aprovar(pedido({ token: '11111111-1111-4111-8111-111111111111' }), r);
  conferir(r.codigo === 410, `EXPIRED responde 410, veio ${r.codigo}`);

  t = costura({ intencaoInicial: { status: 'RECONCILIATION_REQUIRED' } });
  r = respostaFalsa();
  await t.aprovar(pedido({ token: '11111111-1111-4111-8111-111111111111' }), r);
  conferir(r.codigo === 202, `em reconciliação continua 202 — nem sucesso nem falha inventados, veio ${r.codigo}`);

  /* --- exceção inesperada nunca vira promessa rejeitada sem dono ----
     Achado nesta própria revisão: as duas rotas não tinham `try/catch`
     — um banco fora do ar (ou um `token` malformado antes da guarda de
     formato existir) viraria rejeição não tratada dentro de um handler
     assíncrono do Express, que NENHUMA das outras rotas deste projeto
     comete (todas passam por `responderErro`). */
  const contextoQueQuebra = criarTrocaContexto({
    buscarIntencao: async () => { throw new Error('banco fora do ar'); },
    expirarSePassouDoPrazo: async () => null
  });
  r = respostaFalsa();
  await contextoQueQuebra(pedido({ token: '11111111-1111-4111-8111-111111111111' }), r);
  conferir(r.codigo === 502, `exceção inesperada em /troca/contexto responde 502 (via responderErro), veio ${r.codigo}`);

  const aprovarQueQuebra = criarTrocaAprovar({
    buscarIntencao: async () => { throw new Error('banco fora do ar'); },
    executor: { iniciarCobranca: async () => {}, reclassificarPendente: async () => {} }
  });
  r = respostaFalsa();
  await aprovarQueQuebra(pedido({ token: '11111111-1111-4111-8111-111111111111' }), r);
  conferir(r.codigo === 502, `e o mesmo em /troca/aprovar, veio ${r.codigo}`);

  console.log(`trocaAprovacaoController: ${checagens} checagens OK`);
}
