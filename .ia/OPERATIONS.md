# Modelo operacional

Todo comando abaixo foi confirmado existir no `package.json` deste
repositório (20/09/2026) — não inventado.

## Desenvolvimento local

```bash
npm install
cp .env.example .env      # preencher os valores reais, nunca commitar
npm start                  # node src/server.js
```

Requer Node ≥22 (`.nvmrc` fixa a versão exata). Sem passo de build para
o front — `public/` é servido como está; um servidor estático simples
(ou a própria origem do backend, checar `src/server.js`) entrega os
arquivos.

## Validação — a mesma porta que o CI roda

```bash
npm run check     # scripts/checar.mjs (sintaxe de TODO JS, inclusive public/js/) + npm test
npm test           # só as suítes (tests/executar.js) — 38 suítes em 20/09/2026
```

**Sempre rodar `npm run check`, não só `npm test`**, antes de propor uma
mudança — `npm test` sozinho não analisa a sintaxe de `public/js/`, e
essa lacuna já deixou um erro de sintaxe no código do comprador passar
pelo portão que autoriza o deploy (`docs/erros/`, 18/09/2026).

## Verificações que exigem navegador (fora do CI, que não tem Chromium)

```bash
npm run acessibilidade   # scripts/acessibilidade.mjs — axe-core, WCAG 2.2 AA
npm run desempenho        # scripts/desempenho.mjs — LCP/INP/CLS, funil de celular simulado, orçamento de imagem
```

Rodar quando a mudança tocar HTML/CSS/JS de `public/` ou imagem nova.

## Lint / typecheck

Não há linter nem typechecker configurado separadamente — `scripts/checar.mjs`
cobre a análise de sintaxe. Não introduzir ESLint/TypeScript sem decisão
explícita (mudança de stack está na lista de cautela, `AUTONOMY.md`).

## Build

**Não existe passo de build.** Backend roda `src/server.js` diretamente
via Node; front é servido tal como está em `public/`. Não crie um passo
de build "para consistência" sem necessidade concreta — vai contra a
escada de simplicidade do projeto (skill `construir`).

## Deploy

Automático a cada push/merge na `main`:

- **Backend**: Northflank builda a imagem (`Dockerfile`) e faz deploy do
  serviço `san-checkout`. Sem workflow neste repositório para isso —
  configuração vive do lado da Northflank (gatilho ligado à branch
  `main`).
- **Front**: Cloudflare Pages builda e publica `public/` via GitHub App
  — também sem workflow neste repositório.
- **Porta de qualidade**: CI verde (`.github/workflows/ci.yml`, roda
  `npm run check`) é a condição — não uma aprovação humana
  (`CLAUDE.md` raiz, "Mesclar é decisão tomada").

Verificar deploy efetivo:
```bash
git log origin/main -1 --format=%H
northflank get service --project san-checkout --service san-checkout -o json \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['deployment']['internal']['deployedSHA'])"
curl -sS https://api.sancocore.com.br/api/saude
```

## Rollback

Documentado em `RUNBOOK.md` (raiz), seção "4. Reverter" — não repetido
aqui porque envolve `git revert <sha>` contra um SHA que precisa ser
identificado no momento (nunca escrito em prosa fixa, pelo motivo já
registrado: a linha que afirma o SHA muda o SHA que ela mesma afirma).
Confirmar o procedimento exato ali antes de executar.

## Logs

Ver `runbooks/northflank.md` (aplicação) e `runbooks/github.md` (CI).
Não há agregador de log externo confirmado — ver `RISKS.md`.

## Banco / migrations

```bash
ls supabase/migrations/                       # lista real de arquivos
```

Aplicar migration nova exige decisão prévia (schema é lista de cautela
em `AUTONOMY.md`) — uma vez decidida:
```bash
supabase db push        # CLI, projeto linkado
```
Ou via MCP `mcp__Supabase__apply_migration`, quando disponível. **Nunca
editar uma migration já aplicada** — regra fixa do projeto
(`CONSTRAINTS.md` §2.1, "migrations numeradas e imutáveis").

Verificar schema real (não confiar no nome do arquivo — ver a
divergência registrada em `runbooks/supabase.md` e `RISKS.md`):
```
mcp__Supabase__list_tables(project_id="zacuaroarelaqnzjjlcz", schemas=["public"], verbose=true)
```

## Restauração de backup — ensaiada, não é teórica

```bash
npm run ensaio-restauracao   # scripts/ensaio-restauracao.sh
```

Sobe um Postgres local da mesma major da produção, aplica migrations,
carrega dados e compara em cinco níveis contra o banco no ar. RTO
medido de ~1s (registrado em `CLAUDE.md` raiz, 17/09/2026). Ver
`RUNBOOK.md` §6 para o procedimento completo de restauração real.

## Expurgo de dado pessoal (Lei 10 / LGPD)

```bash
npm run expurgo               # scripts/expurgo.mjs
```

Lista branca do que fica após anonimizar está em
`src/services/expurgoService.js` — qualquer coluna nova em `cobrancas`
ou `assinaturas` precisa entrar nessa lista na mesma migration que a
cria (lição registrada depois de um bug real,
`docs/erros/2026-09-18-a-migration-que-acrescentou-coluna-not-null-nao-atualizou-a-lista-branca-do-expurgo.md`).

## Limpeza de dado de teste / troca sandbox → produção

```bash
npm run limpar-teste          # scripts/limpar-registros-de-teste.mjs
```

Usado no procedimento de troca da Asaas de sandbox para produção real
— `RUNBOOK.md` §6.2 tem o passo a passo completo (ainda não executado
neste projeto, é pendência do dono).

## Troubleshooting — por onde começar

1. `curl -sS https://api.sancocore.com.br/api/saude` — sistema
   respondendo e Supabase acessível?
2. `northflank get service ...` → `deployedSHA` bate com `main`?
3. Tabela `erros` no Supabase — captura de exceção agregada (Lei 8).
4. `docs/erros/` — o bug já aconteceu antes e está catalogado?
5. `RUNBOOK.md` (raiz), seção "6.1 Onde olhar quando algo quebrou" —
   guia mais extenso, não duplicado aqui.

Ver também `.ia/CONTROL_PLANE.md`/skill `depurar` para o método de
achar causa raiz (reproduzir → ler o erro completo → bisseção → checar
todos os chamadores → corrigir na raiz → deixar uma guarda/teste).
