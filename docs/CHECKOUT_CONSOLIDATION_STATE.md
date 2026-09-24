# SAN CHECKOUT — estado da consolidação (retomada segura)

> Curto, de propósito. Atualizado a cada checkpoint. Se a sessão parar,
> quem retomar lê isto primeiro.

## Fase atual
**Concluída em 24/09/2026.** PR #42 mesclado e no ar (`899fa5f`),
MostrAí `78235a7` no ar, E2E sandbox e matriz MostrAí × Checkout verdes,
Access ON. Relatório: `docs/CHECKOUT_FINAL_CONSOLIDATION_2026-09-24.md`.
Resta o PR #43 (consultas 5.2/5.3 com `versao: 2` + este relatório).

## Estado provado em 24/09/2026 (Fase 0)
| item | valor | como se provou |
|---|---|---|
| repo | `sancompany/san_checkout` | `git remote` |
| branch de trabalho | `claude/nifty-meitner-4ffp9s` | `git status` |
| origin/main | `f7b1cb9` | `git fetch origin main` |
| Node local | v22.22.2 / npm 10.9.7 | `node -v` |
| backend | Northflank `san-co/san-checkout/san-checkout`, 1 instância, plano `nf-compute-50`, porta 3001, `api.sancocore.com.br` | `northflank get service -o json` |
| deployedSHA backend | `f7b1cb9` (= main), deploy COMPLETED 24/09 09:04Z | idem |
| env do backend | 11 variáveis: ASAAS_AMBIENTE, ASAAS_API_KEY, ASAAS_WEBHOOK_TOKEN, CHECKOUT_ADMIN_PASS_HASH, CHECKOUT_ADMIN_USER, NODE_ENV, ORIGEM_FRONTEND, SUPABASE_SERVICE_KEY, SUPABASE_URL, TAXA_FIXA, TAXA_PERCENTUAL — todas CONFIGURADAS | idem (só nomes) |
| ASAAS_AMBIENTE | `sandbox`; chave classe `$aact_hmlg…` (últimos 4: `OWMy`) | idem |
| taxa | 0.9 % + R$ 0,50 | idem |
| frontend | Cloudflare Pages `san-checkout`, branch de produção `main`, `checkout.sancocore.com.br` + `san-checkout.pages.dev` | API Cloudflare |
| Access | app "Painel admin do San Checkout" cobre `/admin` e `/admin.html` nos dois hosts; `GET /admin.html` anônimo → 302 para o login do Access | API + curl |
| Supabase | projeto `San_Checkout` (`zacuaroarelaqnzjjlcz`, sa-east-1, PG 17.6) | MCP |
| migrations remotas | 0001–0015 aplicadas (0015 em 24/09 via Management API, registrada como `20260924120000 consolidacao_financeira`) | `schema_migrations` + `information_schema` |
| tabelas | contratantes(2), cobrancas, assinaturas, subcontas, webhook_eventos, webhook_rejeicoes, erros, intencoes_troca_plano + **webhook_inbox, outbox_notificacoes, cotacoes, clientes_asaas** (0015) | SQL |
| RLS | habilitada nas 12 tabelas, zero policies (default-deny; service role passa) | SQL |
| `/api/saude` | 200 ok, Supabase respondendo, sem alerta de chave | curl |
| webhook Asaas | `POST /api/webhooks/asaas` sem token → 401; `/api/webhook/asaas` → 404; config na Asaas: enabled, `SEQUENTIALLY`, 61 eventos | curl + GET /v3/webhooks |

## O que a 0015 mudou no banco (aplicada, verificada coluna a coluna)
- `webhook_inbox`, `outbox_notificacoes`, `cotacoes`, `clientes_asaas` (RLS on)
- `cobrancas` + `valor_estornado`, `status_evento_em`, `cotacao_id`; status
  `estornado_parcialmente`; checks `valor_cobrado > 0`, `parcelas 1..12`,
  estorno coerente; índice único de reserva de assinatura pendente
- `contratantes.ciclos_permitidos`; `mostrai` = MONTHLY/QUARTERLY/SEMIANNUALLY/YEARLY

## Último commit / deploy
- origin/main servido: `899fa5f` (Northflank `deployedSHA` conferido; Pages em `main`)
- MostrAí: `main = 78235a7`, deployado (Northflank `mostrai`)
- migrations: 0001–0015 aplicadas
- Access: ON

## Atenção ao deployar
O código na branch já ESCREVE nas tabelas da 0015 — a migration foi
aplicada ANTES do deploy de propósito (código antigo ignora as tabelas
novas; código novo sem as tabelas quebraria o receptor de webhook).

## Próxima ação
Nenhuma automática. Do dono: troca da Asaas para produção (hard gate).
Declarados em `docs/pendencias.md` ("Consolidação financeira").
