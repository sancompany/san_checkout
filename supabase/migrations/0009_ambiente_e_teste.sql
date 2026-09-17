-- 0009 — em que ambiente a cobrança nasceu, e se ela foi um teste do dono
--
-- Colunas DESENHADAS na migration 0004 e nunca escritas
-- (`docs/pendencias.md`). A condição que a própria pendência marcava —
-- "entram quando o modo de teste por contratante ou a troca para
-- produção pedirem" — virou verdade: a troca está na fila.
--
-- ── Por que antes da troca, e não depois ─────────────────────────────
-- A métrica de sucesso da Estação 1 é "cobranças confirmadas por
-- contratante, por dia" (`docs/funcional.md` §9), e a prontidão
-- operacional exige que ela não conte uso interno — "para o dono
-- testando não contaminar".
--
-- Medido em 17/09/2026 contra o banco de produção: `testemaster` tem 1
-- cobrança confirmada de R$ 10,00, que é a assinatura de teste paga em
-- 16/09 para exercitar o fluxo. Hoje isso é inofensivo, porque TUDO é
-- sandbox e `npm run limpar-teste` apaga esses registros no passo 3 da
-- troca (`RUNBOOK` §6.2).
--
-- O problema nasce DEPOIS da troca: o passo seguinte do plano é um
-- pagamento real de valor baixo, feito pelo dono, em produção. Esse não
-- é apagável — é cobrança real, com dinheiro real, que a guarda fiscal
-- manda manter — e sem estas colunas ele entra na métrica como
-- resultado de negócio. Métrica de sucesso que conta para cima é a
-- mentira pior das duas: ausência de receita se percebe, receita falsa
-- não.
--
-- ── O que estas colunas NÃO são ──────────────────────────────────────
-- NÃO são o "modo de teste por contratante" de `docs/proximas-versoes.md`.
-- Aquilo é ambiente por contratante e mexe em `contratantes`, na chave
-- da Asaas, no painel e no `API.md`; segue adiado, e de propósito. Aqui
-- é só o REGISTRO, em `cobrancas`, de um fato que o sistema já conhece
-- no momento da criação. A decisão continua global em
-- `src/config/asaas.js`.
--
-- ── `alter table` explícito, e não dentro de `create table` ──────────
-- Lição nº 22 do catálogo, e erro vivido aqui em 11/09/2026
-- (`docs/erros/2026-09-11-coluna-nao-criada-por-create-table-if-not-exists.md`):
-- `create table if not exists` numa tabela que já existe é no-op, e a
-- coluna acrescentada no corpo dele nunca é criada. Coluna depois da
-- primeira ida a produção entra por `alter`, no corpo executável.

-- ── ambiente ─────────────────────────────────────────────────────────
-- `default 'sandbox'` é o valor CONSERVADOR, não o mais comum: sandbox
-- nunca conta como receita. Esquecer de escrever a coluna faz a métrica
-- contar para BAIXO, que é o lado seguro do erro — e há autoteste
-- exigindo que a aplicação a escreva.
--
-- As 10 linhas que já existem ficam corretas com o default: todas
-- nasceram em sandbox, conferido.
alter table cobrancas
  add column if not exists ambiente text not null default 'sandbox';

-- Conjunto FECHADO, recusado no banco e não só na aplicação (lição
-- nº 19, e o degrau "constraint no banco antes de código na aplicação"
-- da skill `construir`). Dois valores, os mesmos de `ASAAS_AMBIENTE`.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'cobrancas_ambiente_conhecido'
  ) then
    alter table cobrancas
      add constraint cobrancas_ambiente_conhecido
      check (ambiente in ('sandbox', 'producao'));
  end if;
end $$;

-- ── e_teste ──────────────────────────────────────────────────────────
-- A marca que o OPERADOR põe numa cobrança de produção que foi teste
-- dele. Diferente de `ambiente`, que é mecânico: esta é decisão humana,
-- e por isso o default é `false` — nada é teste até alguém dizer que é.
alter table cobrancas
  add column if not exists e_teste boolean not null default false;

-- ── A mão única, no banco ────────────────────────────────────────────
-- O desenho da 0004 dizia "de mão única: só vai de teste para real". A
-- direção importa e não é simetria: promover teste → real é corrigir uma
-- marcação; demover real → teste é ESCONDER receita de verdade da
-- métrica, e seria o caminho para maquiar um número ruim ou tirar do
-- relatório uma transação inconveniente.
--
-- A regra mora no banco porque não pode depender de a aplicação
-- lembrar: quem escreve na tabela é o backend hoje, mas o painel do
-- Supabase escreve direto, e reparo manual também. Trigger vale para
-- todos.
create or replace function public.e_teste_e_de_mao_unica()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.e_teste = false and new.e_teste = true then
    raise exception
      'e_teste e de mao unica: cobranca % ja esta marcada como real e nao volta a ser teste. Promover teste->real e permitido; o contrario, nao.',
      old.id;
  end if;
  return new;
end;
$$;

-- `set search_path = ''` acima: regra da migration 0004, que corrigiu
-- exatamente esta falha nas duas funções da 0002 — sem ela, o linter de
-- segurança do Supabase acusa a função como sequestrável por search_path.

drop trigger if exists cobrancas_e_teste_mao_unica on cobrancas;
create trigger cobrancas_e_teste_mao_unica
  before update of e_teste on cobrancas
  for each row
  execute function public.e_teste_e_de_mao_unica();

-- ── Índice ───────────────────────────────────────────────────────────
-- A consulta da métrica passa a excluir sandbox e teste. Índice parcial
-- sobre o que ela DE FATO lê: cobrança de produção que não é teste.
create index if not exists idx_cobrancas_metrica_real
  on cobrancas (confirmado_em desc)
  where ambiente = 'producao' and e_teste = false and confirmado_em is not null;

comment on column cobrancas.ambiente is
  'sandbox | producao — em que ambiente da Asaas a cobranca nasceu. Escrito na criacao a partir de ASAAS_AMBIENTE; default sandbox e o valor conservador (nao conta como receita).';
comment on column cobrancas.e_teste is
  'Marca do operador para cobranca de PRODUCAO que foi teste dele. De mao unica: teste->real e permitido, real->teste e recusado por trigger.';
