# Runbook — Cloudflare

**Sem `wrangler` CLI instalado** neste ambiente, e **sem MCP dedicado**
(confirmado por busca nesta auditoria — 20/09/2026). O único mecanismo
confirmado é a **API REST direta**, autenticada por Global API Key.

## ⚠️ Credencial: Global API Key, não token escopado

O ambiente tem `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` (mais
`CLOUDFLARE_ACCOUNT_ID`). Esse par é a **Global API Key** — dá acesso
total à conta Cloudflare inteira, não só a este projeto. É a exceção de
segurança já registrada em `CONSTRAINTS.md` (raiz) §3, "Lei 3 · a
credencial do Cloudflare no ambiente é a conta inteira — 14/09/2026".

Regras, sem exceção:
- **Nunca imprimir, logar ou escrever o valor** em arquivo, commit,
  saída de comando exibida sem necessidade, ou nesta documentação.
- Preferir, quando a operação permitir, um token escopado — mas **não
  quebrar a integração existente só para trocar de credencial durante
  uma tarefa não relacionada a isso**. Ver `RISKS.md` para o registro
  formal desse risco aceito.
- Qualquer chamada usa `X-Auth-Email` + `X-Auth-Key` nos headers, nunca
  `Authorization: Bearer`.

```bash
# padrão de toda chamada read-only abaixo
curl -sS "https://api.cloudflare.com/client/v4/<endpoint>" \
  -H "X-Auth-Email: $CLOUDFLARE_EMAIL" \
  -H "X-Auth-Key: $CLOUDFLARE_API_KEY"
```

## Conta e zona

Confirmado nesta auditoria: conta identificada por `CLOUDFLARE_ACCOUNT_ID`
(nome não impresso aqui, ver painel). Zona confirmada:

| Zona | Zone ID | Status |
|---|---|---|
| `sancocore.com.br` | `64c4d0823e2883586cdbb7cfe02dacf4` | `active` |

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones" \
  -H "X-Auth-Email: $CLOUDFLARE_EMAIL" -H "X-Auth-Key: $CLOUDFLARE_API_KEY"
```

## DNS

```bash
curl -sS "https://api.cloudflare.com/client/v4/zones/64c4d0823e2883586cdbb7cfe02dacf4/dns_records?per_page=100" \
  -H "X-Auth-Email: $CLOUDFLARE_EMAIL" -H "X-Auth-Key: $CLOUDFLARE_API_KEY"
```

Registros confirmados relevantes a este repositório (20/09/2026):

| Tipo | Nome | Destino | Proxiado |
|---|---|---|---|
| CNAME | `api.sancocore.com.br` | `....san-rp22.dns.northflank.app` | **não** (DNS-only, deliberado) |
| CNAME | `checkout.sancocore.com.br` | `san-checkout.pages.dev` | sim |
| MX | `sancocore.com.br` | `smtp.google.com` | — |
| TXT | `sancocore.com.br` | `v=spf1 include:_spf.google.com ~all` | — |
| TXT | `_dmarc.sancocore.com.br` | `v=DMARC1; p=reject;` | — |

Outros registros na mesma zona (`humano.sancocore.com.br`,
`mostrai.sancocore.com.br`, `www.sancocore.com.br`, raiz) pertencem a
**outros projetos**, não a este repositório — não verificados por esta
auditoria e não alterar a partir daqui.

## Cloudflare Pages

`checkout.sancocore.com.br` é servido por um projeto Cloudflare Pages
(`san-checkout`) que faz **deploy automático via GitHub App** ligado a
este repositório — confirmado pelo check `Cloudflare Pages` que aparece
em todo PR (não há workflow nem `wrangler.toml` neste repositório; a
configuração vive inteiramente do lado do Cloudflare). Publica o
conteúdo estático de `public/` sem passo de build.

```bash
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects" \
  -H "X-Auth-Email: $CLOUDFLARE_EMAIL" -H "X-Auth-Key: $CLOUDFLARE_API_KEY"
```

Não exercitado nesta auditoria (evitar chamada desnecessária contra
conta inteira sem necessidade concreta) — confirme o nome exato do
projeto Pages antes de assumir.

## Cloudflare Access

Protege `/admin` e `/admin.html` em produção (`CONSTRAINTS.md` raiz
§2.6). Verificação, armadilhas e por que a origem precisa ficar
DNS-only estão documentadas ali e em `docs/erros/2026-09-12-o-cloudflare-access-sumiu-da-frente-do-admin.md`.
Painel é a forma de conferir política — não há endpoint de API
exercitado nesta auditoria para isso.

## Workers, R2, KV, D1, Tunnels

**Não confirmado uso neste projeto.** Nenhuma referência encontrada em
`src/`, `public/`, configuração ou DNS. Se uma tarefa futura precisar de
qualquer um desses, confirme primeiro que não é reinvenção de algo que
já existe como estrutura compartilhada (skill `classificar`).

## Web Analytics

Confirmado em uso (`CLAUDE.md` raiz, 17/09/2026): Cloudflare Web
Analytics, injetado pela própria Cloudflare (não aparece como `<script>`
no HTML), sem cookie. `auto_install` confirmado pela API naquela
ocasião — endpoint não re-exercitado nesta auditoria.
