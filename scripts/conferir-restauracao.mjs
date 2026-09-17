#!/usr/bin/env node
/**
 * SAN CHECKOUT — scripts/conferir-restauracao.mjs
 *
 * A metade que decide se o ensaio passou. Compara o banco restaurado
 * (local, por psql) com o de produção (pela API de gerência) em cinco
 * níveis. Uma divergência reprova — não existe "passou com ressalva".
 *
 * ── Por que comparar catálogo, e não só contar linhas ────────────────
 * Contar linhas prova que os dados voltaram. NÃO prova que voltaram no
 * lugar certo: uma coluna que existe na produção e não nas migrations
 * restaura ausente, e o INSERT simplesmente não a menciona — sem erro
 * nenhum, com contagem batendo. É o modo de falha da lição nº 22
 * (`CONSTRAINTS.md` §2.1: coluna acrescentada depois da primeira ida a
 * produção).
 *
 * E como o schema restaurado VEM das migrations, esta conferência é o
 * único lugar do projeto que prova que `supabase/migrations/` ainda
 * descreve o que está no ar. Um `pg_dump` nunca provaria isso: ele
 * copiaria a divergência junto e restauraria idêntico.
 *
 * Só lê metadado e contagem — nenhum valor de linha atravessa daqui.
 */

import { execFileSync } from 'node:child_process';

const PROJETO = process.env.SUPABASE_PROJECT_REF ?? 'zacuaroarelaqnzjjlcz';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

async function producao(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJETO}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  if (!r.ok) throw new Error(`produção: ${r.status} ${JSON.stringify(await r.json()).slice(0, 300)}`);
  return r.json();
}

function local(query) {
  const saida = execFileSync('psql', [
    '-t', '-A', '-X', '-v', 'ON_ERROR_STOP=1',
    '-c', `select coalesce(json_agg(x), '[]'::json) from (${query.replace(/;\s*$/, '')}) x`
  ], { encoding: 'utf8' });
  return JSON.parse(saida.trim());
}

/* Cada consulta devolve uma coluna `chave` que identifica o item, e o
   resto é o que tem de ser igual. Rodam idênticas nos dois lados. */
const CONSULTAS = {
  colunas: `
    select table_name||'.'||column_name as chave, data_type, is_nullable, column_default
    from information_schema.columns where table_schema='public' order by 1`,

  restricoes: `
    select tc.table_name||'.'||tc.constraint_type||'.'||
           coalesce((select string_agg(kcu.column_name, ',' order by kcu.ordinal_position)
                     from information_schema.key_column_usage kcu
                     where kcu.constraint_name=tc.constraint_name and kcu.table_schema='public'), '-') as chave
    from information_schema.table_constraints tc
    where tc.table_schema='public' and tc.constraint_type in ('PRIMARY KEY','UNIQUE','FOREIGN KEY')
    order by 1`,

  indices: `
    select tablename||'.'||indexname as chave, indexdef
    from pg_indexes where schemaname='public' order by 1`,

  rls: `
    select relname as chave, relrowsecurity::text as rls
    from pg_class where relnamespace='public'::regnamespace and relkind='r' order by 1`,

  contagens: `
    select table_name as chave,
           (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name),
                                                false, true, '')))[1]::text as linhas
    from information_schema.tables
    where table_schema='public' and table_type='BASE TABLE' order by 1`
};

let reprovas = 0;

for (const [nome, consulta] of Object.entries(CONSULTAS)) {
  const [aqui, la] = [local(consulta), await producao(consulta)];
  const mapa = (linhas) => new Map(linhas.map((l) => [l.chave, JSON.stringify(l)]));
  const [mAqui, mLa] = [mapa(aqui), mapa(la)];

  const divergencias = [];
  for (const [chave, valor] of mLa) {
    if (!mAqui.has(chave)) divergencias.push(`SÓ NA PRODUÇÃO: ${chave}`);
    else if (mAqui.get(chave) !== valor) {
      divergencias.push(`DIFERENTE: ${chave}\n        produção:   ${valor}\n        restaurado: ${mAqui.get(chave)}`);
    }
  }
  for (const chave of mAqui.keys()) {
    if (!mLa.has(chave)) divergencias.push(`SÓ NO RESTAURADO: ${chave}`);
  }

  reprovas += divergencias.length;
  console.log(`  ${divergencias.length ? '✗' : '✓'} ${nome}: ${mLa.size} itens, ${divergencias.length} divergência(s)`);
  for (const d of divergencias) console.log(`      ${d}`);
}

/* RPO: idade do dado mais recente — quanto de história se perderia numa
   restauração.

   Varre TODA coluna de timestamp do schema em vez de olhar uma tabela
   escolhida a dedo. A primeira versão olhava `webhook_eventos.criado_em`,
   que não existe (a coluna é `recebido_em`): nome fixo de coluna num
   script de emergência é exatamente o que quebra no dia de restaurar.

   `where v <= now()` não é detalhe: `proxima_cobranca` é uma data FUTURA,
   e sem o filtro ela viraria o "dado mais recente" e o RPO daria negativo. */
const idade = `
  select coalesce(extract(epoch from (now() - max(v)))::int::text, 'sem dado') as v from (
    select (xpath('/row/c/text()',
                  query_to_xml(format('select max(%I)::text as c from public.%I', column_name, table_name),
                               false, true, '')))[1]::text::timestamptz as v
    from information_schema.columns
    where table_schema='public' and data_type like 'timestamp%'
  ) t where v <= now()`;
const [{ v: rpoProd }] = await producao(idade);
const [{ v: rpoLocal }] = local(idade);

const horas = (s) => (Number(s) / 3600).toFixed(1);

console.log('');
console.log(`RTO medido: ${process.env.RTO_SEGUNDOS ?? '?'}s — do zero ao banco de pé com os dados.`);
console.log(`            É o tempo de MÁQUINA. O relógio real de um incidente começa antes,`);
console.log(`            em perceber que caiu, e isso depende do alerta externo.`);
console.log('');
/* O RPO não sai deste ensaio, e dizer que sai seria mentir num documento
   que alguém vai ler às duas da manhã.

   RPO é quanto de história se perde, e isso é o INTERVALO ENTRE BACKUPS:
   tudo que foi escrito depois da última cópia morre junto. Aqui o despejo
   é gerado na hora, do banco vivo — uma cópia viva não é backup, e medir
   "idade do dado" nela só diz que não houve tráfego recente, não que não
   se perderia nada.

   Enquanto não existir job automático de cópia, o RPO é INDEFINIDO: no
   pior caso, tudo. */
console.log(`RPO: NÃO medido por este ensaio — e não é omissão, é o que é.`);
console.log(`     RPO é o intervalo entre backups, e não existe job de backup automático`);
console.log(`     ainda (CONSTRAINTS.md §3, exceção da Lei 6). Enquanto não existir,`);
console.log(`     o RPO é indefinido: no pior caso, perde-se tudo desde sempre.`);
console.log(`     O despejo deste ensaio sai do banco vivo, na hora — é cópia, não backup.`);
console.log('');
console.log(`Contexto: o dado mais recente da produção tem ${horas(rpoProd)}h`);
console.log(`          (${horas(rpoLocal)}h no restaurado). Isso mede TRÁFEGO, não backup.`);
console.log('');
console.log(reprovas === 0
  ? 'ENSAIO PASSOU — schema e contagens do restaurado batem com a produção.'
  : `ENSAIO REPROVOU — ${reprovas} divergência(s) acima.`);

process.exit(reprovas === 0 ? 0 : 1);
