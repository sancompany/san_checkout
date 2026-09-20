# Runbook — Supabase

Projeto confirmado (20/09/2026, via `mcp__Supabase__list_projects`):

| Campo | Valor |
|---|---|
| Nome | `San_Checkout` |
| `project_id` / `ref` | `zacuaroarelaqnzjjlcz` |
| Região | `sa-east-1` (mesma região da Northflank — escolhida por latência medida, ver `DECISIONS.md`) |
| Postgres | 17.6.1.166 |
| Status | `ACTIVE_HEALTHY` |

Existe um segundo projeto na mesma organização Supabase, `MostrAi`
(`ref: wnbztsprmzarexnncchg`) — **não é deste repositório**, pertence a
outro projeto do ecossistema San & Co. (política de banco isolado por
projeto, `.ia/DECISIONS.md`). Não leia nem escreva nele a partir daqui.

## Mecanismos de acesso confirmados

1. **MCP `mcp__Supabase__*`** — confirmado funcionando nesta sessão:
   `list_projects`, `list_tables` (verbose, com colunas/PKs/FKs),
   `list_migrations`. `.claude/settings.json` já pré-autoriza
   `mcp__Supabase__list_projects` sem prompt.
2. **Supabase CLI** (`supabase`, v2.117.0) — instalado
   (`/opt/node22/bin/supabase`). Requer login/link para operar contra o
   projeto remoto; `supabase/.temp/cli-latest` existe no repositório
   (cache local de versão, não credencial).
3. **`SUPABASE_ACCESS_TOKEN`** no ambiente — token de acesso de conta,
   usado pelo CLI e/ou MCP para autenticar. **Nunca imprimir o valor.**
4. **Variáveis de runtime da aplicação** (`SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY`) — configuradas no Northflank, consumidas por
   `src/config/supabase.js`. Não confundir com `SUPABASE_ACCESS_TOKEN`
   (conta) — são credenciais diferentes para propósitos diferentes.

## Verificar projeto e conexão

```bash
supabase --version
supabase projects list          # exige login prévio (supabase login)
```

Via MCP: `mcp__Supabase__get_project`, `mcp__Supabase__get_project_url`
(ambos tomam `project_id`).

## Schema e tabelas

Via MCP (preferido — não precisa de CLI logado nem de string de conexão):

```
mcp__Supabase__list_tables(project_id="zacuaroarelaqnzjjlcz", schemas=["public"], verbose=true)
```

Devolve colunas, tipos, defaults, comentários, PKs e FKs — é a forma mais
rápida de confirmar o schema REAL, sem depender de as migrations locais
estarem sincronizadas com o que foi aplicado (ver `RISKS.md`, a
divergência de nomenclatura encontrada entre `supabase/migrations/*.sql`
locais e o histórico de migrations do projeto).

Tabelas confirmadas em produção (20/09/2026): `contratantes`, `cobrancas`,
`assinaturas`, `subcontas`, `webhook_eventos`, `webhook_rejeicoes`, `erros`.
Todas com RLS habilitada.

## Migrations

Arquivos locais: `supabase/migrations/0001_baseline.sql` até
`0010_troca_de_plano.sql` (10 arquivos, ver `ARCHITECTURE.md`).

```bash
ls supabase/migrations/          # a lista real — nunca confiar num número escrito em prosa
```

Via MCP: `mcp__Supabase__list_migrations(project_id=...)` — lista o que
está de fato registrado como aplicado no projeto remoto.

⚠️ **Achado nesta auditoria**: o histórico devolvido por
`list_migrations` tem 10 entradas mas os *nomes* não batem 1:1 com os 10
arquivos locais por número — não aparece nenhuma entrada citando "0009"
(a migration `ambiente_e_teste`), e aparecem duas entradas para "0010"
(`0010_troca_de_plano` e `0010_troca_de_plano_arrendamento`). Verificado
direto no schema (`list_tables`) que as colunas de AMBAS as migrations
0009 e 0010 existem na tabela real (`ambiente`, `e_teste` em `cobrancas`;
`plano_anterior_id`, `trocado_em`, `trocando_em` em `assinaturas`) — ou
seja, **o schema está correto**, só o texto do histórico de nomes diverge
do nome do arquivo local. Não é um bug ativo, é um motivo para nunca
confiar só no nome/número de uma migration — confirme sempre pela coluna
real. Detalhe em `RISKS.md`.

Aplicar migration nova (requer decisão do dono — ver `AUTONOMY.md`,
"migration destrutiva ou schema" está na lista de cautela):

```bash
# via CLI, projeto linkado
supabase db push
# ou via MCP, quando a tool estiver disponível:
# mcp__Supabase__apply_migration(project_id=..., name=..., query=...)
```

## Logs e advisors

Via MCP (quando disponível): `mcp__Supabase__query_logs`,
`mcp__Supabase__get_advisors` (segurança e performance).

## Auth, Storage, Edge Functions

**Não confirmado uso neste projeto.** `src/config/supabase.js` usa só o
cliente `@supabase/supabase-js` para banco (`select`/`insert`/`update`/
`rpc`) com a `service_role` key — não há Auth de usuário final (login é
próprio, `senhaAdmin.js`/`sessaoAdmin.js`), não há Storage em uso, não há
Edge Functions. Confirme com `mcp__Supabase__list_edge_functions` antes
de assumir que isso mudou.

## String de conexão direta (`psql`)

`psql` está instalado (17.11) mas **não há host/porta/senha registrados
em lugar nenhum deste repositório** — a aplicação fala com o Supabase só
via `@supabase/supabase-js` (REST/RPC), nunca por conexão Postgres
direta. Se precisar de acesso `psql` direto (ex.: `npm run
ensaio-restauracao`, que roda um Postgres LOCAL para o ensaio de
restauração, não o de produção), ver `RUNBOOK.md` (raiz) seção 6.
