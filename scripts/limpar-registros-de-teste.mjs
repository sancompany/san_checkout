#!/usr/bin/env node
/**
 * SAN CHECKOUT — scripts/limpar-registros-de-teste.mjs
 *
 * Apaga os registros de cobrança e assinatura criados no SANDBOX, antes
 * da troca para produção.
 *
 * ── Por que isto existe, e por que antes e não depois ───────────────
 * Todo identificador da Asaas é preso ao ambiente (`API.md §11.1`).
 * Assinatura de sandbox que sobrevive no nosso registro depois da troca
 * vira **zumbi**: `POST /cancelar-assinatura` chama a Asaas de produção
 * com um `sub_…` de sandbox, leva 404, e a linha seguinte — a que
 * gravaria o status novo — nunca roda. O registro fica `ativa` para
 * sempre, incancelável pela API.
 *
 * Desde a migration 0009, `cobrancas.ambiente` distingue a cobrança de
 * sandbox da real (RN-33) — mas `assinaturas` não tem a coluna, e é ela
 * que vira zumbi. Por isso a limpeza continua sendo o passo 3 do
 * `RUNBOOK.md §6.2`, antes da troca, e não faxina posterior.
 *
 * ── O padrão é NÃO apagar ───────────────────────────────────────────
 * Sem `--apagar`, lista o que apagaria e sai. Apagar dado de cobrança é
 * irreversível e está na lista curta que pede autorização explícita —
 * um script que apaga por padrão é um acidente esperando a hora.
 *
 * Uso:  npm run limpar-teste              # só mostra
 *       npm run limpar-teste -- --apagar  # apaga de verdade
 */

const PROJETO = process.env.SUPABASE_PROJECT_REF ?? 'zacuaroarelaqnzjjlcz';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const APAGAR = process.argv.includes('--apagar');

if (!TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN ausente.');
  process.exit(1);
}

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJETO}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const corpo = await r.json();
  if (!r.ok) throw new Error(`SQL falhou (${r.status}): ${JSON.stringify(corpo).slice(0, 300)}`);
  return corpo;
}

/* O que é "de teste": tudo que existe hoje, porque hoje o checkout só
   rodou em sandbox (`CONSTRAINTS.md` §3).

   Este comentário dizia, até 17/09/2026, que o script **não tinha como
   saber sozinho** se o banco já tinha dinheiro real — e era verdade
   enquanto nenhuma coluna marcasse a origem da cobrança. A migration
   0009 passou a gravar `cobrancas.ambiente` na criação, a partir da
   configuração do processo (RN-33), e com ela o guarda deixou de ser só
   a pessoa: havendo UMA linha de produção, este script recusa apagar
   qualquer coisa, inclusive com a bandeira. A bandeira continua exigida
   — as outras quatro tabelas não têm a coluna, e apagar histórico de
   cobrança não tem volta —, mas agora ela é a segunda tranca, não a
   única. */
const CONFIRMOU_SANDBOX = process.argv.includes('--confirmo-que-e-sandbox');

const contagens = await sql(`
  select 'cobrancas' as tabela, count(*) as linhas from public.cobrancas
  union all select 'assinaturas', count(*) from public.assinaturas
  union all select 'webhook_eventos', count(*) from public.webhook_eventos
  union all select 'webhook_rejeicoes', count(*) from public.webhook_rejeicoes
  union all select 'erros', count(*) from public.erros
  order by 1`);

/* `contratantes` e `subcontas` NÃO entram: contratante é cadastro, não
   registro de cobrança, e apagá-lo quebraria a integração do MostrAí,
   que é justamente o que a troca não pode quebrar. O `wallet_id` dele,
   sim, precisa ser trocado — mas isso é edição no painel, não aqui. */
const ALVOS = ['cobrancas', 'assinaturas', 'webhook_eventos', 'webhook_rejeicoes', 'erros'];

console.log('=== registros hoje no banco ===');
for (const c of contagens) {
  const marca = ALVOS.includes(c.tabela) ? 'APAGA' : 'mantém';
  console.log(`  ${marca.padEnd(7)} ${c.tabela.padEnd(20)} ${c.linhas}`);
}
console.log('\n  mantém  contratantes         (cadastro, não cobrança — apagar quebraria a integração)');
console.log('  mantém  subcontas            (idem)');

/* A quebra por ambiente é o que responde "já entrou dinheiro real?".
   Vale para `cobrancas` só: as outras quatro tabelas não têm a coluna. */
const porAmbiente = await sql(`
  select ambiente, e_teste, count(*) as linhas
  from public.cobrancas group by 1, 2 order by 1, 2`);

console.log('\n=== cobrancas por ambiente (RN-33) ===');
if (!porAmbiente.length) console.log('  (nenhuma cobrança no banco)');
for (const a of porAmbiente) {
  console.log(`  ${String(a.ambiente).padEnd(10)} e_teste=${String(a.e_teste).padEnd(5)} ${a.linhas}`);
}

const DE_PRODUCAO = porAmbiente
  .filter((a) => a.ambiente === 'producao')
  .reduce((soma, a) => soma + Number(a.linhas), 0);

const detalhe = await sql(`
  select a.id, a.contratante_id, a.plano_id, a.status, a.ciclo
  from public.assinaturas a order by a.criado_em desc`);

if (detalhe.length) {
  console.log('\n=== assinaturas que deixariam de existir na Asaas depois da troca ===');
  for (const a of detalhe) {
    console.log(`  ${a.id}  ${a.contratante_id}/${a.plano_id}  ${a.status} ${a.ciclo}`);
  }
  console.log('\n  Estas são as que viram zumbi se sobreviverem à troca.');
  console.log('  Quem estiver assinado precisa assinar de novo em produção.');
}

if (!APAGAR) {
  console.log('\n--- NADA FOI APAGADO ---');
  console.log('Para apagar de verdade:');
  console.log('  npm run limpar-teste -- --apagar --confirmo-que-e-sandbox');
  process.exit(0);
}

/* Guarda de verdade, e ele vem ANTES da bandeira: bandeira é afirmação
   de quem roda, e afirmação errada sobre dinheiro real não tem desfazer.
   Recusa fechada — dado de produção presente, não apaga nada. */
if (DE_PRODUCAO > 0) {
  console.error('\n--- RECUSADO (guarda automático) ---');
  console.error(`Existem ${DE_PRODUCAO} cobrança(s) com ambiente = 'producao' neste banco.`);
  console.error('Isto não é banco de sandbox, e a limpeza é passo ANTES da troca');
  console.error('(RUNBOOK §6.2, passo 3). Apagar aqui destruiria histórico real.');
  console.error('Nenhuma bandeira passa por cima disto: se a intenção é outra,');
  console.error('ela precisa ser escrita como procedimento próprio, não como flag.');
  process.exit(1);
}

if (!CONFIRMOU_SANDBOX) {
  console.error('\n--- RECUSADO ---');
  console.error('Isto apaga TODO histórico de cobrança e assinatura, e não há volta.');
  console.error('O guarda automático (cobrancas.ambiente) já conferiu que não há');
  console.error('linha de produção — mas as outras quatro tabelas não têm a coluna.');
  console.error('Quem confirma é você, e só depois de conferir a lista acima:');
  console.error('  npm run limpar-teste -- --apagar --confirmo-que-e-sandbox');
  process.exit(1);
}

console.log('\n=== apagando ===');
// Ordem inversa da dependência: filho antes do pai.
for (const tabela of ['cobrancas', 'assinaturas', 'webhook_eventos', 'webhook_rejeicoes', 'erros']) {
  await sql(`delete from public.${tabela}`);
  console.log(`  ${tabela}: apagada`);
}

const depois = await sql(`
  select 'cobrancas' as tabela, count(*) as linhas from public.cobrancas
  union all select 'assinaturas', count(*) from public.assinaturas
  order by 1`);
console.log('\n=== depois ===');
for (const c of depois) console.log(`  ${c.tabela}: ${c.linhas}`);
console.log('\nPróximo passo: RUNBOOK §6.2, passo 4 (as três variáveis no Northflank).');
