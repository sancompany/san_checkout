#!/usr/bin/env node
/**
 * SAN CHECKOUT — scripts/backup-dados.mjs
 *
 * Exporta os DADOS do banco como SQL executável.
 *
 * ── O padrão é ANONIMIZADO, e isso é decisão de desenho ──────────────
 * Sem `--com-dado-real`, todo campo pessoal sai mascarado, e o mascaramento
 * acontece DENTRO do Postgres: o CPF, o e-mail e a `api_key` verdadeiros
 * nunca trafegam nem tocam disco fora do banco.
 *
 * O caminho seguro é o padrão de propósito. A primeira versão deste
 * script puxava o dado real para o disco da sessão, e foi barrada antes
 * de rodar — corretamente. Este projeto é "dado de terceiro, com
 * dinheiro" (Lei 0, topo da escala): puxar base de produção para máquina
 * de desenvolvimento é a prática que a classificação existe para impedir,
 * e um ensaio de restauração não precisa do CPF certo para provar o que
 * precisa provar.
 *
 * ── O que o despejo anonimizado ainda prova ──────────────────────────
 * Tudo que quebra um restore de verdade: contagem de linhas, tipo de cada
 * coluna, NOT NULL, chave estrangeira, unicidade, array, timestamp. O que
 * ele NÃO prova é o byte exato de um CPF — que não é onde restore falha.
 * O backup de verdade (`--com-dado-real`) roda em ambiente confiável, e o
 * que se ensaia aqui é o MECANISMO. Está dito assim no `RUNBOOK.md §6`.
 *
 * ── Por que não é `pg_dump` ──────────────────────────────────────────
 * `pg_dump` exige a senha do Postgres, que não é a `SUPABASE_SERVICE_KEY`
 * (a aplicação fala por PostgREST, não por conexão direta) e não está
 * neste ambiente. O que existe é o token de gerência, que roda SQL.
 *
 * ── Onde mora o schema ───────────────────────────────────────────────
 * Em `supabase/migrations/`, versionado e imutável (`CONSTRAINTS.md`
 * §2.1). Restaurar é aplicar as migrations e carregar este arquivo — e o
 * ensaio compara o catálogo do restaurado com o da produção, coluna a
 * coluna. Se as migrations divergirem do que está no ar, o ensaio acusa.
 * Um `pg_dump` nunca acusaria: ele copiaria a divergência junto.
 *
 * Uso:  node scripts/backup-dados.mjs [destino.sql] [--com-dado-real]
 */

const PROJETO = process.env.SUPABASE_PROJECT_REF ?? 'zacuaroarelaqnzjjlcz';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const COM_DADO_REAL = process.argv.includes('--com-dado-real');

if (!TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN ausente — sem ele não há como ler o banco.');
  process.exit(1);
}

/**
 * Campos mascarados, por NOME de coluna e não por lista fixa de
 * (tabela, coluna): coluna pessoal nova nasce mascarada sem ninguém
 * lembrar de vir aqui. Errar para o lado de mascarar demais é barato;
 * para o lado de vazar, não.
 *
 * Fonte do que conta como pessoal: `docs/inventario-de-dados.md`.
 */
const PESSOAL = /^(documento|cpf|cnpj|email|telefone|celular|nome|endereco.*|complemento|bairro|cidade|estado|cep|tipo_empresa|data_nascimento|faturamento|link_ativacao)$/i;
const CREDENCIAL = /^(api_key|token|senha|hash|secret)$/i;
const ENDERECO_DE_REDE = /^(api_base_url|webhook_url)$/i;

/** Máscara determinística: a mesma entrada vira sempre a mesma saída, então
 *  junção por documento continua batendo e a unicidade se preserva. NULL
 *  continua NULL, senão NOT NULL e "campo opcional vazio" mudam de sentido. */
function mascarar(coluna, tipo) {
  const c = `"${coluna}"`;
  if (COM_DADO_REAL) return `${c}::text`;

  const ehTexto = /char|text/.test(tipo);

  // Coluna pessoal que NÃO é texto (data de nascimento, faturamento) vira
  // um valor neutro do mesmo tipo. Não dá para "mascarar preservando o
  // formato" uma data sem inventar semântica, e o ensaio não precisa
  // disso: o que ele confere nessas colunas é tipo e nulidade.
  if (!ehTexto && PESSOAL.test(coluna)) {
    if (/date|timestamp/.test(tipo)) return `case when ${c} is null then null else '2000-01-01'::date::text end`;
    if (/numeric|int|real|double/.test(tipo)) return `case when ${c} is null then null else '0' end`;
    return `${c}::text`;
  }

  // O resto que não é texto passa inteiro: número, data e booleano não
  // identificam ninguém sozinhos, e são justamente o que o ensaio precisa
  // comparar de verdade.
  if (!ehTexto) return `${c}::text`;

  if (CREDENCIAL.test(coluna)) return `case when ${c} is null then null else 'anon'||substr(md5(${c}),1,44) end`;
  if (ENDERECO_DE_REDE.test(coluna)) return `case when ${c} is null then null else 'https://anon-'||substr(md5(${c}),1,8)||'.invalid' end`;
  if (!PESSOAL.test(coluna)) return `${c}::text`;

  if (/^email$/i.test(coluna)) return `case when ${c} is null then null else 'anon-'||substr(md5(${c}),1,8)||'@exemplo.invalid' end`;
  // documento/telefone/cep são só dígitos, e o comprimento importa (CPF de
  // 11 e CNPJ de 14 são tratados diferente): mantém o tamanho original.
  if (/^(documento|cpf|cnpj|telefone|cep)$/i.test(coluna)) {
    return `case when ${c} is null then null else lpad(('x'||substr(md5(${c}),1,8))::bit(32)::bigint::text, length(${c}), '0') end`;
  }
  return `case when ${c} is null then null else 'anon-'||substr(md5(${c}),1,10) end`;
}

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJETO}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const corpo = await r.json();
  if (!r.ok) throw new Error(`SQL falhou (${r.status}): ${JSON.stringify(corpo).slice(0, 400)}`);
  return corpo;
}

const literal = (t) => `'${String(t).replace(/'/g, "''")}'`;

/** Tabelas de `public`, em ordem de dependência: quem é apontado sai antes
 *  de quem aponta, senão o INSERT bate na chave estrangeira. */
async function tabelasEmOrdem() {
  const tabelas = (await sql(`
    select table_name from information_schema.tables
    where table_schema='public' and table_type='BASE TABLE' order by table_name
  `)).map((t) => t.table_name);

  const arestas = await sql(`
    select distinct tc.table_name as filho, ccu.table_name as pai
    from information_schema.table_constraints tc
    join information_schema.constraint_column_usage ccu
      on ccu.constraint_name=tc.constraint_name and ccu.table_schema=tc.table_schema
    where tc.constraint_type='FOREIGN KEY' and tc.table_schema='public'
  `);

  const ordenadas = [];
  const pendentes = new Set(tabelas);
  while (pendentes.size) {
    // Auto-referência não conta como dependência: a linha que aponta para
    // si mesma entra no mesmo lote.
    const prontas = [...pendentes].filter((t) =>
      arestas.every((a) => a.filho !== t || a.pai === t || !pendentes.has(a.pai))
    );
    // Ciclo entre tabelas: despeja o resto e deixa o ensaio reprovar alto,
    // em vez de gerar arquivo que só quebra na hora de restaurar de verdade.
    if (!prontas.length) { ordenadas.push(...pendentes); break; }
    for (const t of prontas) { ordenadas.push(t); pendentes.delete(t); }
  }
  return ordenadas;
}

async function despejarTabela(tabela) {
  const colunas = await sql(`
    select column_name, data_type from information_schema.columns
    where table_schema='public' and table_name=${literal(tabela)} order by ordinal_position
  `);
  if (!colunas.length) return { linhas: 0, sql: '', mascaradas: [] };

  const lista = colunas.map((c) => `"${c.column_name}"`).join(', ');
  // quote_nullable devolve o literal já escapado, e o Postgres recoage
  // para o tipo da coluna no INSERT — isso atravessa array, timestamp,
  // numeric e json sem tratamento especial, e sem montar literal em
  // JavaScript, que é onde escape quebra.
  const valores = colunas
    .map((c) => `quote_nullable(${mascarar(c.column_name, c.data_type)})`)
    .join(", ', ', ");

  const linhas = await sql(`
    select 'INSERT INTO public."${tabela}" (${lista}) VALUES (' || concat_ws('', ${valores}) || ');' as linha
    from public."${tabela}"
  `);

  const mascaradas = colunas
    .filter((c) => mascarar(c.column_name, c.data_type) !== `"${c.column_name}"::text`)
    .map((c) => `${tabela}.${c.column_name}`);

  return {
    linhas: linhas.length,
    mascaradas,
    sql: linhas.length
      ? `-- ${tabela} (${linhas.length} linhas)\n${linhas.map((l) => l.linha).join('\n')}\n\n`
      : `-- ${tabela} (vazia)\n\n`
  };
}

const destino = process.argv.find((a, i) => i >= 2 && !a.startsWith('--'))
  ?? `backup-dados-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`;

const tabelas = await tabelasEmOrdem();

let saida = `-- SAN CHECKOUT — despejo lógico dos dados\n`;
saida += `-- gerado em ${new Date().toISOString()} · projeto ${PROJETO}\n`;
saida += `-- ${COM_DADO_REAL ? '⚠️ COM DADO REAL — contém dado pessoal. Não commitar, não sair de ambiente confiável.' : 'ANONIMIZADO — campos pessoais mascarados no banco, antes de sair de lá.'}\n`;
saida += `-- schema NÃO está aqui: aplique supabase/migrations/ antes.\n\n`;
saida += `BEGIN;\n\n`;

const contagem = {};
const mascaradas = [];
for (const tabela of tabelas) {
  const r = await despejarTabela(tabela);
  contagem[tabela] = r.linhas;
  mascaradas.push(...r.mascaradas);
  saida += r.sql;
}
saida += `COMMIT;\n`;

(await import('node:fs')).writeFileSync(destino, saida);

console.log(JSON.stringify({
  destino,
  modo: COM_DADO_REAL ? 'DADO REAL' : 'anonimizado',
  ordem: tabelas,
  linhas: contagem,
  colunasMascaradas: mascaradas
}, null, 1));
