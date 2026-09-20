# Estado do projeto — verificável

Este documento registra o estado no momento da última atualização
**e como reconfirmar cada afirmação**. Nunca confie num número aqui sem
rodar o comando ao lado quando a informação for crítica para a sua
tarefa — estado de infra envelhece rápido, o comando não.

**Última verificação**: 20/09/2026, auditoria de preparação multi-agente.

## Versão e branch

- Branch de trabalho no momento desta auditoria: `claude/nifty-meitner-4ffp9s`.
- Branch principal / produção: `main`.
- Reconfirmar: `git branch --show-current` e `git log origin/main -1 --oneline`.

## Ambiente de produção

- **Único ambiente real** — não há staging separado. Todo merge na
  `main` publica.
- Backend: Northflank, projeto `san-checkout`, serviço `san-checkout`.
  Reconfirmar SHA servido: ver comando em `OPERATIONS.md`, "Verificar
  deploy efetivo".
- Front: Cloudflare Pages, domínio `checkout.sancocore.com.br`.
- API: `api.sancocore.com.br` (DNS-only, sem proxy Cloudflare).
- Banco: Supabase `San_Checkout` (`zacuaroarelaqnzjjlcz`, `sa-east-1`),
  `ACTIVE_HEALTHY` na verificação desta auditoria.
- Health check: `curl -sS https://api.sancocore.com.br/api/saude` — 200
  confirmado nesta auditoria, com `supabaseRespondendo: true`.

## Ambiente de staging

**Não existe.** Reconfirmar: nenhuma referência a segundo serviço
Northflank, segundo domínio de app ou segunda branch de deploy
encontrada nesta auditoria.

## Pagamento — sandbox, não produção real

O backend está em produção real, mas a integração com a Asaas continua
em **modo sandbox** (`ASAAS_AMBIENTE=sandbox`) — decisão registrada,
não pendência esquecida (`CONSTRAINTS.md` §3, "Estação 5 · deploy em
produção apontando para o sandbox da Asaas"). A troca para produção
real depende do dono: as três variáveis no Northflank
(`ASAAS_API_KEY`, `ASAAS_AMBIENTE=producao`, o que mais a troca exigir)
e reconfigurar o webhook de produção em `/api/webhooks/asaas`
(plural — o singular dá 404, já conferido). Reconfirmar o ambiente
atual: `GET /api/saude` traz `chaveAsaasConfigurada`; o valor de
`ASAAS_AMBIENTE` em si não é exposto por essa rota por design (é
credencial-adjacente) — confirmar lendo a variável no Northflank
(nome, não valor) ou pelo comportamento observado (domínio sandbox nas
chamadas à Asaas).

## Componentes — o que está implementado

| Componente | Estado | Evidência |
|---|---|---|
| Pagamento avulso (Pix, boleto, cartão até 12x) | ✅ funcional, testado ao vivo | `docs/erros/2026-09-18-descricao-do-contratante-sem-teto-quebrava-cartao-por-inteiro.md` (bug achado e corrigido testando ao vivo) |
| Assinatura por cartão | ✅ funcional, com pagamento real no sandbox já concluído | `CLAUDE.md` raiz, 16/09/2026 |
| Assinatura por Pix Automático | ⚠️ implementada, mas **desligada nesta conta Asaas** | `CONSTRAINTS.md` §2.4 |
| Cancelar/pausar/retomar assinatura | ✅ funcional | `docs/funcional.md`, RN-20/21 |
| Trocar de plano (upgrade/downgrade) | ✅ no ar desde 18/09/2026 | PR #18, commit `5910150`; `API.md` §5.6 |
| Conciliação (pedido e assinatura) | ✅ funcional, reconcilia `status`/`ciclo`/`proximaCobranca`/`valor` | `API.md` §5.2/§5.3 |
| Webhook da Asaas (recepção) | ✅ funcional, assinatura HMAC verificada | `webhookController.js` |
| Tratamento dos eventos `SUBSCRIPTION_*` | ❌ não implementado | marcação no painel Asaas feita (18/09), tratamento em código aguarda primeiro payload real |
| Estorno | ✅ funcional, só pelo contratante | `refundController.js` |
| Painel admin | ✅ funcional, atrás de Cloudflare Access + login próprio | `adminController.js`, `CONSTRAINTS.md` §2.6 |
| Métrica de sucesso (cobranças confirmadas) | ✅ funcional, filtra uso interno (`ambiente`/`e_teste`) | migration 0009, RN-33 |
| Captura de exceção (Lei 8) | ✅ funcional, inclusive rejeição de Promise não tratada | migration 0007, `erroService.js` |
| Backup/restauração | ⚠️ ensaiada com sucesso (RTO ~1s), sem cópia periódica fora do provedor | `CONSTRAINTS.md` §3 |
| Acessibilidade WCAG 2.2 AA | ✅ verificada, 0 violações na última rodada | `npm run acessibilidade` |
| Documentos legais (Termos/Privacidade) | ✅ publicados, v3, pessoa física (CPF) | `public/termos.html`, `public/privacidade.html` |

## O que está quebrado hoje

Nada identificado como quebrado em produção nesta auditoria — a
Estação 6 (ver abaixo) está avançada, com pendências declaradas, não
bugs abertos. Um agente que encontrar algo quebrado deve registrar em
`docs/erros/` e atualizar esta tabela na mesma tarefa.

## Migrations

10 arquivos locais (`supabase/migrations/0001` a `0010`), todos
aplicados no schema real — **confirmado pelas colunas existentes**
via `mcp__Supabase__list_tables`, não só pelo nome do arquivo (ver
`RISKS.md` para uma divergência de nomenclatura encontrada entre o
histórico de migrations do Supabase e os nomes de arquivo locais —
inofensiva, mas registrada). Reconfirmar:
```bash
ls supabase/migrations/
```
```
mcp__Supabase__list_migrations(project_id="zacuaroarelaqnzjjlcz")
mcp__Supabase__list_tables(project_id="zacuaroarelaqnzjjlcz", schemas=["public"], verbose=true)
```

## Testes

38 suítes (`tests/executar.js`), todas passando na última execução
desta auditoria (`npm run check`). O número exato é conferido por
`tests/o-que-os-documentos-afirmam.js` — não copie um número fixo para
outro documento sem rodar o teste, ele já pegou divergência três vezes
na mesma semana (17-18/09/2026).

## Pipeline do plugin `san-co` — estação atual

**Estação 6 (Prontidão), aberta em 14/09/2026, muito avançada.** O que
falta para fechá-la, segundo `CLAUDE.md` (raiz) em 19/09/2026— e
**nada disso é código deste repositório**:

1. Troca da Asaas de sandbox para produção real (ação do dono, gated em
   o MostrAí bater o mesmo ponto de equilíbrio do lado dele).
2. Primeiro ciclo de assinatura pago em produção real (depende do item 1)
   — e, com ele, o tratamento em código dos eventos `SUBSCRIPTION_*`.
3. Primeiro pagamento real de valor baixo — gatilho da exceção de
   backup registrada em `CONSTRAINTS.md` §3.
4. Alguns campos `⬜` do inventário de contas/contatos que nenhuma API
   responde (onde a senha mora, qual cartão paga) — só o dono resolve.

O detalhe completo, dia a dia, está em `CLAUDE.md` (raiz) — não
duplicado aqui de propósito (ver `.ia/README.md`, "permanente vs.
atualizado com frequência"). Este documento resume o que é **estado**;
`CLAUDE.md` guarda a **narrativa**.

## Como reverificar tudo de uma vez

```bash
git status --short && git log -3 --oneline
npm run check
curl -sS https://api.sancocore.com.br/api/saude
northflank get service --project san-checkout --service san-checkout -o json | \
  python3 -c "import json,sys; print(json.load(sys.stdin)['deployment']['internal']['deployedSHA'])"
```
