/**
 * SAN CHECKOUT v2 — src/services/expurgoService.js
 *
 * A rotina de expurgo de dado pessoal — a Lei 10, e a pendência que
 * `docs/inventario-de-dados.md` §6 registrava com a frase exata:
 * *"o prazo está decidido, mas nada apaga nada hoje. Enquanto não houver
 * a rotina, o prazo é intenção, não prática."*
 *
 * DUAS COISAS DIFERENTES, e por isso duas funções:
 *
 *   1. `expurgarDadoPessoal()` — o PRAZO. Cinco anos contados da
 *      transação (decisão de 11/09/2026, §6), aplicado a tudo que
 *      passou do prazo. Roda no mesmo ciclo de 24 h dos outros dois
 *      expurgos, em `server.js`.
 *
 *   2. `expurgarDadoPessoalDoTitular()` — o PEDIDO (LGPD art. 18).
 *      Atende titular que pede exclusão ANTES do prazo, respeitando a
 *      guarda fiscal: o que ainda está dentro dos cinco anos não é
 *      apagado, e a função DIZ quantas linhas ficaram retidas em vez de
 *      fingir que apagou tudo. Sem isso, a resposta ao titular seria
 *      uma meia-verdade.
 *
 * ANONIMIZA, NÃO APAGA. `docs/inventario-de-dados.md` §6.2 conferiu isso
 * contra a modelagem na Estação 4: em `cobrancas` o dado pessoal está em
 * colunas separadas do registro financeiro, então anular as primeiras
 * mantém a linha servindo de registro fiscal e de conciliação sem
 * identificar ninguém. Apagar a linha perderia a guarda fiscal do mesmo
 * dado que a lei manda guardar.
 *
 * ────────────────────────────────────────────────────────────────────
 * A DECISÃO QUE MANDA NESTE ARQUIVO: LISTA BRANCA.
 *
 * O que está escrito abaixo é o que FICA. Tudo o que não estiver na
 * lista é anonimizado, mesmo que ninguém se lembre de atualizar este
 * arquivo. É a regra do `CONSTRAINTS.md` §2.5, e o motivo é direto:
 * lista negra falha ABERTA. Alguém acrescenta `data_nascimento` a
 * `cobrancas` em 2027, esquece deste arquivo, e uma lista negra deixaria
 * essa coluna intacta para sempre — CPF, ou pior, no banco depois do
 * prazo. A lista branca falha FECHADA: a coluna nova é anonimizada, e o
 * pior caso é perder um número financeiro que o extrato da Asaas e a
 * cópia do banco ainda têm.
 *
 * O autoteste trava as duas listas contra as colunas REAIS do banco, de
 * forma que acrescentar coluna sem decidir de que lado ela fica deixa a
 * suíte vermelha em vez de deixar o dado passar.
 * ────────────────────────────────────────────────────────────────────
 */

import { supabase } from '../config/supabase.js';

/** Cinco anos contados da transação — §6, alinhado ao art. 27 do CDC e
 *  à guarda fiscal usual. Validação jurídica é da Estação 7. */
export const ANOS_DE_RETENCAO = 5;

/**
 * O que FICA em `cobrancas`: o registro financeiro e o técnico. Nada
 * aqui identifica pessoa — é valor, taxa, método, status, data e os ids
 * que ligam a cobrança à Asaas e ao pedido do contratante.
 *
 * `cupom` fica porque é fato comercial (qual promoção foi usada), não
 * atributo de quem comprou. `pedido_id` e `plano_id` ficam porque são a
 * chave de conciliação com o contratante, e sem eles a linha deixa de
 * servir ao propósito que justifica guardá-la.
 */
const FICAM_EM_COBRANCAS = new Set([
  'id', 'charge_id', 'asaas_checkout_id', 'contratante_id',
  'pedido_id', 'plano_id',
  'valor_cheio', 'desconto', 'cupom', 'valor_com_desconto', 'frete',
  'taxa_do_projeto', 'taxa_asaas', 'taxa_propria', 'taxa_isenta', 'valor_cobrado',
  'metodo_pagamento', 'parcelas',
  'nota_fiscal_id', 'nota_fiscal_drive_file_id', 'nota_fiscal_status',
  'status', 'criado_em', 'atualizado_em', 'confirmado_em',
  'asaas_subscription_id', 'substitui_assinatura_id', 'ciclo', 'proxima_cobranca'
]);

/**
 * O que FICA em `assinaturas`. `documento` NÃO fica — mas também não
 * pode virar `null`, porque a coluna é `not null` (ela faz parte da
 * chave de busca `contratante_id + plano_id + documento`). Vira o
 * substituto abaixo, que não identifica ninguém.
 */
const FICAM_EM_ASSINATURAS = new Set([
  'id', 'contratante_id', 'plano_id',
  'valor', 'ciclo', 'status', 'proxima_cobranca', 'criado_em'
]);

/**
 * Colunas `not null` que precisam de um valor no lugar do `null`. O
 * texto é o mesmo para todas as linhas de propósito: agrupar não é
 * problema, porque só assinatura CANCELADA é expurgada e ela já não é
 * buscada por documento.
 */
const SUBSTITUTO_OBRIGATORIO = {
  assinaturas: { documento: 'expurgado' }
};

const LISTA_BRANCA = {
  cobrancas: FICAM_EM_COBRANCAS,
  assinaturas: FICAM_EM_ASSINATURAS
};

export const TABELAS_EXPURGADAS = Object.keys(LISTA_BRANCA);

/** Exposto só para o autoteste conferir as listas contra o banco real. */
export function colunasQueFicam(tabela) {
  return new Set(LISTA_BRANCA[tabela]);
}

/**
 * Monta o `patch` que anonimiza UMA linha, a partir das chaves que ela
 * realmente tem. Pura de propósito: é a regra inteira, e ela é testável
 * sem banco.
 *
 * @param {string} tabela
 * @param {object} linha a linha como veio do banco (`select *`)
 * @returns {object} só os campos a mudar; `{}` quando não há nada a fazer
 */
export function anonimizarLinha(tabela, linha) {
  const ficam = LISTA_BRANCA[tabela];
  if (!ficam) throw new Error(`expurgo: tabela "${tabela}" não tem lista branca declarada.`);

  const substitutos = SUBSTITUTO_OBRIGATORIO[tabela] ?? {};
  const patch = {};

  for (const coluna of Object.keys(linha)) {
    if (ficam.has(coluna)) continue;

    const substituto = Object.hasOwn(substitutos, coluna) ? substitutos[coluna] : null;
    // Já anonimizada numa rodada anterior: não conta como mudança, senão
    // toda rodada seguinte "atualiza" a linha e move `atualizado_em`.
    if (linha[coluna] === substituto) continue;
    patch[coluna] = substituto;
  }

  return patch;
}

/** A data antes da qual a transação já passou do prazo. */
export function dataDeCorte(agora = new Date(), anos = ANOS_DE_RETENCAO) {
  /* Piso duro. Um `anos` errado — variável de ambiente vazia virando 0,
     um typo — apagaria o dado pessoal de TODA cobrança do banco, sem
     volta. O prazo é decisão registrada em documento, não configuração:
     se mudar, muda aqui, com a decisão escrita ao lado. */
  if (!Number.isFinite(anos) || anos < ANOS_DE_RETENCAO) {
    throw new Error(`expurgo: retenção de ${anos} ano(s) é menor que os ${ANOS_DE_RETENCAO} decididos — recusando.`);
  }

  const corte = new Date(agora);
  const diaOriginal = corte.getUTCDate();
  corte.setUTCFullYear(corte.getUTCFullYear() - anos);

  /* 29 DE FEVEREIRO. `setUTCFullYear` não existe em ano não-bissexto, e o
     JavaScript transborda para 1º de março em vez de recusar: rodar em
     29/02/2028 daria corte em 2023-03-01, um dia DEPOIS do certo — e
     corte mais tarde significa apagar dado um dia ANTES de os cinco anos
     completarem. Errar para o lado de apagar cedo é o lado errado num
     prazo que existe por guarda fiscal.

     Voltar para o último dia do mês anterior deixa o corte em 28/02, um
     dia mais cedo: o dado fica retido 24 h a mais, que é o lado seguro. */
  if (corte.getUTCDate() !== diaOriginal) corte.setUTCDate(0);

  return corte;
}

/** Quando o dado de uma transação passa a poder ser expurgado: a data
 *  dela mais os anos de retenção. É o inverso de `dataDeCorte`, e existe
 *  separado porque chamar aquela com anos negativos cai no piso duro
 *  dela — e deve cair. */
export function liberaEm(quando, anos = ANOS_DE_RETENCAO) {
  const data = new Date(quando);
  if (Number.isNaN(data.getTime())) return null;
  data.setUTCFullYear(data.getUTCFullYear() + anos);
  return data.toISOString();
}

/**
 * A data que conta como "a transação" de uma cobrança: quando ela foi
 * confirmada, se foi; senão, quando foi criada.
 *
 * `atualizado_em` NÃO serve, e é o erro fácil: ele muda por qualquer
 * motivo (uma conciliação, um estorno negado), então usá-lo empurraria o
 * prazo para frente a cada toque — o dado pessoal nunca venceria.
 */
export function dataDaTransacao(cobranca) {
  return cobranca.confirmado_em ?? cobranca.criado_em ?? null;
}

/* Quantas linhas por ida ao banco.

   `select('*')` sem limite era o desenho anterior e tinha dois problemas
   que só aparecem em 2031, quando houver o que expurgar: cinco anos de
   cobranças carregadas de uma vez na instância de 512 MiB é caminho de
   OOM; e o PostgREST tem teto próprio de linhas por resposta, então uma
   resposta truncada faria a rotina RELATAR sucesso tendo deixado dado
   pessoal para trás — que é a pior falha possível aqui, porque é
   silenciosa e parece certa.

   500 é folgado para a memória e pequeno o bastante para caber em
   qualquer teto de PostgREST. A paginação é estável porque o filtro é
   por DATA e o expurgo não mexe em data nenhuma: a linha continua
   casando o filtro depois de anonimizada, então o deslocamento não
   escorrega debaixo do laço. */
const LOTE = 500;

/* Teto absoluto de linhas por rodada. Não é limite de volume — é freio de
   laço: se o outro lado ignorar o `range` e devolver sempre um lote
   cheio, sem isto o acumulador cresce até estourar a memória. Duzentas
   mil cobranças numa rodada de 24 h é ordens de grandeza acima de
   qualquer cenário deste projeto, e o que passar disso volta na rodada
   seguinte. */
const TETO_DE_LINHAS = 200_000;

/** Lê uma consulta inteira em lotes, em vez de confiar num `select` sem
 *  limite. `montar` recebe o intervalo e devolve a consulta pronta. */
async function lerEmLotes(montar) {
  const tudo = [];
  for (let inicio = 0; inicio < TETO_DE_LINHAS; inicio += LOTE) {
    const { data, error } = await montar(inicio, inicio + LOTE - 1);
    if (error) return { data: null, error };
    tudo.push(...(data ?? []));
    if (!data || data.length < LOTE) return { data: tudo, error: null };
  }

  /* Chegar aqui é laço, não volume. Um `range` ignorado pelo outro lado
     devolveria LOTE linhas para sempre, e o `tudo` cresceria até estourar
     a memória — o MESMO estouro que a paginação veio evitar, só mais
     devagar. Então a saída é erro, não lista truncada: lista truncada
     faria a rotina relatar sucesso tendo deixado dado pessoal para trás,
     e essa é a falha que não se pode ter aqui. */
  return {
    data: null,
    error: { message: `expurgo: leitura passou de ${TETO_DE_LINHAS} linhas sem terminar — paginação não está avançando.` }
  };
}

async function aplicar(tabela, linhas, { simular }) {
  const relatorio = { tabela, examinadas: linhas.length, anonimizadas: 0, campos: 0, erros: [] };

  for (const linha of linhas) {
    const patch = anonimizarLinha(tabela, linha);
    const campos = Object.keys(patch).length;
    if (campos === 0) continue;

    relatorio.anonimizadas += 1;
    relatorio.campos += campos;
    if (simular) continue;

    const { error } = await supabase.from(tabela).update(patch).eq('id', linha.id);
    if (error) relatorio.erros.push(`${tabela}:${linha.id} — ${error.message}`);
  }

  return relatorio;
}

/**
 * O PRAZO. Anonimiza tudo que passou dos cinco anos.
 *
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.simular=true] `true` (o padrão) só conta e
 *        relata, sem escrever nada. Escrever é irreversível sobre a
 *        tabela do dinheiro, então o padrão é o lado seguro — a mesma
 *        escolha de `scripts/limpar-registros-de-teste.mjs`.
 * @returns {Promise<object[]>} um relatório por tabela
 */
export async function expurgarDadoPessoal({ simular = true } = {}) {
  const corte = dataDeCorte().toISOString();
  const relatorios = [];

  /* Cobranças: o prazo conta de `confirmado_em`, e de `criado_em` quando
     a cobrança nunca confirmou. O filtro pega as duas situações — e a
     segunda metade do `or` exige `confirmado_em` nulo para não deixar
     uma cobrança confirmada RECENTEMENTE, mas criada há muito tempo,
     cair no corte pela data de criação. */
  const { data: cobrancas, error: erroCobrancas } = await lerEmLotes((de, ate) => supabase
    .from('cobrancas')
    .select('*')
    .or(`confirmado_em.lt.${corte},and(confirmado_em.is.null,criado_em.lt.${corte})`)
    .order('id')
    .range(de, ate));

  if (erroCobrancas) {
    console.error('[expurgo.cobrancas]', erroCobrancas.message);
    relatorios.push({ tabela: 'cobrancas', erros: [erroCobrancas.message], examinadas: 0, anonimizadas: 0, campos: 0 });
  } else {
    relatorios.push(await aplicar('cobrancas', cobrancas ?? [], { simular }));
  }

  /* Assinaturas: só as CANCELADAS. Uma assinatura ativa ou pausada
     continua sendo localizada por `contratante_id + plano_id +
     documento` (`API.md` §5.5) — anonimizar o documento dela tiraria do
     assinante a capacidade de cancelar a própria assinatura, que é o
     oposto do que a LGPD quer. §6.2 já registrava isso. */
  const { data: assinaturas, error: erroAssinaturas } = await lerEmLotes((de, ate) => supabase
    .from('assinaturas')
    .select('*')
    .eq('status', 'cancelada')
    .lt('criado_em', corte)
    .order('id')
    .range(de, ate));

  if (erroAssinaturas) {
    console.error('[expurgo.assinaturas]', erroAssinaturas.message);
    relatorios.push({ tabela: 'assinaturas', erros: [erroAssinaturas.message], examinadas: 0, anonimizadas: 0, campos: 0 });
  } else {
    relatorios.push(await aplicar('assinaturas', assinaturas ?? [], { simular }));
  }

  return relatorios;
}

/**
 * O PEDIDO DO TITULAR (LGPD art. 18), antes do prazo.
 *
 * Anonimiza o que já pode ser anonimizado e RELATA o que fica retido
 * pela guarda fiscal — em vez de apagar o que a lei manda guardar, ou de
 * responder "feito" tendo apagado metade. O número de linhas retidas é o
 * que o titular tem direito de saber.
 *
 * @param {string} documento CPF ou CNPJ, com ou sem pontuação
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.simular=true]
 */
export async function expurgarDadoPessoalDoTitular(documento, { simular = true } = {}) {
  const digitos = String(documento ?? '').replace(/\D/g, '');
  if (digitos.length !== 11 && digitos.length !== 14) {
    throw new Error('expurgo do titular: documento tem de ser um CPF (11) ou CNPJ (14) de dígitos.');
  }

  const corte = dataDeCorte().toISOString();
  const relatorios = [];

  /* DESDE 17/09/2026 o `documento` é normalizado para dígitos em toda
     fronteira que o aceita (`normalizarDocumento`), então a forma
     pontuada não entra mais. As duas formas continuam sendo buscadas de
     propósito: uma linha gravada ANTES dessa correção, ou por qualquer
     caminho que venha a escapar dela, ainda pode estar pontuada — e um
     expurgo que deixa linha de fora é pior que um que falha, porque ele
     responde "feito". Custa uma cláusula `in`. */
  const formas = digitos.length === 11
    ? [digitos, digitos.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')]
    : [digitos, digitos.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')];

  const { data: cobrancas, error } = await lerEmLotes((de, ate) => supabase
    .from('cobrancas')
    .select('*')
    .in('documento', formas)
    .order('id')
    .range(de, ate));

  if (error) throw error;

  const vencidas = [];
  const retidas = [];
  for (const cobranca of cobrancas ?? []) {
    const quando = dataDaTransacao(cobranca);
    if (quando && String(quando) < corte) vencidas.push(cobranca);
    else retidas.push(cobranca);
  }

  const relatorioCobrancas = await aplicar('cobrancas', vencidas, { simular });
  relatorioCobrancas.retidasPelaGuardaFiscal = retidas.length;
  /* A data em que a ÚLTIMA linha retida sai da guarda fiscal — é a
     resposta honesta ao titular sobre quando o resto será apagado. */
  relatorioCobrancas.liberamEm = retidas
    .map((c) => dataDaTransacao(c))
    .filter(Boolean)
    .map((d) => liberaEm(d))
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  relatorios.push(relatorioCobrancas);

  /* Assinatura ATIVA ou PAUSADA não é anonimizada: o documento é a chave
     de cancelamento dela. Antes de apagar o dado, a assinatura precisa
     ser cancelada — e quem cancela é o titular, pela rota de sempre.
     Isto é relatado, não decidido aqui: cancelar assinatura de alguém
     por causa de um pedido de exclusão seria tomar por ele uma decisão
     com consequência financeira. */
  const { data: assinaturas, error: erroAss } = await lerEmLotes((de, ate) => supabase
    .from('assinaturas')
    .select('*')
    .in('documento', formas)
    .order('id')
    .range(de, ate));

  if (erroAss) throw erroAss;

  const canceladas = (assinaturas ?? []).filter((a) => a.status === 'cancelada');
  const vivas = (assinaturas ?? []).filter((a) => a.status !== 'cancelada');

  const relatorioAssinaturas = await aplicar('assinaturas', canceladas, { simular });
  relatorioAssinaturas.assinaturasVivas = vivas.map((a) => ({ id: a.id, status: a.status }));
  relatorios.push(relatorioAssinaturas);

  return relatorios;
}

/* ====================================================================
   AUTOTESTE — `node src/services/expurgoService.js`
   Roda junto com os outros em `npm test` (tests/executar.js).

   Não toca banco. O que se testa é a REGRA, e ela é pura: a lista
   branca, o que sobra de uma linha depois de anonimizada, o piso do
   prazo e qual data conta como "a transação".

   As colunas contra as quais as listas são conferidas estão gravadas
   abaixo como um retrato do banco de PRODUÇÃO, lido do
   `information_schema` em 17/09/2026. Uma coluna nova só entra em
   produção por migration, e a migration é o momento de decidir de que
   lado ela fica — a suíte fica vermelha até alguém decidir.
   ==================================================================== */
if (process.argv[1]?.endsWith('expurgoService.js')) {
  const assert = (await import('node:assert/strict')).default;

  let checagens = 0;
  const ok = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };
  const igual = (a, b, mensagem) => { assert.deepEqual(a, b, mensagem); checagens += 1; };

  /* Retrato do `information_schema` de produção em 17/09/2026. */
  const COLUNAS_REAIS = {
    cobrancas: [
      'id', 'charge_id', 'asaas_checkout_id', 'contratante_id', 'pedido_id', 'plano_id',
      'documento', 'itens', 'valor_cheio', 'desconto', 'cupom', 'valor_com_desconto',
      'frete', 'taxa_do_projeto', 'taxa_asaas', 'taxa_propria', 'taxa_isenta',
      'valor_cobrado', 'metodo_pagamento', 'parcelas', 'nota_fiscal_id',
      'nota_fiscal_drive_file_id', 'nota_fiscal_status', 'status', 'criado_em',
      'atualizado_em', 'telefone', 'endereco', 'endereco_numero', 'endereco_complemento',
      'bairro', 'cep', 'cidade', 'uf', 'cidade_ibge', 'email', 'asaas_subscription_id',
      'substitui_assinatura_id', 'ciclo', 'proxima_cobranca', 'confirmado_em'
    ],
    assinaturas: [
      'id', 'contratante_id', 'documento', 'valor', 'ciclo', 'status',
      'proxima_cobranca', 'criado_em', 'plano_id'
    ]
  };

  /* --- 1. AS DUAS LISTAS COBREM O BANCO REAL ---
     A lista branca não pode citar coluna que não existe (erro de
     digitação passaria invisível, e a coluna de verdade seria
     anonimizada) nem deixar coluna real sem decisão. */
  for (const tabela of TABELAS_EXPURGADAS) {
    const reais = new Set(COLUNAS_REAIS[tabela]);
    const ficam = colunasQueFicam(tabela);

    const inventadas = [...ficam].filter((c) => !reais.has(c));
    igual(inventadas, [], `${tabela}: a lista branca cita coluna que não existe no banco: ${inventadas}`);

    // O complemento é o que SAI, e ele tem de ser exatamente o que
    // `docs/inventario-de-dados.md` §6.2 chama de dado pessoal.
    const saem = COLUNAS_REAIS[tabela].filter((c) => !ficam.has(c));
    ok(saem.length > 0, `${tabela}: alguma coluna tem de sair, senão o expurgo não expurga nada`);
  }

  igual(
    COLUNAS_REAIS.cobrancas.filter((c) => !colunasQueFicam('cobrancas').has(c)).sort(),
    ['bairro', 'cep', 'cidade', 'cidade_ibge', 'documento', 'email', 'endereco',
     'endereco_complemento', 'endereco_numero', 'itens', 'telefone', 'uf'].sort(),
    'em cobrancas sai exatamente o dado pessoal de §6.2: documento, e-mail, telefone, os 8 de endereço e os itens'
  );
  igual(
    COLUNAS_REAIS.assinaturas.filter((c) => !colunasQueFicam('assinaturas').has(c)),
    ['documento'],
    'em assinaturas sai só o documento — o resto é valor, ciclo e status'
  );

  /* --- 2. A LISTA BRANCA FALHA FECHADA ---
     É a razão de ser do arquivo: coluna nova, que ninguém declarou,
     tem de SAIR. Uma lista negra deixaria ficar. */
  const comColunaNova = anonimizarLinha('cobrancas', {
    id: 'x', valor_cobrado: 10, status: 'confirmado',
    data_nascimento: '1990-01-01',        // inventada agora, nunca declarada
    nome_social: 'Alguém'                 // idem
  });
  igual(comColunaNova.data_nascimento, null, 'coluna pessoal nova, não declarada, é anonimizada mesmo assim');
  igual(comColunaNova.nome_social, null, 'e a outra também');
  ok(!Object.hasOwn(comColunaNova, 'valor_cobrado'), 'o valor cobrado NÃO é tocado');
  ok(!Object.hasOwn(comColunaNova, 'status'), 'nem o status');
  ok(!Object.hasOwn(comColunaNova, 'id'), 'nem o id');

  /* --- 3. O QUE SOBRA DE UMA LINHA DE VERDADE --- */
  const cobrancaReal = {
    id: '11111111-1111-1111-1111-111111111111',
    charge_id: 'pay_abc', asaas_checkout_id: null, contratante_id: 'testemaster',
    pedido_id: 'ped_completo', plano_id: null,
    documento: '552.085.198-01', email: 'comprador@exemplo.com', telefone: '11987654321',
    endereco: 'Rua das Flores', endereco_numero: '100', endereco_complemento: 'ap 2',
    bairro: 'Centro', cep: '01310100', cidade: 'São Paulo', uf: 'SP', cidade_ibge: 3550308,
    itens: [{ nome: 'Camiseta preta tamanho M', quantidade: 1, valorUnitario: 9.5 }],
    valor_cheio: 9.5, desconto: 0, cupom: 'PRIMEIRA10', valor_com_desconto: 9.5, frete: 0,
    taxa_do_projeto: 0.59, taxa_asaas: 1.99, taxa_propria: 0.59, taxa_isenta: false,
    valor_cobrado: 12.08, metodo_pagamento: 'pix', parcelas: 1,
    nota_fiscal_id: null, nota_fiscal_drive_file_id: null, nota_fiscal_status: 'pendente',
    status: 'confirmado', criado_em: '2021-01-01T00:00:00Z',
    atualizado_em: '2021-01-02T00:00:00Z', confirmado_em: '2021-01-01T10:00:00Z',
    asaas_subscription_id: null, substitui_assinatura_id: null, ciclo: null, proxima_cobranca: null
  };

  const patch = anonimizarLinha('cobrancas', cobrancaReal);
  const depois = { ...cobrancaReal, ...patch };

  const texto = JSON.stringify(depois);
  for (const [rotulo, agulha] of [
    ['CPF', '552'], ['e-mail', 'comprador@exemplo.com'], ['telefone', '11987654321'],
    ['rua', 'Rua das Flores'], ['complemento', 'ap 2'], ['bairro', 'Centro'],
    ['CEP', '01310100'], ['cidade', 'São Paulo'], ['código IBGE', '3550308'],
    ['o que a pessoa comprou', 'Camiseta']
  ]) {
    ok(!texto.includes(agulha), `depois do expurgo, ${rotulo} ainda está na linha: ${agulha}`);
  }
  ok(!texto.includes('"SP"'), 'a UF também sai — com cidade e CEP, ela é parte do endereço');

  igual(depois.valor_cobrado, 12.08, 'o valor cobrado continua');
  igual(depois.taxa_asaas, 1.99, 'a taxa da Asaas continua');
  igual(depois.charge_id, 'pay_abc', 'o id na Asaas continua — é como a linha se reconcilia');
  igual(depois.contratante_id, 'testemaster', 'e o contratante, para a métrica por contratante');
  igual(depois.status, 'confirmado', 'e o status, que é o registro fiscal');
  igual(depois.confirmado_em, '2021-01-01T10:00:00Z', 'e a data da transação');
  igual(depois.cupom, 'PRIMEIRA10', 'o cupom fica: é fato comercial, não atributo de pessoa');

  /* --- 4. IDEMPOTENTE ---
     Rodar de novo numa linha já anonimizada não pode gerar escrita —
     senão toda rodada de 24 h reescreve a tabela inteira e move
     `atualizado_em`, apagando o sinal de "esta linha mudou". */
  igual(anonimizarLinha('cobrancas', depois), {}, 'linha já anonimizada não gera patch nenhum');

  /* --- 5. O SUBSTITUTO DA COLUNA `not null` --- */
  const assinatura = {
    id: 'sub_x', contratante_id: 'testemaster', plano_id: 'plano_anual',
    documento: '552.085.198-01', valor: 267.3, ciclo: 'YEARLY',
    status: 'cancelada', proxima_cobranca: null, criado_em: '2020-01-01T00:00:00Z'
  };
  const patchAss = anonimizarLinha('assinaturas', assinatura);
  igual(patchAss, { documento: 'expurgado' }, 'o documento da assinatura vira texto fixo, não null (a coluna é not null)');
  ok(patchAss.documento !== null, 'e não é null, senão o update quebraria');
  igual(anonimizarLinha('assinaturas', { ...assinatura, ...patchAss }), {}, 'e também é idempotente');

  /* --- 6. O PISO DURO DO PRAZO ---
     Um `anos` errado apagaria o dado pessoal do banco inteiro, sem
     volta. O piso é o que impede isso de ser um typo. */
  assert.throws(() => dataDeCorte(new Date(), 0), /recusando/, 'retenção de 0 ano é recusada');
  checagens += 1;
  assert.throws(() => dataDeCorte(new Date(), 4), /recusando/, 'retenção de 4 anos é recusada');
  checagens += 1;
  assert.throws(() => dataDeCorte(new Date(), Number(undefined)), /recusando/, 'retenção NaN é recusada');
  checagens += 1;
  ok(dataDeCorte(new Date(), 5) instanceof Date, 'os 5 anos decididos passam');
  ok(dataDeCorte(new Date(), 10) instanceof Date, 'mais que o prazo passa (é mais conservador)');

  const corte = dataDeCorte(new Date('2026-09-17T00:00:00Z'));
  igual(corte.toISOString(), '2021-09-17T00:00:00.000Z', 'o corte é exatamente cinco anos antes');

  /* 29 DE FEVEREIRO. `setUTCFullYear` transborda para 1º de março em ano
     não-bissexto, e corte mais TARDE significa apagar dado mais CEDO —
     antes de os cinco anos completarem. O certo aqui é errar para o lado
     de reter 24 h a mais. */
  igual(
    dataDeCorte(new Date('2028-02-29T00:00:00Z')).toISOString(),
    '2023-02-28T00:00:00.000Z',
    '29/02 de ano bissexto não transborda para 1º de março (apagaria um dia cedo)'
  );
  igual(
    dataDeCorte(new Date('2024-02-29T12:00:00Z')).toISOString(),
    '2019-02-28T12:00:00.000Z',
    'e o mesmo com hora no meio do dia'
  );
  ok(
    dataDeCorte(new Date('2028-02-29T00:00:00Z')) < new Date('2023-03-01T00:00:00Z'),
    'o corte de 29/02 fica ANTES do que o transbordo daria — reter a mais é o lado seguro'
  );
  igual(
    dataDeCorte(new Date('2026-03-01T00:00:00Z')).toISOString(),
    '2021-03-01T00:00:00.000Z',
    'e 1º de março, que é dia válido em todo ano, não é mexido'
  );
  igual(
    dataDeCorte(new Date('2026-01-31T00:00:00Z')).toISOString(),
    '2021-01-31T00:00:00.000Z',
    'dia 31 de mês de 31 dias também passa intocado'
  );

  /* O TETO DE LOTE. Ele existe porque `select` sem limite tem dois modos
     de falhar em 2031: OOM na instância de 512 MiB, e resposta truncada
     pelo PostgREST — esta última faria a rotina RELATAR sucesso tendo
     deixado dado pessoal para trás. */
  ok(LOTE > 0 && LOTE <= 1000, `o lote (${LOTE}) cabe em qualquer teto de PostgREST e na memória`);

  const paginas = [];
  const lidas = await lerEmLotes(async (de, ate) => {
    paginas.push([de, ate]);
    const total = 1250;
    const linhas = [];
    for (let i = de; i <= Math.min(ate, total - 1); i += 1) linhas.push({ id: `linha-${i}` });
    return { data: linhas, error: null };
  });
  igual(lidas.data.length, 1250, 'a paginação lê TODAS as linhas, não só a primeira página');
  igual(paginas.length, Math.ceil(1250 / LOTE) + (1250 % LOTE === 0 ? 1 : 0), 'e para assim que uma página vem curta');
  igual(lidas.error, null, 'sem erro no caminho feliz');

  /* O FREIO DE LAÇO. Um `range` ignorado devolveria lote cheio para
     sempre, e sem o teto o acumulador cresce até estourar — o mesmo
     estouro que a paginação veio evitar. */
  const semFim = await lerEmLotes(async (de, ate) => ({
    data: Array.from({ length: ate - de + 1 }, (_, i) => ({ id: `x-${de + i}` })),
    error: null
  }));
  igual(semFim.data, null, 'paginação que não avança NÃO devolve lista parcial');
  ok(/não está avançando/.test(semFim.error.message), 'devolve erro dizendo que o laço não avançou');
  ok(TETO_DE_LINHAS >= 100_000, `o teto (${TETO_DE_LINHAS}) está ordens de grandeza acima de qualquer volume real`);

  const comErro = await lerEmLotes(async () => ({ data: null, error: { message: 'banco fora do ar' } }));
  igual(comErro.data, null, 'erro no meio da paginação NÃO devolve lista parcial');
  ok(comErro.error, 'e devolve o erro — lista parcial silenciosa seria o mesmo bug que a paginação veio consertar');

  /* --- 7. QUAL DATA CONTA COMO "A TRANSAÇÃO" ---
     `atualizado_em` é a resposta errada e é a fácil: ele muda por
     qualquer motivo, então o prazo nunca venceria. */
  igual(
    dataDaTransacao({ confirmado_em: '2021-01-01T00:00:00Z', criado_em: '2020-01-01T00:00:00Z', atualizado_em: '2026-09-17T00:00:00Z' }),
    '2021-01-01T00:00:00Z', 'confirmada: conta a confirmação'
  );
  igual(
    dataDaTransacao({ confirmado_em: null, criado_em: '2020-01-01T00:00:00Z', atualizado_em: '2026-09-17T00:00:00Z' }),
    '2020-01-01T00:00:00Z', 'nunca confirmada: conta a criação'
  );
  igual(dataDaTransacao({}), null, 'sem data nenhuma: null, e o filtro do banco não a alcança');

  igual(liberaEm('2021-09-17T00:00:00Z'), '2026-09-17T00:00:00.000Z', 'a data de liberação é a transação mais cinco anos');
  igual(liberaEm('não é data'), null, 'data inválida não vira data inventada');

  /* --- 8. TABELA SEM LISTA BRANCA É ERRO, NÃO PASSE LIVRE --- */
  assert.throws(() => anonimizarLinha('contratantes', { id: 'x' }), /lista branca/, 'tabela sem lista declarada é recusada');
  checagens += 1;
  igual(TABELAS_EXPURGADAS, ['cobrancas', 'assinaturas'], 'e só estas duas têm lista hoje');

  console.log(`expurgoService: ${checagens} checagens OK`);
}
