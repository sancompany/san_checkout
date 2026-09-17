/**
 * SAN CHECKOUT — src/services/metricaService.js
 *
 * A conta da métrica de sucesso, separada da busca no banco.
 *
 * Existe separada por um motivo só: **é a parte que decide os números.**
 * Enquanto morava dentro do controller, junto do `supabase.from(...)`,
 * afirmar qualquer coisa sobre ela exigia banco — então nada era
 * afirmado. Aqui é função pura: entram linhas, sai o objeto da resposta.
 *
 * A métrica é "cobranças confirmadas por contratante, por dia"
 * (`docs/funcional.md` §9), por **dia civil de Brasília**
 * (`src/utils/diaCivil.js`).
 */

import { dataCivil, diaCivilAntes } from '../utils/diaCivil.js';

const CONFIRMADOS = ['confirmado'];

/** Cobrança que ainda pode virar pagamento não conta como perdida —
 *  senão a taxa de hoje sempre pareceria péssima. */
const EM_ABERTO = ['pendente', 'em_analise'];

const vazio = () => ({ geradas: 0, pagas: 0, emAberto: 0, perdidas: 0, valorPago: 0 });

const centavos = (n) => Math.round(n * 100) / 100;

/** Taxa sobre o que já se RESOLVEU (pagas + perdidas). Incluir o que
 *  ainda está em aberto no denominador faria a taxa parecer pior só
 *  porque a cobrança é recente. */
function comTaxa(n) {
  const resolvidas = n.pagas + n.perdidas;
  return {
    ...n,
    valorPago: centavos(n.valorPago),
    taxaPagamento: resolvidas > 0 ? Math.round((n.pagas / resolvidas) * 1000) / 10 : null
  };
}

/**
 * @param {object[]} linhas — de `cobrancas`: contratante_id,
 *   metodo_pagamento, status, valor_cobrado, criado_em, confirmado_em
 * @param {string[]} janela — dias civis `AAAA-MM-DD`, do mais antigo ao
 *   mais novo; o último é "hoje"
 */
export function agregarMetricas(linhas, janela) {
  const porMetodo = {};
  const porContratante = {};
  const total = vazio();

  /* Os dias nascem zerados. Dia sem movimento tem de aparecer como zero,
     não desaparecer da série: série com buraco vira gráfico mentiroso, e
     quem lê não distingue "não houve" de "não foi medido". */
  const geradasPorDia = Object.fromEntries(janela.map((d) => [d, vazio()]));
  const confirmadasPorDia = Object.fromEntries(
    janela.map((d) => [d, { confirmadas: 0, valorPago: 0, porContratante: {} }])
  );
  let confirmadasSemData = 0;

  for (const c of linhas ?? []) {
    const metodo = c.metodo_pagamento ?? 'desconhecido';
    const contratante = c.contratante_id ?? 'sem contratante';
    const paga = CONFIRMADOS.includes(c.status);
    const aberta = EM_ABERTO.includes(c.status);
    const valor = Number(c.valor_cobrado ?? 0);

    /* --- por dia de CONFIRMAÇÃO: é a métrica -------------------------
       Responde "quantas entraram naquele dia", independente de quando
       foram geradas. */
    if (paga) {
      const dia = c.confirmado_em ? dataCivil(new Date(c.confirmado_em)) : null;
      if (dia === null) {
        // Confirmada antes da migration 0008: o dado não existe. Vai
        // para um campo próprio em vez de ser jogada num dia qualquer.
        confirmadasSemData += 1;
      } else if (confirmadasPorDia[dia]) {
        const d = confirmadasPorDia[dia];
        d.confirmadas += 1;
        d.valorPago += valor;
        d.porContratante[contratante] = (d.porContratante[contratante] ?? 0) + 1;
      }
    }

    /* --- por dia de GERAÇÃO, e os agregados da janela ----------------
       Visão de coorte: das nascidas naquele dia, quantas viraram
       dinheiro. Avalia a tela e o link, não a entrada de caixa. */
    const diaDeGeracao = dataCivil(new Date(c.criado_em));
    // Linha que entrou na busca só pelo ramo de `confirmado_em` (gerada
    // antes da janela) não conta como gerada aqui.
    if (!geradasPorDia[diaDeGeracao]) continue;

    porMetodo[metodo] ??= vazio();
    porContratante[contratante] ??= vazio();

    for (const alvo of [total, porMetodo[metodo], porContratante[contratante], geradasPorDia[diaDeGeracao]]) {
      alvo.geradas += 1;
      if (paga) { alvo.pagas += 1; alvo.valorPago += valor; }
      else if (aberta) alvo.emAberto += 1;
      else alvo.perdidas += 1;
    }
  }

  const mapear = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, comTaxa(v)]));
  const arredondar = (d) => ({ ...d, valorPago: centavos(d.valorPago) });

  const hoje = janela[janela.length - 1];
  const ontem = diaCivilAntes(hoje, 1);

  return {
    de: janela[0],
    ate: hoje,

    /* As duas respostas diretas da pergunta da prontidão. `ontem` só vem
       quando está DENTRO da janela pedida: com `dias=1` ele não foi
       contado, e devolver zero ali seria AFIRMAR que não houve nenhuma —
       que é diferente de não ter olhado. */
    hoje: arredondar({ data: hoje, ...confirmadasPorDia[hoje] }),
    ontem: confirmadasPorDia[ontem]
      ? arredondar({ data: ontem, ...confirmadasPorDia[ontem] })
      : { data: ontem, foraDaJanela: true },

    confirmadasPorDia: Object.fromEntries(
      Object.entries(confirmadasPorDia).map(([d, v]) => [d, arredondar(v)])
    ),
    confirmadasSemData,

    geradasPorDia: mapear(geradasPorDia),
    total: comTaxa(total),
    porMetodo: mapear(porMetodo),
    porContratante: mapear(porContratante)
  };
}

/* ------------------------------------------------------------------
   Autoteste — `node src/services/metricaService.js`
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('metricaService.js')) {
  const { strict: assert } = await import('node:assert');
  const { ultimosDiasCivis } = await import('../utils/diaCivil.js');

  let checagens = 0;
  const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

  const JANELA = ['2026-09-14', '2026-09-15', '2026-09-16'];

  /* --- 1. gerada num dia, confirmada no outro: conta nos DOIS, e é o certo
     É o caso que motivou a coluna `confirmado_em`. Uma cobrança nascida
     dia 15 e paga dia 16 é coorte do 15 e caixa do 16. Os dois números
     estarem diferentes não é inconsistência. */
  let r = agregarMetricas([{
    contratante_id: 'mostrai', metodo_pagamento: 'pix', status: 'confirmado', valor_cobrado: 100,
    criado_em: '2026-09-15T14:00:00Z', confirmado_em: '2026-09-16T14:00:00Z'
  }], JANELA);
  conferir(r.confirmadasPorDia['2026-09-16'].confirmadas === 1, 'entrou no dia em que CONFIRMOU');
  conferir(r.confirmadasPorDia['2026-09-15'].confirmadas === 0, 'não entrou no dia em que foi gerada');
  conferir(r.geradasPorDia['2026-09-15'].geradas === 1, 'a coorte é do dia da geração');
  conferir(r.geradasPorDia['2026-09-15'].pagas === 1, 'e a coorte sabe que ela pagou');
  conferir(r.hoje.confirmadas === 1 && r.hoje.data === '2026-09-16', 'hoje é o último dia da janela');
  conferir(r.ontem.confirmadas === 0 && r.ontem.data === '2026-09-15', 'ontem é o penúltimo');

  /* --- 2. a virada do dia em Brasília, que é o motivo de tudo isto ---
     02:30Z do dia 17 ainda é dia 16 em Brasília. Contar em UTC jogaria
     esta cobrança num dia que, para quem opera, não começou. */
  r = agregarMetricas([{
    contratante_id: 'x', metodo_pagamento: 'pix', status: 'confirmado', valor_cobrado: 50,
    criado_em: '2026-09-17T02:30:00Z', confirmado_em: '2026-09-17T02:30:00Z'
  }], JANELA);
  conferir(r.confirmadasPorDia['2026-09-16'].confirmadas === 1, '02:30Z do dia 17 conta no dia 16 de Brasília');
  conferir(r.geradasPorDia['2026-09-16'].geradas === 1, 'e a geração também');

  /* --- 3. dia sem movimento aparece como zero, não desaparece --- */
  conferir(
    Object.keys(r.confirmadasPorDia).length === 3 && r.confirmadasPorDia['2026-09-14'].confirmadas === 0,
    'todo dia da janela aparece, mesmo zerado — buraco na série vira gráfico mentiroso'
  );

  /* --- 4. confirmada sem data não é jogada num dia qualquer --- */
  r = agregarMetricas([{
    contratante_id: 'x', metodo_pagamento: 'pix', status: 'confirmado', valor_cobrado: 10,
    criado_em: '2026-09-15T12:00:00Z', confirmado_em: null
  }], JANELA);
  conferir(r.confirmadasSemData === 1, 'confirmada sem data vai para o campo próprio');
  const somaDias = Object.values(r.confirmadasPorDia).reduce((a, d) => a + d.confirmadas, 0);
  conferir(somaDias === 0, 'e NÃO entra em nenhum dia — inventar o dia seria precisão falsa');

  /* --- 5. gerada ANTES da janela e confirmada DENTRO ----------------
     É o caso da assinatura: o ciclo nasce num mês e confirma noutro.
     Tem de contar como caixa do dia da confirmação, e não como coorte
     de um dia que não está na janela. */
  r = agregarMetricas([{
    contratante_id: 'mostrai', metodo_pagamento: 'assinatura', status: 'confirmado', valor_cobrado: 267.30,
    criado_em: '2026-06-15T12:00:00Z', confirmado_em: '2026-09-15T12:00:00Z'
  }], JANELA);
  conferir(r.confirmadasPorDia['2026-09-15'].confirmadas === 1, 'confirmação dentro da janela conta');
  conferir(r.total.geradas === 0, 'geração fora da janela não infla as geradas');
  conferir(r.confirmadasPorDia['2026-09-15'].valorPago === 267.3, 'e o valor vem certo');

  /* --- 6. a taxa ignora o que ainda está em aberto ------------------- */
  r = agregarMetricas([
    { contratante_id: 'a', metodo_pagamento: 'pix', status: 'confirmado', valor_cobrado: 10, criado_em: '2026-09-16T12:00:00Z', confirmado_em: '2026-09-16T12:00:00Z' },
    { contratante_id: 'a', metodo_pagamento: 'pix', status: 'vencido', valor_cobrado: 10, criado_em: '2026-09-16T12:00:00Z', confirmado_em: null },
    { contratante_id: 'a', metodo_pagamento: 'pix', status: 'pendente', valor_cobrado: 10, criado_em: '2026-09-16T12:00:00Z', confirmado_em: null }
  ], JANELA);
  conferir(r.total.geradas === 3, 'três geradas');
  conferir(r.total.taxaPagamento === 50, `taxa é 1 de 2 resolvidas = 50%, deu ${r.total.taxaPagamento}`);
  conferir(r.total.emAberto === 1, 'a pendente fica em aberto, fora do denominador');

  /* --- 7. `dias = 1`: ontem não vira zero, vira "não olhei" ---------- */
  r = agregarMetricas([], ['2026-09-16']);
  conferir(r.ontem.foraDaJanela === true, 'com janela de 1 dia, ontem é declarado fora');
  conferir(r.ontem.confirmadas === undefined, 'e não recebe zero — zero afirmaria que não houve nenhuma');
  conferir(r.hoje.confirmadas === 0, 'hoje, esse sim, é zero de verdade');

  /* --- 8. por contratante, dentro do dia --------------------------- */
  r = agregarMetricas([
    { contratante_id: 'mostrai', metodo_pagamento: 'pix', status: 'confirmado', valor_cobrado: 10, criado_em: '2026-09-16T12:00:00Z', confirmado_em: '2026-09-16T12:00:00Z' },
    { contratante_id: 'mostrai', metodo_pagamento: 'pix', status: 'confirmado', valor_cobrado: 20, criado_em: '2026-09-16T12:00:00Z', confirmado_em: '2026-09-16T12:00:00Z' },
    { contratante_id: 'outro', metodo_pagamento: 'boleto', status: 'confirmado', valor_cobrado: 5, criado_em: '2026-09-16T12:00:00Z', confirmado_em: '2026-09-16T12:00:00Z' }
  ], JANELA);
  conferir(r.confirmadasPorDia['2026-09-16'].porContratante.mostrai === 2, 'dois do mostrai no dia');
  conferir(r.confirmadasPorDia['2026-09-16'].porContratante.outro === 1, 'um do outro');
  conferir(r.confirmadasPorDia['2026-09-16'].valorPago === 35, 'soma do dia');

  /* --- 9. a janela real, vinda de diaCivil, tem o tamanho pedido ----- */
  const real = ultimosDiasCivis(7);
  conferir(Object.keys(agregarMetricas([], real).confirmadasPorDia).length === 7, 'sete dias pedidos, sete devolvidos');

  /* --- 10. entrada vazia ou nula não estoura ------------------------- */
  conferir(agregarMetricas(null, JANELA).total.geradas === 0, 'null não estoura');
  conferir(agregarMetricas([], JANELA).total.taxaPagamento === null, 'sem resolvidas, taxa é null e não 0%');

  console.log(`metricaService: ${checagens} checagens OK`);
}
