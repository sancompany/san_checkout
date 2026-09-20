# Runbook — GitHub

Repositório: `sancompany/san_checkout`. Conta autenticada confirmada nesta
auditoria (20/09/2026): usuário `sancompany` (org/conta dona do repo),
via `git remote` + token no ambiente (`GITHUB_TOKEN`) e/ou MCP GitHub
(`mcp__github__*`, quando disponível na superfície do agente).

**`gh` CLI não está instalado** neste ambiente. Não peça ao usuário para
instalar — use `git` puro (sempre disponível) e, quando disponível, as
tools MCP `mcp__github__*`. Se nenhuma das duas alcançar o que você
precisa, `curl` contra `https://api.github.com` com `GITHUB_TOKEN` no
header `Authorization: Bearer $GITHUB_TOKEN` funciona (confirme o token
existe antes: `[ -n "$GITHUB_TOKEN" ] && echo ok`).

## Repositório e remote

```bash
git remote -v
git branch --show-current
git log -5 --oneline
git status --short
```

## Branches

```bash
git branch -a                       # locais e remotas conhecidas
git fetch origin <branch>           # sempre busque a branch específica, não tudo
```

Via MCP (quando disponível): `mcp__github__list_branches`.

## Pull Requests

Via MCP: `mcp__github__list_pull_requests`, `mcp__github__pull_request_read`
(métodos `get`, `get_diff`, `get_status`, `get_files`, `get_commits`,
`get_check_runs`, `get_reviews`, `get_comments`), `mcp__github__create_pull_request`,
`mcp__github__merge_pull_request`.

Confirmado funcionando nesta sessão (20/09/2026): criação, leitura de
status de CI (`get_status`, `get_check_runs`) e merge via squash.

## GitHub Actions

Workflows deste repositório: `.github/workflows/ci.yml` (`testes` — roda
em todo push/PR) e `.github/workflows/seguranca.yml` (`Segurança` — push
em `main`, todo PR, e agendado toda segunda 06:00 Brasília). Ver
`OPERATIONS.md` para o que cada job faz.

Via MCP: `mcp__github__actions_list`, `mcp__github__actions_get`,
`mcp__github__get_check_run`, `mcp__github__get_job_logs`.

```bash
# sem MCP, via API direta (precisa de GITHUB_TOKEN no ambiente)
curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/sancompany/san_checkout/actions/runs?per_page=5"
```

## Releases, tags

Não confirmado nenhum uso de releases/tags formais neste repositório —
o deploy é por merge direto na `main` (ver `.ia/OPERATIONS.md`, "Deploy").
`mcp__github__list_releases`/`list_tags` disponíveis se precisar checar.

## Secrets do repositório — só pelo nome, nunca pelo valor

Confirmado no `RUNBOOK.md` (raiz), item "1.2 Segredos": **o CI não usa
segredo de repositório nenhum** — os autotestes são puros e o runner
injeta valores falsos só para os módulos carregarem
(`tests/executar.js`). Não há Secrets do GitHub Actions configurados
para este repositório hoje. Confirme antes de assumir isso mudou:

```bash
# lista só os NOMES das variáveis/secrets de repositório configuradas —
# exige permissão de admin no token; se der 403/404, não é bloqueio, é
# ausência de acesso administrativo neste token
curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/sancompany/san_checkout/actions/variables"
```

## Commits

```bash
git log --oneline -20
git show <sha> --stat
```

Via MCP: `mcp__github__list_commits`, `mcp__github__get_commit`,
`mcp__github__search_commits`.

## Convenção de commit e PR deste repositório

Ver `CLAUDE.md` (raiz) — trailers de atribuição por agente, mensagens
diretas, uma branch de trabalho por sessão/tarefa. O dono autorizou
(18/09/2026, registrado em `CLAUDE.md`, seção "Mesclar é decisão
tomada") mesclar na `main` sem pedir, sempre que o CI estiver verde —
mesclar aqui **é publicar**, porque `main` vai para produção sozinha via
Northflank (deploy automático) e Cloudflare Pages (deploy automático do
front). A lista curta que ainda exige autorização para **construir**
(não para mesclar) está na mesma seção e é retomada em `.ia/AUTONOMY.md`.
