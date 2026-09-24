#!/usr/bin/env node
/**
 * SAN CHECKOUT — scripts/limpar-registros-de-teste.mjs
 *
 * Apaga os registros operacionais criados no SANDBOX — cobrança,
 * assinatura, filas, cotações, clientes da Asaas, diagnósticos — e
 * preserva o cadastro (`contratantes`, `subcontas`) e todo dado que não
 * seja de sandbox.
 *
 * ── Por que isto existe ─────────────────────────────────────────────
 * Todo identificador da Asaas é preso ao ambiente (`API.md §11.1`).
 * Assinatura de sandbox que sobrevive no nosso registro depois da troca
 * vira **zumbi**: `POST /cancelar-assinatura` chama a Asaas de produção
 * com um `sub_…` de sandbox, leva 404, e o registro fica `ativa` para
 * sempre, incancelável pela API.
 *
 * ── O que é "de sandbox": o corte `--ate` ───────────────────────────
 * Só duas tabelas carregam o ambiente na linha: `cobrancas.ambiente`
 * (0009, RN-33) e `clientes_asaas.ambiente` (0015). As outras oito
 * não têm a coluna — e é nelas que a versão anterior deste script
 * errava por omissão: ela foi escrita antes das migrations 0011 e 0015
 * e não conhecia `intencoes_troca_plano`, `webhook_inbox`,
 * `outbox_notificacoes`, `cotacoes` nem `clientes_asaas`.
 *
 * Para as tabelas sem a coluna, "de sandbox" é **o que foi gravado antes
 * de o processo de produção subir**: até esse instante, todo processo
 * que escreveu no banco rodava com `ASAAS_AMBIENTE=sandbox`. O instante
 * é medido, não lembrado — é a hora de início do PID 1 do contêiner que
 * subiu com as variáveis de produção:
 *
 *   northflank exec service --project san-checkout --service san-checkout \
 *     --cmd "stat -c %y /proc/1"
 *
 * e entra por `--ate=<ISO 8601>`, obrigatório em qualquer modo. Não há
 * padrão "agora" de propósito: depois da troca, "agora" incluiria linha
 * de produção nas tabelas que não têm como denunciar a si mesmas.
 * Corte cedo demais só deixa sobra (a simulação mostra); corte tarde
 * demais apaga dado real — por isso as travas abaixo.
 *
 * ── Travas (conferidas na simulação E dentro da transação) ──────────
 *  1. toda tabela de `public` precisa estar classificada aqui, como alvo
 *     ou como preservada; tabela nova sem classificação recusa tudo —
 *     é assim que a próxima migration não repete o esquecimento da 0011;
 *  2. cobrança dentro do conjunto com `ambiente` diferente de `sandbox`
 *     aborta (inclusive `null`);
 *  3. cliente da Asaas marcado `producao` gravado antes do corte aborta —
 *     prova de que o corte está tarde demais;
 *  4. assinatura ou cotação dentro do conjunto referida por cobrança
 *     FORA dele aborta (o registro teria atividade real);
 *  5. intenção de troca fora do conjunto apontando para assinatura
 *     dentro dele aborta (a FK também barraria, mas com mensagem pior);
 *  6. corte no futuro é recusado;
 *  7. depois dos `delete`, ainda dentro da transação: a contagem de
 *     `contratantes` e de `subcontas` é a mesma de antes, e `testemaster`
 *     e `mostrai` continuam existindo. Qualquer falha desfaz tudo.
 *
 * ── O padrão é NÃO apagar ───────────────────────────────────────────
 * Sem `--apagar --confirmo-que-e-sandbox`, só mostra. Com as duas, apaga
 * tudo numa transação única: ou apaga o conjunto inteiro, ou nada.
 *
 * Uso:  npm run limpar-teste -- --ate=2026-09-24T23:28:57Z
 *       npm run limpar-teste -- --ate=2026-09-24T23:28:57Z --apagar --confirmo-que-e-sandbox
 */

const PROJETO = process.env.SUPABASE_PROJECT_REF ?? 'zacuaroarelaqnzjjlcz';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const APAGAR = process.argv.includes('--apagar');
const CONFIRMOU_SANDBOX = process.argv.includes('--confirmo-que-e-sandbox');
const ARG_ATE = process.argv.find((a) => a.startsWith('--ate='))?.slice('--ate='.length);

if (!TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN ausente.');
  process.exit(1);
}

/* O corte vira literal SQL; por isso só passa o formato estrito, e o que
   entra na consulta é a reserialização do Date, não o texto recebido. */
if (!ARG_ATE || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(ARG_ATE) || Number.isNaN(Date.parse(ARG_ATE))) {
  console.error('--ate=<ISO 8601 em UTC, ex.: 2026-09-24T23:28:57Z> é obrigatório.');
  console.error('É o instante em que o processo de produção subiu (ver cabeçalho do script).');
  process.exit(1);
}
const CORTE_ISO = new Date(ARG_ATE).toISOString();
if (Date.parse(CORTE_ISO) > Date.now()) {
  console.error(`--ate=${CORTE_ISO} está no futuro — recusado.`);
  process.exit(1);
}
const T = `'${CORTE_ISO}'::timestamptz`;

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

/* Cadastro e configuração: nunca aparecem num `delete`. */
const PRESERVADAS = ['contratantes', 'subcontas'];
const CONTRATANTES_OBRIGATORIOS = ['testemaster', 'mostrai'];

/* Na ordem de exclusão: quem aponta antes de quem é apontado
   (`intencoes_troca_plano.assinatura_id` → `assinaturas` é FK de verdade;
   `cobrancas.cotacao_id` → `cotacoes` e `cobrancas.asaas_subscription_id`
   → `assinaturas` são referências sem FK, mas a ordem é a mesma). */
const ALVOS = [
  { tabela: 'intencoes_troca_plano', onde: `criada_em < ${T}` },
  { tabela: 'outbox_notificacoes', onde: `criado_em < ${T}` },
  { tabela: 'webhook_inbox', onde: `recebido_em < ${T}` },
  { tabela: 'webhook_eventos', onde: `recebido_em < ${T}` },
  { tabela: 'cobrancas', onde: `criado_em < ${T}` },
  { tabela: 'assinaturas', onde: `criado_em < ${T}` },
  { tabela: 'cotacoes', onde: `criado_em < ${T}` },
  // O ambiente está na linha: cliente de sandbox não serve em produção,
  // seja de quando for; cliente de produção nunca entra.
  { tabela: 'clientes_asaas', onde: `ambiente = 'sandbox'` },
  // Balde por hora: só os que fecharam inteiros antes do corte.
  { tabela: 'webhook_rejeicoes', onde: `hora < date_trunc('hour', ${T})` },
  // Agregado por impressão digital: só o que nunca ocorreu depois do corte.
  { tabela: 'erros', onde: `ultima_vez < ${T}` }
];
const onde = Object.fromEntries(ALVOS.map((a) => [a.tabela, a.onde]));

/* Cada trava é uma consulta que precisa contar ZERO. */
const TRAVAS = [
  {
    nome: 'cobranca_nao_sandbox_no_conjunto',
    texto: 'cobrança dentro do conjunto com ambiente diferente de sandbox',
    sql: `select 1 from public.cobrancas where (${onde.cobrancas}) and ambiente is distinct from 'sandbox'`
  },
  {
    nome: 'cliente_producao_antes_do_corte',
    texto: 'cliente Asaas de produção gravado antes do corte (corte tarde demais)',
    sql: `select 1 from public.clientes_asaas where ambiente = 'producao' and criado_em < ${T}`
  },
  {
    nome: 'assinatura_com_cobranca_fora_do_conjunto',
    texto: 'assinatura a apagar referida por cobrança que fica',
    sql: `select 1 from public.assinaturas a join public.cobrancas c
            on c.asaas_subscription_id = a.id or c.substitui_assinatura_id = a.id
          where (${onde.assinaturas.replace(/criado_em/g, 'a.criado_em')})
            and not (${onde.cobrancas.replace(/criado_em/g, 'c.criado_em')})`
  },
  {
    nome: 'cotacao_com_cobranca_fora_do_conjunto',
    texto: 'cotação a apagar referida por cobrança que fica',
    sql: `select 1 from public.cotacoes q join public.cobrancas c on c.cotacao_id = q.id
          where (${onde.cotacoes.replace(/criado_em/g, 'q.criado_em')})
            and not (${onde.cobrancas.replace(/criado_em/g, 'c.criado_em')})`
  },
  {
    nome: 'intencao_fora_do_conjunto_em_assinatura_do_conjunto',
    texto: 'intenção de troca que fica apontando para assinatura a apagar',
    sql: `select 1 from public.intencoes_troca_plano i join public.assinaturas a on a.id = i.assinatura_id
          where (${onde.assinaturas.replace(/criado_em/g, 'a.criado_em')})
            and not (${onde.intencoes_troca_plano.replace(/criada_em/g, 'i.criada_em')})`
  }
];

console.log(`corte (--ate): ${CORTE_ISO}  — linhas anteriores são do processo em sandbox\n`);

/* Trava 1: nenhuma tabela sem classificação. */
const tabelas = (await sql(`
  select table_name from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)).map((l) => l.table_name);
const classificadas = new Set([...PRESERVADAS, ...ALVOS.map((a) => a.tabela)]);
const semClassificacao = tabelas.filter((t) => !classificadas.has(t));
const sumidas = [...classificadas].filter((t) => !tabelas.includes(t));
if (semClassificacao.length || sumidas.length) {
  console.error('--- RECUSADO: o script não conhece o banco inteiro ---');
  if (semClassificacao.length) console.error(`  tabelas sem classificação: ${semClassificacao.join(', ')}`);
  if (sumidas.length) console.error(`  tabelas classificadas que não existem mais: ${sumidas.join(', ')}`);
  console.error('Classifique cada uma em ALVOS ou PRESERVADAS antes de rodar.');
  process.exit(1);
}

const contagem = await sql(ALVOS.map((a, i) => `
  select ${i} as ordem, '${a.tabela}' as tabela,
         count(*) filter (where ${a.onde}) as apagar,
         count(*) filter (where not (${a.onde})) as fica
  from public.${a.tabela}`).join(' union all ') + ' order by ordem');

console.log('=== o que seria apagado, por tabela ===');
console.log(`  ${'tabela'.padEnd(24)} ${'apaga'.padStart(6)} ${'fica'.padStart(6)}`);
let totalApagar = 0;
for (const c of contagem) {
  totalApagar += Number(c.apagar);
  console.log(`  ${c.tabela.padEnd(24)} ${String(c.apagar).padStart(6)} ${String(c.fica).padStart(6)}`);
}
console.log(`  ${'TOTAL'.padEnd(24)} ${String(totalApagar).padStart(6)}`);

const cadastro = await sql(`
  select 'contratantes' as tabela, count(*) as linhas, string_agg(id, ', ' order by id) as ids from public.contratantes
  union all select 'subcontas', count(*), null from public.subcontas`);
console.log('\n=== preservado integralmente (nenhum delete toca) ===');
for (const c of cadastro) console.log(`  ${c.tabela.padEnd(24)} ${c.linhas}${c.ids ? `  (${c.ids})` : ''}`);
const idsContratantes = (cadastro.find((c) => c.tabela === 'contratantes')?.ids ?? '').split(', ');
const faltando = CONTRATANTES_OBRIGATORIOS.filter((id) => !idsContratantes.includes(id));
if (faltando.length) {
  console.error(`\n--- RECUSADO: contratante obrigatório ausente ANTES da limpeza: ${faltando.join(', ')} ---`);
  process.exit(1);
}

const porAmbiente = await sql(`
  select 'cobrancas' as tabela, ambiente, count(*) filter (where ${onde.cobrancas}) as apagar, count(*) filter (where not (${onde.cobrancas})) as fica
  from public.cobrancas group by 2
  union all
  select 'clientes_asaas', ambiente, count(*) filter (where ${onde.clientes_asaas}), count(*) filter (where not (${onde.clientes_asaas}))
  from public.clientes_asaas group by 2 order by 1, 2`);
console.log('\n=== por ambiente, nas tabelas que marcam a origem ===');
if (!porAmbiente.length) console.log('  (nenhuma linha)');
for (const a of porAmbiente) console.log(`  ${a.tabela.padEnd(16)} ${String(a.ambiente).padEnd(9)} apaga=${a.apagar} fica=${a.fica}`);

const assinaturas = await sql(`
  select id, contratante_id, plano_id, status, ciclo from public.assinaturas
  where ${onde.assinaturas} order by criado_em desc`);
if (assinaturas.length) {
  console.log('\n=== assinaturas que deixam de existir (as que virariam zumbi) ===');
  for (const a of assinaturas) console.log(`  ${a.id}  ${a.contratante_id}/${a.plano_id}  ${a.status} ${a.ciclo}`);
}

const travas = await sql(TRAVAS.map((t) => `select '${t.nome}' as nome, count(*) as n from (${t.sql}) x`).join(' union all '));
console.log('\n=== travas (todas precisam dar 0) ===');
let violadas = 0;
for (const t of travas) {
  const def = TRAVAS.find((x) => x.nome === t.nome);
  if (Number(t.n) > 0) violadas += 1;
  console.log(`  ${Number(t.n) === 0 ? 'ok   ' : 'FALHA'} ${String(t.n).padStart(4)}  ${def.texto}`);
}
if (violadas) {
  console.error('\n--- RECUSADO: há dado que não é de sandbox dentro do conjunto (ou o corte está errado) ---');
  process.exit(1);
}

if (!APAGAR) {
  console.log('\n--- SIMULAÇÃO: NADA FOI APAGADO ---');
  console.log('Para apagar de verdade (uma transação só):');
  console.log(`  npm run limpar-teste -- --ate=${CORTE_ISO} --apagar --confirmo-que-e-sandbox`);
  process.exit(0);
}
if (!CONFIRMOU_SANDBOX) {
  console.error('\n--- RECUSADO ---');
  console.error('Apagar histórico de cobrança não tem volta. Confira a lista acima e confirme:');
  console.error(`  npm run limpar-teste -- --ate=${CORTE_ISO} --apagar --confirmo-que-e-sandbox`);
  process.exit(1);
}

/* A transação. As travas rodam de novo aqui dentro, depois do `lock`, e
   não só na simulação: entre a simulação e este ponto o serviço no ar
   pode ter gravado. O `lock` barra escrita (não leitura) nas tabelas
   envolvidas pelo tempo da transação; `lock_timeout` impede que ela
   fique pendurada atrás de uma escrita longa. Qualquer `raise` desfaz
   tudo — inclusive os `delete` que já rodaram. */
const todas = [...ALVOS.map((a) => a.tabela), ...PRESERVADAS].map((t) => `public.${t}`).join(', ');
const transacao = `
begin;
set local lock_timeout = '5s';
create temp table _limpeza (ordem int, tabela text, apagadas bigint) on commit drop;
do $limpeza$
declare
  n bigint;
  contratantes_antes bigint;
  subcontas_antes bigint;
begin
  lock table ${todas} in share row exclusive mode;

${TRAVAS.map((t) => `  select count(*) into n from (${t.sql}) x;
  if n > 0 then raise exception 'TRAVA ${t.nome}: % linha(s) — nada foi apagado', n; end if;`).join('\n')}

  select count(*) into contratantes_antes from public.contratantes;
  select count(*) into subcontas_antes from public.subcontas;

${ALVOS.map((a, i) => `  delete from public.${a.tabela} where ${a.onde};
  get diagnostics n = row_count;
  insert into _limpeza values (${i}, '${a.tabela}', n);`).join('\n')}

  if (select count(*) from public.contratantes) <> contratantes_antes then
    raise exception 'TRAVA contratantes: contagem mudou — desfeito';
  end if;
  if (select count(*) from public.subcontas) <> subcontas_antes then
    raise exception 'TRAVA subcontas: contagem mudou — desfeito';
  end if;
  if (select count(*) from public.contratantes where id in (${CONTRATANTES_OBRIGATORIOS.map((c) => `'${c}'`).join(', ')})) <> ${CONTRATANTES_OBRIGATORIOS.length} then
    raise exception 'TRAVA contratantes obrigatórios ausentes — desfeito';
  end if;
end
$limpeza$;
select ordem, tabela, apagadas from _limpeza order by ordem;
commit;`;

console.log('\n=== apagando (uma transação) ===');
const apagadas = await sql(transacao);
let total = 0;
for (const a of apagadas) {
  total += Number(a.apagadas);
  console.log(`  ${a.tabela.padEnd(24)} ${String(a.apagadas).padStart(6)}`);
}
console.log(`  ${'TOTAL'.padEnd(24)} ${String(total).padStart(6)}`);

const depois = await sql(ALVOS.map((a, i) => `
  select ${i} as ordem, '${a.tabela}' as tabela, count(*) filter (where ${a.onde}) as sobra_do_conjunto, count(*) as linhas
  from public.${a.tabela}`).join(' union all ') + ` union all
  select 98, 'contratantes', 0, count(*) from public.contratantes
  union all select 99, 'subcontas', 0, count(*) from public.subcontas order by ordem`);
console.log('\n=== depois ===');
for (const d of depois) console.log(`  ${d.tabela.padEnd(24)} linhas=${d.linhas}${Number(d.sobra_do_conjunto) ? `  SOBRA=${d.sobra_do_conjunto}` : ''}`);
