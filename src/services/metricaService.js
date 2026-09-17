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
 *
 * ── USO INTERNO NÃO CONTA ────────────────────────────────────────────
 * A prontidão operacional exige a métrica "com uso interno filtrado,
 * para o dono testando não contaminar". Duas coisas saem da conta de
 * negócio (migration 0009):
 *
 *   `ambiente != 'producao'` — cobrança de sandbox. Não é dinheiro.
 *   `e_teste = true`         — cobrança de PRODUÇÃO que o operador
 *                              marcou como teste dele.
 *
 * O filtro mora AQUI, na função pura, e não na consulta: quem escreve a
 * consulta pode esquecer, e uma consulta esquecida devolve número
 * inflado sem nenhum sinal. Guarda na raiz, um diff só.
 *
 * **E o que sai é RELATADO, não descartado em silêncio.** Hoje as 10
 * cobranças do banco são todas de sandbox, então a métrica de negócio é
 * zero — que é o número verdadeiro, e um zero sem explicação parece
 * defeito. `excluidas` diz quantas ficaram de fora e por quê, para o
 * painel poder mostrar as duas coisas: o que é negócio, e o que foi
 * exercício.
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
 *   metodo_pagamento, status, valor_cobrado, criado_em, confirmado_em,
 *   **ambiente e e_teste** (o filtro de negócio depende das duas: coluna
 *   que não vier no `select` chega `undefined` e a linha sai da conta)
 * @param {string[]} janela — dias civis `AAAA-MM-DD`, do mais antigo ao
 *   mais novo; o último é "hoje"
 */
/** Cobrança que conta como resultado de negócio. Ver a nota no topo. */
function eDeNegocio(c) {
  return c.ambiente === 'producao' && c.e_teste !== true;
}

export function agregarMetricas(linhas, janela) {
  const porMetodo = {};
  const porContratante = {};
  const total = vazio();

  /* O que sai da conta, contado por motivo. Nenhuma linha desaparece
     sem aparecer aqui. */
  const excluidas = { sandbox: 0, teste: 0 };

  /* Os dias nascem zerados. Dia sem movimento tem de aparecer como zero,
     não desaparecer da série: série com buraco vira gráfico mentiroso, e
     quem lê não distingue "não houve" de "não foi medido". */
  const geradasPorDia = Object.fromEntries(janela.map((d) => [d, vazio()]));
  const confirmadasPorDia = Object.fromEntries(
    janela.map((d) => [d, { confirmadas: 0, valorPago: 0, porContratante: {} }])
  );
  let confirmadasSemData = 0;

  for (const c of linhas ?? []) {
    /* Fora da conta de negócio, mas dentro do relatório. A ordem dos
       dois ramos importa: cobrança de sandbox marcada como teste conta
       uma vez só, e conta como sandbox — que é a razão mais forte. */
    if (!eDeNegocio(c)) {
      if (c.ambiente !== 'producao') excluidas.sandbox += 1;
      else excluidas.teste += 1;
      continue;
    }

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

    /* O que NÃO entrou, e por quê. Zero em tudo com `excluidas` alto é
       resposta completa; zero sem isto é resposta que parece defeito. */
    excluidas: { ...excluidas, total: excluidas.sandbox + excluidas.teste },

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

  /* Todo dublê abaixo declara `ambiente: 'producao'`, e não é decoração:
     desde a migration 0009 a conta de negócio exclui sandbox e teste, e
     cobrança sem ambiente declarado NÃO conta. Quando esta regra entrou,
     as 26 checagens que já existiam aqui ficaram vermelhas de uma vez —
     que é o guarda funcionando: ele falha fechado. A seção 11 exercita
     justamente o lado da exclusão.
     Um dublê que esquecesse o ambiente passaria a medir o filtro em vez
     da conta, e silenciosamente: por isso o ambiente é explícito em
     cada um, nunca um default do dublê. */

  /* --- 1. gerada num dia, confirmada no outro: conta nos DOIS, e é o certo
     É o caso que motivou a coluna `confirmado_em`. Uma cobrança nascida
     dia 15 e paga dia 16 é coorte do 15 e caixa do 16. Os dois números
     estarem diferentes não é inconsistência. */
  let r = agregarMetricas([{
    contratante_id: 'mostrai', ambiente: 'producao', metodo_pagamento: 'pix', status: 'confirmado', valor_cobrado: 100,
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
    contratante_id: 'x', ambiente: 'producao', metodo_pagamento: 'pix', status: 'confirmado', valor_cobrado: 50,
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
    contratante_id: 'x', ambiente: 'producao', metodo_pagamento: 'pix', status: 'confirmado', valor_cobrado: 10,
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
    contratante_id: 'mostrai', ambiente: 'producao', metodo_pagamento: 'assinatura', status: 'confirmado', valor_cobrado: 267.30,
    criado_em: '2026-06-15T12:00:00Z', confirmado_em: '2026-09-15T12:00:00Z'
  }], JANELA);
  conferir(r.confirmadasPorDia['2026-09-15'].confirmadas === 1, 'confirmação dentro da janela conta');
  conferir(r.total.geradas === 0, 'geração fora da janela não infla as geradas');
  conferir(r.confirmadasPorDia['2026-09-15'].valorPago === 267.3, 'e o valor vem certo');

  /* --- 6. a taxa ignora o que ainda está em aberto ------------------- */
  r = agregarMetricas([
    { contratante_id: 'a', ambiente: 'producao', metodo_pagamento: 'pix', status: 'confirmado', valor_cobrado: 10, criado_em: '2026-09-16T12:00:00Z', confirmado_em: '2026-09-16T12:00:00Z' },
    { contratante_id: 'a', ambiente: 'producao', metodo_pagamento: 'pix', status: 'vencido', valor_cobrado: 10, criado_em: '2026-09-16T12:00:00Z', confirmado_em: null },
    { contratante_id: 'a', ambiente: 'producao', metodo_pagamento: 'pix', status: 'pendente', valor_cobrado: 10, criado_em: '2026-09-16T12:00:00Z', confirmado_em: null }
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
    { contratante_id: 'mostrai', ambiente: 'producao', metodo_pagamento: 'pix', status: 'confirmado', valor_cobrado: 10, criado_em: '2026-09-16T12:00:00Z', confirmado_em: '2026-09-16T12:00:00Z' },
    { contratante_id: 'mostrai', ambiente: 'producao', metodo_pagamento: 'pix', status: 'confirmado', valor_cobrado: 20, criado_em: '2026-09-16T12:00:00Z', confirmado_em: '2026-09-16T12:00:00Z' },
    { contratante_id: 'outro', ambiente: 'producao', metodo_pagamento: 'boleto', status: 'confirmado', valor_cobrado: 5, criado_em: '2026-09-16T12:00:00Z', confirmado_em: '2026-09-16T12:00:00Z' }
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

  /* --- 11. USO INTERNO NÃO CONTA, E APARECE NO RELATÓRIO -----------
     A prontidão operacional pede a métrica "com uso interno filtrado".
     Medido em 17/09/2026 contra produção: `testemaster` tinha 1
     confirmada de R$ 10,00 — a assinatura de teste de 16/09 — contando
     como resultado de negócio. */
  const TRES = [
    { contratante_id: 'mostrai', ambiente: 'producao', metodo_pagamento: 'pix', status: 'confirmado',
      valor_cobrado: 100, criado_em: '2026-09-16T10:00:00Z', confirmado_em: '2026-09-16T10:00:00Z' },
    { contratante_id: 'testemaster', ambiente: 'sandbox', metodo_pagamento: 'pix', status: 'confirmado',
      valor_cobrado: 10, criado_em: '2026-09-16T11:00:00Z', confirmado_em: '2026-09-16T11:00:00Z' },
    { contratante_id: 'mostrai', ambiente: 'producao', e_teste: true, metodo_pagamento: 'pix', status: 'confirmado',
      valor_cobrado: 5, criado_em: '2026-09-16T12:00:00Z', confirmado_em: '2026-09-16T12:00:00Z' }
  ];
  r = agregarMetricas(TRES, JANELA);

  conferir(r.hoje.confirmadas === 1, `só a de negócio conta (contou ${r.hoje.confirmadas})`);
  conferir(r.hoje.valorPago === 100, `e só o valor dela (somou ${r.hoje.valorPago})`);
  conferir(r.total.geradas === 1, 'o total também exclui as duas');
  conferir(r.porContratante.testemaster === undefined, 'contratante só de sandbox não aparece na quebra');
  conferir(r.excluidas.sandbox === 1, `relata a de sandbox (relatou ${r.excluidas.sandbox})`);
  conferir(r.excluidas.teste === 1, `e a marcada como teste (relatou ${r.excluidas.teste})`);
  conferir(r.excluidas.total === 2, 'e a soma das duas');

  /* Nada desaparece sem ser contado: o que entrou mais o que foi
     excluído é o que chegou. É a checagem que impede exclusão silenciosa
     de virar dado perdido. */
  conferir(
    r.total.geradas + r.excluidas.total === TRES.length,
    `entrou (${r.total.geradas}) + excluído (${r.excluidas.total}) = recebido (${TRES.length})`
  );

  /* Cobrança de sandbox MARCADA como teste conta uma vez, e conta como
     sandbox — a razão mais forte. Sem a ordem dos ramos, ela contaria
     nas duas e a soma acima quebraria. */
  r = agregarMetricas([{ ...TRES[1], e_teste: true }], JANELA);
  conferir(r.excluidas.total === 1, 'sandbox + teste conta uma exclusão, não duas');
  conferir(r.excluidas.sandbox === 1 && r.excluidas.teste === 0, 'e o motivo registrado é sandbox');

  /* Falha FECHADA: sem ambiente declarado, não conta. É o estado de
     qualquer linha gravada por caminho que não passe pelo
     `cobrancaService` — o default do banco é `sandbox`, e aqui o
     `undefined` também não passa. */
  r = agregarMetricas([{ ...TRES[0], ambiente: undefined }], JANELA);
  conferir(r.hoje.confirmadas === 0, 'cobrança sem ambiente declarado NÃO conta como negócio');
  conferir(r.excluidas.sandbox === 1, 'e é relatada como excluída, não sumida');

  r = agregarMetricas([{ ...TRES[0], ambiente: 'PRODUCAO' }], JANELA);
  conferir(r.hoje.confirmadas === 0, 'e a comparação é exata — "PRODUCAO" não é "producao"');

  /* Lista vazia continua respondendo com zeros e sem exclusão. */
  r = agregarMetricas([], JANELA);
  conferir(r.excluidas.total === 0, 'sem linhas, nada excluído');
  conferir(r.hoje.confirmadas === 0, 'e nada contado');

  /* --- 12. TODA INSERÇÃO GRAVA O AMBIENTE -------------------------
     A conta acima só é certa se as linhas de produção chegarem
     marcadas. Esquecer a coluna numa inserção nova não quebra nada
     visível: o default do banco é `sandbox`, a linha é excluída, e a
     métrica conta para BAIXO — receita que não aparece, sem erro,
     sem log. É o lado "seguro" do erro, e é justamente por isso que
     passa despercebido.

     Varredura de texto-fonte, e não lista escrita à mão: a quarta
     inserção que alguém escrever entra na conta sozinha. */
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const fonteCobranca = readFileSync(join(RAIZ, 'src/services/cobrancaService.js'), 'utf8');

  const insercoes = [...fonteCobranca.matchAll(/from\('cobrancas'\)\s*\.insert\(\{([\s\S]*?)\n  \}\)/g)];
  conferir(insercoes.length >= 3, `controle positivo: achou as inserções em cobrancas (achou ${insercoes.length})`);

  const semAmbiente = insercoes.filter(([, corpo]) => !corpo.includes('ambiente: ambienteAsaas()'));
  conferir(
    semAmbiente.length === 0,
    `inserção em cobrancas sem gravar o ambiente: a linha nasce como sandbox e a métrica a ignora em silêncio (${semAmbiente.length})`
  );

  /* E o ambiente vem da CONFIGURAÇÃO, nunca do corpo da requisição —
     mesma regra do valor cobrado (RN-03): fato do servidor não entra
     de fora. */
  conferir(
    !/ambiente:\s*(dados|corpo|requisicao|req)\./.test(fonteCobranca),
    'o ambiente não é lido do que veio de fora'
  );

  /* --- 13. O QUE O AGREGADOR LÊ, A CONSULTA TRAZ -------------------
     Achado no próprio dia em que o filtro foi escrito: o `select` da
     rota listava colunas uma a uma e não trazia `ambiente` nem
     `e_teste`. Coluna ausente chega `undefined`, `undefined !==
     'producao'` é verdade, e TODA cobrança sairia da conta — em
     silêncio, e dando o número certo por coincidência enquanto tudo é
     sandbox. Depois da troca, a métrica de sucesso do projeto seria
     zero para sempre.

     A regra é geral de propósito: todo campo que o agregador lê de uma
     linha tem de estar na consulta. Assim a próxima coluna esquecida
     cai aqui, não em produção. */
  const fonteEste = readFileSync(join(RAIZ, 'src/services/metricaService.js'), 'utf8');
  /* Só o código de produção deste arquivo: do filtro até o começo do
     autoteste. Sem esse corte, o próprio autoteste entraria na conta.
     Os dois índices são conferidos abaixo — `indexOf` devolve -1 e
     `slice` aceita -1 calado, que é como um corte errado passaria.

     A marca do fim é montada por concatenação de propósito: escrita
     inteira, ela apareceria nesta própria linha, e o `indexOf` acharia
     a si mesmo em vez do cabeçalho do autoteste. Foi o que aconteceu na
     primeira versão, e a sabotagem do corte passou por isso — o erro
     era benigno (o trecho ficava maior, nunca menor), mas uma checagem
     que não pode falhar não é checagem. */
  const inicioConta = fonteEste.indexOf('function eDeNegocio');
  const fimConta = fonteEste.indexOf('Autoteste' + ' —');
  conferir(inicioConta > 0 && fimConta > inicioConta, 'controle positivo: achou o trecho de produção do arquivo');
  const corpoDaConta = fonteEste.slice(inicioConta, fimConta);
  const lidas = [...new Set([...corpoDaConta.matchAll(/\bc\.([a-z_]+)/g)].map((m) => m[1]))].sort();
  conferir(lidas.length >= 5, `controle positivo: achou os campos que o agregador lê (${lidas.length})`);
  conferir(lidas.includes('contratante_id'), 'controle positivo: e um deles é contratante_id');

  const fonteAdmin = readFileSync(join(RAIZ, 'src/controllers/adminController.js'), 'utf8');
  const inicioConsulta = fonteAdmin.indexOf(".from('cobrancas')");
  const consulta = fonteAdmin.slice(inicioConsulta, fonteAdmin.indexOf('.or(', inicioConsulta));
  conferir(consulta.includes('.select('), 'controle positivo: achou o select da métrica no controlador');

  /* Só os literais de texto DEPOIS do `.select(`, nunca o trecho bruto:
     a primeira versão desta checagem varria o trecho inteiro, e o
     comentário que explica as colunas cita `ambiente` e `e_teste` —
     as três sabotagens passaram porque o teste estava lendo o
     comentário como se fosse a consulta. O select é montado por
     concatenação, então são vários literais. */
  const colunasPedidas = [...consulta.slice(consulta.indexOf('.select('))
    .matchAll(/'([^']*)'/g)].map((m) => m[1]).join(', ');
  conferir(
    colunasPedidas.includes('contratante_id'),
    `controle positivo: leu as colunas pedidas do select ("${colunasPedidas.slice(0, 40)}…")`
  );

  const faltando = lidas.filter((coluna) => !colunasPedidas.includes(coluna));
  conferir(
    faltando.length === 0,
    `o agregador lê coluna que a consulta não traz: ${faltando.join(', ')} — ` +
    'chega undefined e a linha sai da conta sem erro'
  );

  console.log(`metricaService: ${checagens} checagens OK`);
}
