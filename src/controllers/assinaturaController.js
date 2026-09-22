/**
 * SAN CHECKOUT v2 — src/controllers/assinaturaController.js
 * POST /api/checkout/cancelar-assinatura
 * Header: X-Checkout-Key (a MESMA chave do contratante, já usada em
 * /pedido e /estornar)
 * Body: { planoId, documento }
 *
 * "Cancelamento: só o projeto aciona — o pagador nunca cancela direto
 * no checkout" (API.md §5.5).
 * Por isso a busca é por planoId+documento (o que o projeto contratante
 * tem) e não pelo id da assinatura na Asaas (que o projeto nunca chega
 * a ver — só existe internamente, na tabela `assinaturas`).
 *
 * Cancelar aqui só PARA a geração de cobranças futuras — não estorna
 * nenhuma cobrança já paga (se for o caso, usar /estornar separado).
 *
 * Auth, validação (400/401), a busca por `ativa`/`pausada` e o ciclo
 * inteiro (pausar → retomar → cancelar) exercitados ao vivo em
 * 15-16/09/2026 contra uma assinatura real (cartão de teste no pop-up,
 * não fixture) — foi como o furo do RN-19 (pausar sem saída) foi
 * provado, e como se achou este: até 16/09/2026 o cancelamento não
 * mandava `evento: 'cancelada'` pro webhook do contratante, só a
 * resposta síncrona — quebrando a promessa do `API.md` §7.4. Agora
 * `notificarAssinaturaCancelada` fecha isso (fire-and-forget, mesmo
 * canal que os outros dois desfechos de `cancelada` já usavam).
 *
 * ── Reivindica antes de mudar, desde 22/09/2026 ───────────────────────
 * Achado numa auditoria externa (Codex), confirmado lendo o código:
 * nenhuma das três rotas tinha guarda de corrida nenhuma. Duas chamadas
 * simultâneas para a MESMA assinatura (duas de `/cancelar-assinatura`,
 * ou um `/cancelar-assinatura` cruzando com um `/pausar-assinatura`, ou
 * qualquer uma delas cruzando com uma troca de plano em andamento)
 * liam todas o mesmo estado e agiam todas sobre ele — sem cobrar
 * dinheiro nenhum diretamente, mas com o mesmo problema de fundo:
 * chamadas repetidas/concorrentes na Asaas por um estado que já mudou
 * debaixo delas. Agora as três reivindicam o MESMO arrendamento que
 * `trocaPlanoController.js`/`trocaExecucaoService.js` já usam
 * (`assinaturaService.reivindicarTroca`, `assinaturas.trocando_em`) —
 * ele não é mais exclusivo da troca de plano, é o mutex de QUALQUER
 * operação que muda uma assinatura na Asaas. A falha à Asaas em
 * qualquer uma das três SEMPRE libera o arrendamento (ao contrário do
 * caminho de dinheiro): nenhuma das três cobra, então não existe
 * ambiguidade de "será que já cobrou" a proteger — se a chamada falhou
 * de um jeito ambíguo (timeout) e a Asaas processou mesmo assim, é a
 * conciliação por pull (`API.md` §5.3) que corrige o `status` local
 * depois, mecanismo já existente desde 16/09/2026 e fora do escopo
 * desta correção.
 */

import { buscarContratantePorChave } from '../services/pedidoService.js';
import {
  buscarAssinaturaAtiva,
  atualizarStatusAssinatura,
  reivindicarTroca,
  liberarTroca
} from '../services/assinaturaService.js';
import {
  cancelarAssinatura as cancelarAssinaturaNaAsaas,
  alterarStatusAssinatura
} from '../services/asaasService.js';
import { notificarAssinaturaCancelada } from './webhookController.js';
import { documentoValido, normalizarDocumento } from '../utils/validadores.js';
import { responderErro } from '../utils/erros.js';

const dependenciasPadrao = {
  buscarContratantePorChave,
  buscarAssinaturaAtiva,
  atualizarStatusAssinatura,
  reivindicarTroca,
  liberarTroca,
  cancelarAssinaturaNaAsaas,
  alterarStatusAssinatura,
  notificarAssinaturaCancelada
};

const MENSAGEM_OPERACAO_EM_ANDAMENTO =
  'Já existe outra operação em andamento para esta assinatura (troca de plano, cancelamento, pausa ou retomada). Tente novamente em instantes.';

export function criarAssinaturaController(deps = dependenciasPadrao) {
  async function cancelarAssinatura(requisicao, resposta) {
    const chave = requisicao.get('X-Checkout-Key');
    let { planoId, documento } = requisicao.body ?? {};

    if (!chave) return resposta.status(401).json({ erro: 'X-Checkout-Key ausente.' });
    if (!planoId || !documento) return resposta.status(400).json({ erro: 'planoId e documento são obrigatórios.' });
    if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });

    // Dígitos, e daqui para baixo é só esta forma (RN-32) — a explicação
    // inteira está em `normalizarDocumento`, em `utils/validadores.js`.
    documento = normalizarDocumento(documento);

    let assinaturaIdArrendada = null;
    try {
      const contratante = await deps.buscarContratantePorChave(chave);
      if (!contratante) return resposta.status(401).json({ erro: 'Chave inválida.' });

      /* `pausada` entra aqui, e a falta dela era um beco sem saída.

         Até 15/09/2026 esta busca usava o default `['ativa']`, e o efeito
         foi medido ao vivo: uma assinatura pausada respondia 200 no
         `/pausar-assinatura` (que aceita `pausada`) e 404 no
         `/cancelar-assinatura` — a MESMA linha, o mesmo plano, o mesmo
         documento. Quem pausasse não conseguia mais cancelar por lugar
         nenhum: a assinatura ficava INACTIVE na Asaas para sempre, e o
         único caminho era mexer no painel na mão.

         `cancelada` fica de FORA de propósito. Seria simpático responder
         `jaEstava: true` como pausar/retomar fazem, mas esta busca ordena
         por `criado_em` desc e pega uma só: numa renovação (duas linhas
         para o mesmo plano+documento), aceitar `cancelada` faria a antiga
         recém-encerrada mascarar uma ativa mais nova em algum caso de
         ordem. 404 aqui é honesto — não há assinatura cancelável. */
      const assinatura = await deps.buscarAssinaturaAtiva(
        contratante.id, planoId, documento, ['ativa', 'pausada']
      );
      if (!assinatura) {
        return resposta.status(404).json({ erro: 'Nenhuma assinatura ativa ou pausada encontrada pra esse plano/documento.' });
      }

      const arrendamentoMeu = await deps.reivindicarTroca(assinatura.id);
      if (!arrendamentoMeu) {
        return resposta.status(409).json({ erro: MENSAGEM_OPERACAO_EM_ANDAMENTO });
      }
      assinaturaIdArrendada = assinatura.id;

      await deps.cancelarAssinaturaNaAsaas(assinatura.id);
      await deps.atualizarStatusAssinatura(assinatura.id, 'cancelada');

      // Fire-and-forget (deps.notificar não espera) — a resposta síncrona
      // abaixo já confirma pra quem chamou; o webhook é só pra manter o
      // MESMO canal que os outros dois desfechos de 'cancelada' usam
      // (API.md §7.4 promete essa seta, e até 16/09/2026 ela não existia).
      deps.notificarAssinaturaCancelada(contratante, { planoId, documento });

      resposta.json({ assinaturaId: assinatura.id, status: 'cancelada' });
    } catch (erro) {
      /* Cancelar/pausar/retomar nunca cobram nada — ao contrário do
         acerto de troca de plano, não há dinheiro em trânsito cuja
         ambiguidade proteger. Devolver o arrendamento é sempre seguro:
         se a Asaas processou mesmo com a chamada tendo falhado aqui, é
         a conciliação por pull que corrige o `status` local depois
         (declarado e fechado por esse caminho em 16/09/2026). */
      if (assinaturaIdArrendada) await deps.liberarTroca(assinaturaIdArrendada);
      responderErro(resposta, erro, 'assinaturaController.cancelarAssinatura');
    }
  }

  /**
   * Pausar e retomar — `POST /api/checkout/pausar-assinatura` e
   * `/retomar-assinatura`, mesma autenticação e mesmo body do
   * cancelamento.
   *
   * Por que isso importa: antes só existia CANCELAR, que é definitivo. Um
   * assinante que queria parar por um mês tinha que ser cancelado e
   * assinar tudo de novo depois — na prática, virava churn. Pausado, o
   * mesmo vínculo volta a cobrar quando for reativado.
   *
   * Uma fábrica em vez de dois handlers quase idênticos: só mudam o
   * status na Asaas, o status local e quais status locais são aceitos na
   * busca.
   */
  function criarHandlerDeStatus({ statusAsaas, statusLocal, statusAceitos, nomeDoHandler }) {
    return async function handler(requisicao, resposta) {
      const chave = requisicao.get('X-Checkout-Key');
      let { planoId, documento } = requisicao.body ?? {};

      if (!chave) return resposta.status(401).json({ erro: 'X-Checkout-Key ausente.' });
      if (!planoId || !documento) return resposta.status(400).json({ erro: 'planoId e documento são obrigatórios.' });
      if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });

      // Dígitos, como no `cancelarAssinatura` acima — ver a nota lá.
      documento = normalizarDocumento(documento);

      let assinaturaIdArrendada = null;
      try {
        const contratante = await deps.buscarContratantePorChave(chave);
        if (!contratante) return resposta.status(401).json({ erro: 'Chave inválida.' });

        const assinatura = await deps.buscarAssinaturaAtiva(contratante.id, planoId, documento, statusAceitos);
        if (!assinatura) {
          return resposta.status(404).json({ erro: `Nenhuma assinatura ${statusAceitos.join(' ou ')} encontrada pra esse plano/documento.` });
        }

        // Já está no estado pedido: responde sucesso sem chamar a Asaas
        // NEM reivindicar o arrendamento — não há nada a serializar
        // quando não vai existir chamada nenhuma.
        if (assinatura.status === statusLocal) {
          return resposta.json({ assinaturaId: assinatura.id, status: statusLocal, jaEstava: true });
        }

        const arrendamentoMeu = await deps.reivindicarTroca(assinatura.id);
        if (!arrendamentoMeu) {
          return resposta.status(409).json({ erro: MENSAGEM_OPERACAO_EM_ANDAMENTO });
        }
        assinaturaIdArrendada = assinatura.id;

        await deps.alterarStatusAssinatura(assinatura.id, statusAsaas);
        await deps.atualizarStatusAssinatura(assinatura.id, statusLocal);

        resposta.json({ assinaturaId: assinatura.id, status: statusLocal });
      } catch (erro) {
        // Mesma razão do catch de cancelarAssinatura: nenhuma das duas
        // cobra dinheiro, então devolver o arrendamento é sempre seguro.
        if (assinaturaIdArrendada) await deps.liberarTroca(assinaturaIdArrendada);
        responderErro(resposta, erro, `assinaturaController.${nomeDoHandler}`);
      }
    };
  }

  const pausarAssinatura = criarHandlerDeStatus({
    statusAsaas: 'INACTIVE',
    statusLocal: 'pausada',
    statusAceitos: ['ativa', 'pausada'],
    nomeDoHandler: 'pausarAssinatura'
  });

  const retomarAssinatura = criarHandlerDeStatus({
    statusAsaas: 'ACTIVE',
    statusLocal: 'ativa',
    statusAceitos: ['pausada', 'ativa'],
    nomeDoHandler: 'retomarAssinatura'
  });

  return { cancelarAssinatura, pausarAssinatura, retomarAssinatura };
}

export const { cancelarAssinatura, pausarAssinatura, retomarAssinatura } = criarAssinaturaController();

/* ── Autoteste ──────────────────────────────────────────────────────── */
if (process.argv[1]?.endsWith('assinaturaController.js')) {
  const { strict: assert } = await import('node:assert');

  function costura(ajustes = {}) {
    const linhas = new Map(); // id -> { status }
    const chamadasAsaas = [];
    const notificacoes = [];

    function fixture(id, status) {
      linhas.set(id, { id, status });
    }

    const deps = {
      buscarContratantePorChave: async (chave) => (chave === 'chave_boa' ? { id: 'c1' } : null),

      buscarAssinaturaAtiva: async (_contratanteId, planoId, _documento, statusAceitos) => {
        const linha = linhas.get(planoId);
        if (!linha) return null;
        return statusAceitos.includes(linha.status) ? { ...linha } : null;
      },

      reivindicarTroca: async (id) => {
        if (ajustes.arrendamentoOcupado) return false;
        return true;
      },

      liberarTroca: async () => {},

      cancelarAssinaturaNaAsaas: async (id) => {
        chamadasAsaas.push({ acao: 'cancelar', id });
        if (ajustes.erroNaAsaas) throw ajustes.erroNaAsaas;
      },

      alterarStatusAssinatura: async (id, statusAsaas) => {
        chamadasAsaas.push({ acao: 'alterarStatus', id, statusAsaas });
        if (ajustes.erroNaAsaas) throw ajustes.erroNaAsaas;
      },

      atualizarStatusAssinatura: async (id, status) => {
        const linha = linhas.get(id) ?? linhas.get('plano_x');
        if (linha) linha.status = status;
      },

      notificarAssinaturaCancelada: (...args) => { notificacoes.push(args); }
    };

    return { deps, linhas, chamadasAsaas, notificacoes, fixture };
  }

  function respostaFalsa() {
    const r = {
      codigo: null, corpo: null,
      status(c) { this.codigo = c; return this; },
      json(c) { this.corpo = c; return this; }
    };
    return r;
  }

  function requisicaoFalsa({ chave, planoId, documento }) {
    return { get: (h) => (h === 'X-Checkout-Key' ? chave : undefined), body: { planoId, documento } };
  }

  const CPF_VALIDO = '11144477735';

  let checagens = 0;

  // 1. cancelarAssinatura: caminho feliz reivindica ANTES de chamar a Asaas.
  {
    const { deps, linhas, chamadasAsaas, notificacoes, fixture } = costura();
    fixture('plano_a', 'ativa');
    const controller = criarAssinaturaController(deps);
    const resposta = respostaFalsa();
    await controller.cancelarAssinatura(requisicaoFalsa({ chave: 'chave_boa', planoId: 'plano_a', documento: CPF_VALIDO }), resposta);
    assert.equal(resposta.corpo?.status, 'cancelada');
    assert.equal(linhas.get('plano_a').status, 'cancelada');
    assert.equal(chamadasAsaas.length, 1);
    assert.equal(notificacoes.length, 1, 'avisa o contratante');
    checagens += 1;
  }

  // 2. cancelarAssinatura: arrendamento ocupado (troca de plano em andamento) → 409, Asaas nunca chamada.
  {
    const { deps, chamadasAsaas, fixture } = costura({ arrendamentoOcupado: true });
    fixture('plano_b', 'ativa');
    const controller = criarAssinaturaController(deps);
    const resposta = respostaFalsa();
    await controller.cancelarAssinatura(requisicaoFalsa({ chave: 'chave_boa', planoId: 'plano_b', documento: CPF_VALIDO }), resposta);
    assert.equal(resposta.codigo, 409);
    assert.equal(chamadasAsaas.length, 0);
    checagens += 1;
  }

  // 3. cancelarAssinatura: falha na Asaas SEMPRE libera o arrendamento (nunca cobra dinheiro).
  {
    const { deps, fixture } = costura({ erroNaAsaas: Object.assign(new Error('timeout'), { status: 504 }) });
    fixture('plano_c', 'ativa');
    let liberou = false;
    deps.liberarTroca = async () => { liberou = true; };
    const controller = criarAssinaturaController(deps);
    const resposta = respostaFalsa();
    await controller.cancelarAssinatura(requisicaoFalsa({ chave: 'chave_boa', planoId: 'plano_c', documento: CPF_VALIDO }), resposta);
    assert.equal(resposta.codigo, 504);
    assert.ok(liberou, 'o arrendamento é devolvido mesmo numa falha ambígua — não há dinheiro a proteger aqui');
    checagens += 1;
  }

  // 4. pausarAssinatura: já pausada → 'jaEstava', nunca reivindica nem chama a Asaas.
  {
    const { deps, chamadasAsaas, fixture } = costura();
    fixture('plano_d', 'pausada');
    let reivindicou = false;
    deps.reivindicarTroca = async () => { reivindicou = true; return true; };
    const controller = criarAssinaturaController(deps);
    const resposta = respostaFalsa();
    await controller.pausarAssinatura(requisicaoFalsa({ chave: 'chave_boa', planoId: 'plano_d', documento: CPF_VALIDO }), resposta);
    assert.equal(resposta.corpo?.jaEstava, true);
    assert.ok(!reivindicou, 'nada a serializar quando não vai chamar a Asaas');
    assert.equal(chamadasAsaas.length, 0);
    checagens += 1;
  }

  // 5. pausarAssinatura: corrida real — duas chamadas simultâneas na MESMA assinatura,
  //    só uma reivindica e chama a Asaas.
  {
    const linhas = new Map([['plano_e', { id: 'plano_e', status: 'ativa' }]]);
    let arrendada = false;
    const deps = {
      buscarContratantePorChave: async () => ({ id: 'c1' }),
      buscarAssinaturaAtiva: async (_c, planoId, _d, statusAceitos) => {
        const linha = linhas.get(planoId);
        return linha && statusAceitos.includes(linha.status) ? { ...linha } : null;
      },
      reivindicarTroca: async () => {
        if (arrendada) return false;
        arrendada = true;
        return true;
      },
      liberarTroca: async () => { arrendada = false; },
      alterarStatusAssinatura: async () => {},
      atualizarStatusAssinatura: async (id, status) => { const l = linhas.get('plano_e'); if (l) l.status = status; },
      notificarAssinaturaCancelada: () => {}
    };
    const controller = criarAssinaturaController(deps);
    const resposta1 = respostaFalsa();
    const resposta2 = respostaFalsa();
    await Promise.all([
      controller.pausarAssinatura(requisicaoFalsa({ chave: 'chave_boa', planoId: 'plano_e', documento: CPF_VALIDO }), resposta1),
      controller.pausarAssinatura(requisicaoFalsa({ chave: 'chave_boa', planoId: 'plano_e', documento: CPF_VALIDO }), resposta2)
    ]);
    const codigos = [resposta1.codigo ?? 200, resposta2.codigo ?? 200].sort();
    assert.deepEqual(codigos, [200, 409], 'só uma das duas chamadas simultâneas vence a corrida');
    checagens += 1;
  }

  // 6. retomarAssinatura: mesma fábrica, caminho feliz.
  {
    const { deps, linhas, chamadasAsaas, fixture } = costura();
    fixture('plano_f', 'pausada');
    const controller = criarAssinaturaController(deps);
    const resposta = respostaFalsa();
    await controller.retomarAssinatura(requisicaoFalsa({ chave: 'chave_boa', planoId: 'plano_f', documento: CPF_VALIDO }), resposta);
    assert.equal(resposta.corpo?.status, 'ativa');
    assert.equal(linhas.get('plano_f').status, 'ativa');
    assert.equal(chamadasAsaas.length, 1);
    checagens += 1;
  }

  // 7. Sem chave / chave errada / sem assinatura → 401/401/404, sem tocar a Asaas.
  {
    const { deps, chamadasAsaas, fixture } = costura();
    fixture('plano_g', 'ativa');
    const controller = criarAssinaturaController(deps);

    const r1 = respostaFalsa();
    await controller.cancelarAssinatura(requisicaoFalsa({ chave: undefined, planoId: 'plano_g', documento: CPF_VALIDO }), r1);
    assert.equal(r1.codigo, 401);

    const r2 = respostaFalsa();
    await controller.cancelarAssinatura(requisicaoFalsa({ chave: 'chave_errada', planoId: 'plano_g', documento: CPF_VALIDO }), r2);
    assert.equal(r2.codigo, 401);

    const r3 = respostaFalsa();
    await controller.cancelarAssinatura(requisicaoFalsa({ chave: 'chave_boa', planoId: 'inexistente', documento: CPF_VALIDO }), r3);
    assert.equal(r3.codigo, 404);

    assert.equal(chamadasAsaas.length, 0);
    checagens += 1;
  }

  console.log(`assinaturaController: ${checagens} checagens OK`);
}
