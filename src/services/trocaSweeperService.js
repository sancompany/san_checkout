/**
 * SAN CHECKOUT v2 — src/services/trocaSweeperService.js
 * A rede de segurança da aprovação de troca de plano — roda a cada
 * 60s (`src/server.js`, mesmo padrão de `expurgarErros`/`rodarExpurgo`,
 * `setInterval(...).unref()`), e existe por um motivo medido, não
 * teórico: `PAYMENT_AUTHORIZED` — e qualquer outro evento de captura —
 * não tem garantia de chegar por webhook (este projeto não usa captura
 * manual, `CONSTRAINTS.md` §1.1/§1.2), então uma intenção pode ficar
 * ambígua sem NENHUM aviso da Asaas. 60s é o intervalo mais curto do
 * projeto, deliberadamente: é o que evita uma aprovação pendurada por
 * minutos sem ninguém olhando.
 *
 * NUNCA cria cobrança nova — só `GET` de estado (`consultarStatus`,
 * dentro de `reclassificarPendente`) e avanço por CAS. Sem eleição de
 * líder: se este projeto um dia rodar em mais de uma instância, `GET`
 * duplicado é tolerado (é só leitura), e todo EFEITO passa pelo mesmo
 * CAS que protege o resto da coreografia
 * (`trocaExecucaoService.js`/`trocaIntencaoService.js`).
 *
 * Desenho: `docs/specs/2026-09-20-troca-de-plano-redireciona-pagador.md`,
 * "O sweeper".
 */

import {
  listarIntencoesParaVarredura,
  incrementarTentativaSweeper,
  marcarReconciliacaoNecessaria,
  expirarTodasVencidas
} from './trocaIntencaoService.js';
import { criarExecutorDeTroca } from './trocaExecucaoService.js';
import { registrarErro } from './erroService.js';

/** Depois de quantas tentativas do sweeper uma intenção ainda ambígua
 *  (nem PAID nem recusa definitiva) escalona para `RECONCILIATION_
 *  REQUIRED` — dinheiro que pode ter sido cobrado ou não, e ninguém
 *  consegue mais dizer sozinho. Baixo de propósito: cada tentativa já
 *  representa um ciclo inteiro de 60s sem resolver, então 3 tentativas
 *  são 3 minutos de ambiguidade — o bastante para dar chance a uma
 *  análise antifraude lenta, pouco o bastante para não deixar o
 *  pagador no limbo por muito tempo. */
const MAX_TENTATIVAS_AMBIGUAS = 3;

const dependenciasPadrao = {
  listarIntencoesParaVarredura,
  incrementarTentativaSweeper,
  marcarReconciliacaoNecessaria,
  expirarTodasVencidas,
  executor: criarExecutorDeTroca(),
  registrarErro
};

export function criarSweeper(deps = dependenciasPadrao) {
  /** Uma passada — chamada pelo `setInterval` em `server.js`, e
   *  diretamente pelo autoteste (sem esperar 60s de verdade). */
  async function varrerUmaVez() {
    const relatorio = { examinadas: 0, avancadas: 0, escaladas: 0, erros: 0, expiradas: 0 };

    /* Fora do laço por linha, de propósito: `PENDING_APPROVAL` nem
       entra em `listarIntencoesParaVarredura` (achado no ciclo de
       revisão do PR #36 — um link nunca reaberto ficava PENDING_
       APPROVAL no banco para sempre, mesmo depois de vencido). Um
       `UPDATE` em lote por passada, não um por linha. Erro aqui não
       impede o resto da varredura — vira erro registrado como qualquer
       outro, e a próxima passada tenta de novo. */
    try {
      relatorio.expiradas = await deps.expirarTodasVencidas();
    } catch (erro) {
      relatorio.erros += 1;
      await deps.registrarErro(erro, {
        contexto: 'trocaSweeperService.expiracaoEmLote',
        rota: 'sweeper-troca-de-plano',
        metodo: 'INTERNO'
      });
    }

    const pendentes = await deps.listarIntencoesParaVarredura();
    relatorio.examinadas = pendentes.length;

    for (const intencao of pendentes) {
      try {
        if (['PROCESSING_PAYMENT', 'PAYMENT_UNKNOWN'].includes(intencao.status)) {
          /* Sem `charge_id` não há o que reclassificar — não deveria
             acontecer (só entra em PROCESSING_PAYMENT depois de cobrar),
             mas pular é mais seguro que adivinhar. */
          if (!intencao.charge_id) continue;

          const eraAmbigua = intencao.status === 'PAYMENT_UNKNOWN';
          const resultado = await deps.executor.reclassificarPendente(intencao);
          relatorio.avancadas += 1;

          if (eraAmbigua && resultado.tipo === 'ambigua') {
            await deps.incrementarTentativaSweeper(intencao.id, intencao.tentativas_sweeper);
            if (intencao.tentativas_sweeper + 1 >= MAX_TENTATIVAS_AMBIGUAS) {
              await deps.marcarReconciliacaoNecessaria(intencao.id, 'PAYMENT_UNKNOWN');
              relatorio.escaladas += 1;
            }
          }
        } else if (['PAYMENT_CONFIRMED', 'APPLYING_PLAN'].includes(intencao.status)) {
          /* Confirmado (ou aplicando) e ainda não concluiu: o processo
             que devia terminar isto morreu no meio. Retoma — nunca
             cobra de novo, só termina o que falta
             (`trocaExecucaoService.retomarAplicacao`). */
          await deps.executor.retomarAplicacao(intencao);
          relatorio.avancadas += 1;
        }
        // RECONCILIATION_REQUIRED: nada automático — é dali que o
        // painel/Lei 8 (tabela `erros`) puxa para reparo manual.
      } catch (erro) {
        relatorio.erros += 1;
        await deps.registrarErro(erro, {
          contexto: 'trocaSweeperService.varredura',
          rota: 'sweeper-troca-de-plano',
          metodo: 'INTERNO'
        });
      }
    }

    return relatorio;
  }

  return { varrerUmaVez };
}

export const { varrerUmaVez } = criarSweeper();

/* ------------------------------------------------------------------
   Autoteste — `node src/services/trocaSweeperService.js`
   Sem rede, sem banco: o que se trava é O QUE O SWEEPER FAZ com cada
   estado, e a escalada depois de N tentativas — a coreografia de
   cobrar/aplicar já tem o autoteste dela em `trocaExecucaoService.js`.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('trocaSweeperService.js')) {
  const { strict: assert } = await import('node:assert');
  let checagens = 0;
  const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

  function costura(intencoesIniciais) {
    const chamadas = [];
    const anotar = (nome, args) => chamadas.push({ nome, args });
    const tentativas = new Map(intencoesIniciais.map((i) => [i.id, i.tentativas_sweeper ?? 0]));

    const deps = {
      listarIntencoesParaVarredura: async () => { anotar('listarIntencoesParaVarredura', []); return intencoesIniciais; },
      expirarTodasVencidas: async () => { anotar('expirarTodasVencidas', []); return 0; },
      incrementarTentativaSweeper: async (id, valorEsperado) => {
        anotar('incrementarTentativaSweeper', [id, valorEsperado]);
        tentativas.set(id, valorEsperado + 1);
      },
      marcarReconciliacaoNecessaria: async (id, de) => { anotar('marcarReconciliacaoNecessaria', [id, de]); },
      executor: {
        reclassificarPendente: async (intencao) => {
          anotar('reclassificarPendente', [intencao.id]);
          if (intencao.__resultadoForçado) return intencao.__resultadoForçado;
          return { tipo: 'ambigua' };
        },
        retomarAplicacao: async (intencao) => { anotar('retomarAplicacao', [intencao.id]); }
      },
      registrarErro: async (erro, ctx) => { anotar('registrarErro', [erro?.message, ctx]); }
    };

    return { chamadas, chamou: (nome) => chamadas.some((c) => c.nome === nome), ...criarSweeper(deps) };
  }

  /* --- 1. nada pendente: passada vazia, sem erro ------------------- */
  let s = costura([]);
  let r = await s.varrerUmaVez();
  conferir(r.examinadas === 0 && r.avancadas === 0, 'lista vazia não faz nada');
  conferir(
    s.chamou('expirarTodasVencidas'),
    'TODA passada expira PENDING_APPROVAL vencida em lote — mesmo sem nada para reconsultar por linha, senão um link nunca reaberto fica PENDING_APPROVAL no banco para sempre'
  );

  /* --- 2. PAYMENT_UNKNOWN que se resolve na hora -------------------- */
  s = costura([{ id: 'int_1', status: 'PAYMENT_UNKNOWN', charge_id: 'pay_1', tentativas_sweeper: 0, __resultadoForçado: { tipo: 'confirmada' } }]);
  r = await s.varrerUmaVez();
  conferir(r.avancadas === 1, 'reclassifica uma intenção ambígua');
  conferir(!s.chamou('incrementarTentativaSweeper'), 'resolveu de primeira — não conta como tentativa frustrada');
  conferir(!s.chamou('marcarReconciliacaoNecessaria'), 'e não escalona nada');

  /* --- 3. continua ambígua: conta tentativa, ainda sem escalonar ---- */
  s = costura([{ id: 'int_1', status: 'PAYMENT_UNKNOWN', charge_id: 'pay_1', tentativas_sweeper: 1 }]);
  r = await s.varrerUmaVez();
  conferir(s.chamou('incrementarTentativaSweeper'), 'continuar ambígua conta como tentativa');
  conferir(!s.chamou('marcarReconciliacaoNecessaria'), 'primeira tentativa frustrada ainda não escalona');
  conferir(
    s.chamadas.find((c) => c.nome === 'incrementarTentativaSweeper').args[1] === 1,
    'o incremento é CAS contra o valor que a MESMA passada leu — não lê de novo antes de escrever (duas passadas sobrepostas não perderiam incremento)'
  );

  /* --- 4. terceira tentativa frustrada escalona --------------------- */
  s = costura([{ id: 'int_1', status: 'PAYMENT_UNKNOWN', charge_id: 'pay_1', tentativas_sweeper: 2 }]); // já tentou 2×
  r = await s.varrerUmaVez();
  conferir(r.escaladas === 1, `a 3ª tentativa frustrada escalona, veio ${r.escaladas}`);
  conferir(s.chamou('marcarReconciliacaoNecessaria'), 'e vira RECONCILIATION_REQUIRED — ninguém mais adivinha sozinho');

  /* --- 5. PROCESSING_PAYMENT recém-cobrado, sem tentativa nenhuma
     ainda: não conta tentativa na primeira passada (não é retry, é a
     primeira checagem) --------------------------------------------- */
  s = costura([{ id: 'int_1', status: 'PROCESSING_PAYMENT', charge_id: 'pay_1', tentativas_sweeper: 0 }]);
  r = await s.varrerUmaVez();
  conferir(!s.chamou('incrementarTentativaSweeper'), 'PROCESSING_PAYMENT na primeira checagem não é "continuou ambígua"');

  /* --- 6. sem charge_id: nada a reclassificar ------------------------ */
  s = costura([{ id: 'int_1', status: 'PROCESSING_PAYMENT', charge_id: null, tentativas_sweeper: 0 }]);
  r = await s.varrerUmaVez();
  conferir(!s.chamou('reclassificarPendente'), 'sem charge_id não tem o que reconsultar');
  conferir(r.avancadas === 0, 'e não conta como avançada');

  /* --- 7. PAYMENT_CONFIRMED/APPLYING_PLAN: retomada, nunca cobrança - */
  s = costura([
    { id: 'int_1', status: 'PAYMENT_CONFIRMED', charge_id: 'pay_1' },
    { id: 'int_2', status: 'APPLYING_PLAN', charge_id: 'pay_2' }
  ]);
  r = await s.varrerUmaVez();
  conferir(r.avancadas === 2, 'as duas são retomadas');
  conferir(!s.chamou('reclassificarPendente'), 'retomada nunca passa por reclassificação — o veredito já fechou PAID');

  /* --- 8. RECONCILIATION_REQUIRED: nada automático ------------------- */
  s = costura([{ id: 'int_1', status: 'RECONCILIATION_REQUIRED' }]);
  r = await s.varrerUmaVez();
  conferir(r.avancadas === 0 && r.escaladas === 0, 'já escalonada não é tocada de novo pelo sweeper');

  /* --- 9. uma falha numa linha não derruba a varredura das outras --- */
  const quebra = {
    id: 'int_quebrada', status: 'PROCESSING_PAYMENT', charge_id: 'pay_x', tentativas_sweeper: 0,
    get __resultadoForçado() { throw new Error('rede caiu'); }
  };
  s = costura([quebra, { id: 'int_boa', status: 'PAYMENT_CONFIRMED', charge_id: 'pay_y' }]);
  r = await s.varrerUmaVez();
  conferir(r.erros === 1, 'a linha que quebrou conta como erro');
  conferir(s.chamou('registrarErro'), 'e é registrada (Lei 8)');
  conferir(r.avancadas === 1, 'mas a OUTRA linha continua sendo processada na mesma passada');

  /* --- 10. o número de expiradas em lote chega ao relatório, e uma
     falha na expiração em lote também não derruba o resto -------------- */
  s = costura([]);
  r = await s.varrerUmaVez();
  conferir(typeof r.expiradas === 'number', 'o relatório sempre traz quantas foram expiradas em lote');

  const semExpiracaoFuncionando = criarSweeper({
    listarIntencoesParaVarredura: async () => [{ id: 'int_boa', status: 'PAYMENT_CONFIRMED', charge_id: 'pay_y' }],
    expirarTodasVencidas: async () => { throw new Error('banco fora do ar'); },
    incrementarTentativaSweeper: async () => {},
    marcarReconciliacaoNecessaria: async () => {},
    executor: { reclassificarPendente: async () => ({ tipo: 'ambigua' }), retomarAplicacao: async () => {} },
    registrarErro: async () => {}
  });
  r = await semExpiracaoFuncionando.varrerUmaVez();
  conferir(r.erros === 1, 'a expiração em lote falhando conta como erro');
  conferir(r.avancadas === 1, 'mas a varredura por linha continua rodando mesmo assim');

  console.log(`trocaSweeperService: ${checagens} checagens OK`);
}
