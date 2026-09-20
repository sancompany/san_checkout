# Acesso — como um agente chega em cada serviço

Para cada serviço: mecanismos possíveis, e se estão **disponível**,
**não disponível** ou **não verificado** neste ambiente (auditoria de
20/09/2026, ambiente de sessão Claude Code). Um agente em outra
superfície (Codex, Jules) deve refazer esta checagem no próprio
ambiente antes de assumir o mesmo resultado — ver `agents/CODEX.md` e
`agents/JULES.md`.

## GitHub

| Mecanismo | Estado | Nota |
|---|---|---|
| `git remote` | ✅ disponível | `origin` aponta para `sancompany/san_checkout` |
| `gh` CLI | ❌ não disponível | não instalado neste ambiente |
| `GITHUB_TOKEN` (variável) | ✅ disponível | nome confirmado no ambiente; usar via header `Authorization: Bearer` em `curl`, ou deixar o `git`/MCP usarem sozinhos |
| MCP `mcp__github__*` | ✅ disponível nesta sessão | confirmado funcionando: `get_me`, `pull_request_read`, `create_pull_request`, `merge_pull_request` |
| API REST direta (`curl`) | ✅ disponível (fallback) | `https://api.github.com`, com `GITHUB_TOKEN` |

Diagnóstico seguro:
```bash
git remote -v && git branch --show-current
```

## Supabase

| Mecanismo | Estado | Nota |
|---|---|---|
| MCP `mcp__Supabase__*` | ✅ disponível nesta sessão | confirmado: `list_projects`, `list_tables`, `list_migrations` |
| Supabase CLI (`supabase`) | ✅ instalado | v2.117.0, precisa `supabase login`/link para operar contra o projeto remoto |
| `SUPABASE_ACCESS_TOKEN` (variável, conta) | ✅ disponível | usada pelo CLI/MCP para autenticar a conta |
| `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` (variáveis, runtime da app) | não lido nesta auditoria (seriam valores reais) | configuradas no Northflank; ver `.env.example` para o nome |
| API REST direta | não verificado | preferir MCP/CLI, que já lidam com auth |

Diagnóstico seguro:
```bash
supabase --version
```
(login/link são operações de escrita de configuração local — cautela,
ver `AUTONOMY.md`, mas MCP já resolve leitura sem precisar disso.)

## Cloudflare

| Mecanismo | Estado | Nota |
|---|---|---|
| `wrangler` CLI | ❌ não instalado | confirmado ausente no PATH |
| `cloudflared` | ❌ não instalado | confirmado ausente no PATH |
| MCP dedicado | ❌ não encontrado | busca nesta sessão não retornou nenhuma tool `mcp__*cloudflare*` |
| API REST direta (`curl`) | ✅ disponível e confirmada | `CLOUDFLARE_API_KEY`+`CLOUDFLARE_EMAIL` (Global API Key), `CLOUDFLARE_ACCOUNT_ID` |

⚠️ A credencial disponível é a **Global API Key** — acesso à conta
inteira, não escopado a este projeto. Ver `runbooks/cloudflare.md` e
`RISKS.md` para o tratamento obrigatório.

Diagnóstico seguro (read-only, confirmado nesta auditoria):
```bash
curl -sS "https://api.cloudflare.com/client/v4/zones" \
  -H "X-Auth-Email: $CLOUDFLARE_EMAIL" -H "X-Auth-Key: $CLOUDFLARE_API_KEY"
```

## Northflank

| Mecanismo | Estado | Nota |
|---|---|---|
| CLI `northflank` | ✅ instalado e autenticado | v0.13.0, confirmado funcionando |
| `NORTHFLANK_TOKEN` (variável) | ✅ disponível | consumida automaticamente pelo CLI |
| MCP dedicado | ❌ não encontrado nesta busca | usar CLI |
| Skill/plugin `northflank:northflank` | disponível para agentes Claude Code que o tenham instalado | cobre comandos de deploy/banco/preview |

Diagnóstico seguro:
```bash
northflank list projects -o json
```

## Asaas

Não é infraestrutura de desenvolvimento — é o PSP que a aplicação
consome em runtime. Acesso é só via `ASAAS_API_KEY` (variável de
ambiente da aplicação, no Northflank), nunca diretamente por um agente
fora do container em produção. Ver `runbooks/northflank.md`, seção
"Executar comando dentro do container", para o padrão já em uso quando
uma verificação precisa rodar com essa chave sem que ela saia do
container.

## Docker

| Mecanismo | Estado | Nota |
|---|---|---|
| `docker` | ✅ instalado | v29.3.1 — usado só para build local de `Dockerfile`, deploy real acontece na Northflank |

## Resumo de ferramentas de linguagem/runtime confirmadas

`node` v22.22.2, `npm` 10.9.7, `pnpm` 10.33.0, `yarn` 1.22.22, `bun`
1.3.11, `python3` 3.11.15, `psql` 17.11. O projeto usa `npm`
(`package-lock.json` presente) — não introduzir outro gerenciador sem
motivo.
