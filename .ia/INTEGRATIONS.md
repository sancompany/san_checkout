# Integrações — inventário real

Confirmado por verificação direta e read-only em 20/09/2026, salvo onde
marcado "não confirmado". Nenhum valor de credencial aparece aqui — só
nome de variável, ID não sensível e mecanismo.

| Serviço | Uso neste projeto | Ambiente | Mecanismo confirmado | Estado | Onde configurar |
|---|---|---|---|---|---|
| **GitHub** | Hospedagem do código, CI, deploy automático (gatilho) | único (produção = `main`) | `git` CLI + `GITHUB_TOKEN` no ambiente; MCP `mcp__github__*` quando a superfície do agente expõe | ✅ confirmado (repo, PRs, CI, merge exercitados nesta sessão) | github.com/sancompany/san_checkout → Settings |
| **Supabase** | Banco de dados relacional único do Checkout | produção única (`San_Checkout`) | MCP `mcp__Supabase__*`; Supabase CLI (`supabase`, precisa login); `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` para a aplicação | ✅ confirmado (`list_projects`, `list_tables`, `list_migrations` exercitados) | supabase.com/dashboard/project/zacuaroarelaqnzjjlcz |
| **Cloudflare** | DNS da zona `sancocore.com.br`; Pages (front do Checkout); Access (proteção do admin); Web Analytics | produção única | API REST direta (`X-Auth-Email`+`X-Auth-Key`, **Global API Key**); sem CLI (`wrangler` ausente), sem MCP dedicado | ✅ parcial — DNS e zona confirmados; Pages/Access não exercitados nesta auditoria (ver `ACCESS.md`) | dash.cloudflare.com, conta da zona `sancocore.com.br` |
| **Northflank** | Hospedagem e deploy do backend (`src/server.js`) | produção única (serviço `san-checkout`) | CLI `northflank` autenticado (`NORTHFLANK_TOKEN`); sem MCP dedicado encontrado | ✅ confirmado (`list projects`, `get service`, deploy checado) | app.northflank.com/project/san-checkout |
| **Asaas** | PSP — processa toda cobrança/assinatura real | **sandbox** (produção real ainda não ligada, ver `PROJECT_STATE.md`) | REST API própria da aplicação (`src/services/asaasService.js`), `ASAAS_API_KEY` no Northflank | ✅ em uso (sandbox); troca para produção é pendência explícita do dono | painel Asaas (fora deste inventário de infraestrutura de dev) |

## Detalhe por serviço

### GitHub
- Repositório único: `sancompany/san_checkout`.
- Branches de trabalho: uma por sessão/tarefa (padrão `claude/<slug>`
  observado); merge para `main` via squash, autorizado a rodar sem
  pedir confirmação quando o CI está verde (`CLAUDE.md` raiz, "Mesclar
  é decisão tomada").
- Dois workflows: `ci.yml` (testes, todo push/PR) e `seguranca.yml`
  (dependências + segredo no histórico + análise estática — push em
  `main`, todo PR, e semanalmente).
- Integrações de terceiro plugadas via GitHub App, não via workflow
  deste repositório: **Cloudflare Pages** (deploy automático do front)
  e, aparentemente, um App de preview do **Supabase** (visto como check
  "Supabase Preview" nas PRs, `skipped` — não confirmado se está
  configurado de propósito ou só inativo, ver `RISKS.md`).

### Supabase
- Um projeto por escopo de isolamento de dado (política registrada em
  `DECISIONS.md`): `San_Checkout` (`zacuaroarelaqnzjjlcz`, `sa-east-1`)
  é o único que este repositório usa. Existe um segundo projeto na
  mesma organização (`MostrAi`) — pertence a outro produto, fora de
  escopo.
- 7 tabelas em produção, todas com RLS: `contratantes`, `cobrancas`,
  `assinaturas`, `subcontas`, `webhook_eventos`, `webhook_rejeicoes`,
  `erros`. Detalhe de colunas em `ARCHITECTURE.md`/`runbooks/supabase.md`.
- Sem uso de Auth, Storage ou Edge Functions confirmado — só banco via
  `service_role` key.

### Cloudflare
- Uma zona: `sancocore.com.br` (`zone_id: 64c4d0823e2883586cdbb7cfe02dacf4`).
- DNS: `api.sancocore.com.br` aponta para a Northflank **sem proxy**
  (DNS-only, deliberado — a API é pública por desenho, decisão
  registrada); `checkout.sancocore.com.br` aponta para um projeto
  Cloudflare Pages, proxiado.
- Outros registros na mesma zona (`www`, raiz, `humano.*`, `mostrai.*`)
  pertencem a outros projetos do ecossistema — fora de escopo deste
  repositório, não alterar a partir daqui.
- Cloudflare Access protege `/admin` e `/admin.html` em produção
  (confirmado por documentação do projeto, `CONSTRAINTS.md` §2.6; não
  re-exercitado nesta auditoria via API).
- SPF/DMARC configurados na zona (confirmado via DNS: SPF via
  `include:_spf.google.com`, DMARC `p=reject`) — relacionado a e-mail do
  domínio, não à aplicação em si.

### Northflank
- Um projeto: `san-checkout`, um serviço: `san-checkout` (tipo
  `combined` — build e deploy juntos), branch de build `main`, porta
  interna 3001.
- Sem addon de banco (o banco é o Supabase externo).
- Existe um segundo projeto Northflank na mesma conta (`mostrai`) —
  outro produto, fora de escopo.
- Existe também um plugin/skill oficial da Northflank
  (`northflank:northflank`) disponível para agentes Claude Code, cobrindo
  deploy/banco/preview por comando — não audita processo, só executa
  operação (README do plugin `san-co`, seção "Onde ele fica instalado").

### Asaas
- PSP brasileiro, motor real de cobrança. Hoje em **modo sandbox**
  (`ASAAS_AMBIENTE=sandbox`) mesmo com o backend em produção real — é a
  exceção registrada em `CONSTRAINTS.md` §3 ("Estação 5 · deploy em
  produção apontando para o sandbox da Asaas"). A troca para produção
  real depende de decisão e ação do dono (as três variáveis no
  Northflank + webhook de produção) — ver `PROJECT_STATE.md`.
- Contrato de integração consumido documentado em `API.md` (raiz) —
  este é o lado em que o San Checkout É o consumidor da Asaas; o
  contrato que o San Checkout oferece a OUTROS projetos é o mesmo
  `API.md`, do outro lado (San Checkout como provedor).

## Serviços mencionados na documentação do ecossistema, fora de escopo direto deste repositório

- **Google Workspace** (e-mail, Drive) — estrutura compartilhada do
  ecossistema (skill `classificar`), não integrada por código neste
  repositório.
- **Cloudflare Web Analytics** — confirmado ativo no domínio
  (auto-injetado, sem cookie), não é uma integração de código, é
  configuração de zona.

## Não confirmado (marcar, não inventar)

- Nome exato do projeto Cloudflare Pages e configuração de build —
  inferido pelo CNAME e pelo check de CI, não lido diretamente na API
  de Pages nesta auditoria.
- Se o "Supabase Preview" (App do GitHub, aparece nas PRs) está
  realmente configurado para branches de preview ou é vestígio de uma
  integração nunca finalizada — apareceu `skipped` no PR mais recente
  auditado.
- Alertas/monitoramento externo (Sentry, Datadog, UptimeRobot, etc.) —
  nenhuma referência encontrada em código, configuração ou variável de
  ambiente. Tratar como inexistente até prova em contrário.
