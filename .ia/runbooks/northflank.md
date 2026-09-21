# Runbook — Northflank

CLI confirmado instalado e autenticado nesta sessão (20/09/2026):
`northflank` v0.13.0, via `NORTHFLANK_TOKEN` no ambiente. Existe também o
plugin/skill oficial `northflank:northflank` (comandos de deploy, banco
e preview) — usar quando disponível; os comandos abaixo são os
confirmados por execução direta nesta auditoria e funcionam sem ele.

Projetos confirmados na conta (20/09/2026): `san-checkout` (este
repositório) e `mostrai` (outro projeto, não relacionado — não mexer a
partir daqui).

## Projeto e serviço

```bash
northflank list projects -o json
northflank list services --project san-checkout -o json
northflank get service --project san-checkout --service san-checkout -o json
```

Serviço confirmado: `san-checkout`, tipo `combined` (build + deploy do
mesmo serviço), branch de build `main`, porta interna `3001` (nome da
porta: `pay`), região `nf-southamerica-east`.

## Deploy atual (SHA servido)

```bash
northflank get service --project san-checkout --service san-checkout -o json \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['deployment']['internal']['deployedSHA'])"
```

É o único jeito confiável de saber "o que está no ar agora" — nunca
escrever esse SHA num documento prosa (ele envelhece a cada deploy
novo e o documento nasce falso, lição já registrada em `CLAUDE.md`
raiz). Comparar com `git log origin/main -1 --format=%H` para confirmar
que bate com a `main`.

## Variáveis de ambiente / runtime

```bash
# lista os NOMES — cuidado: o comando abaixo pode incluir VALORES se a
# permissão do token alcançar; não rode se não tiver certeza de como o
# output será tratado. Prefira ler só os nomes já conhecidos via
# .env.example e RUNBOOK.md (raiz), seção 1.2, em vez de puxar valores.
northflank get service runtime-environment --project san-checkout --service san-checkout
```

Nomes confirmados em uso (não os valores — ver `.env.example` e
`RUNBOOK.md` raiz §1.2/§5): `ASAAS_API_KEY`, `ASAAS_AMBIENTE`,
`ASAAS_WEBHOOK_TOKEN`, `PORT`, `ORIGEM_FRONTEND`, `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `TAXA_PERCENTUAL`, `TAXA_FIXA`,
`CHECKOUT_ADMIN_USER`, `CHECKOUT_ADMIN_PASS_HASH`, `NODE_ENV` (confirmado
`production` via `get service`).

## Logs

```bash
northflank get service --help | grep -i log
# northflank get service-logs --project san-checkout --service san-checkout
```

Comando exato não exercitado nesta auditoria — confirme com `--help`
antes de usar, e prefira o painel Northflank para leitura de log extensa
(volume alto polui o contexto do agente).

## Executar comando dentro do container em produção

Padrão já em uso neste repositório (ver `docs/erros/` e histórico em
`CLAUDE.md` raiz) para rodar verificação sem que segredo saia do
container:

```bash
northflank upload service file --project san-checkout --service san-checkout \
  --local <arquivo-local> --remote /tmp/<nome>
northflank exec service --project san-checkout --service san-checkout \
  --cmd "node /tmp/<nome>"
```

Script deve importar módulos da aplicação por **caminho absoluto**
(`/app/src/...`), nunca relativo — ele roda a partir de `/tmp`, fora da
árvore do projeto.

## Health check

```bash
curl -sS https://api.sancocore.com.br/api/saude
```

Confirmado 20/09/2026: `200`, `{"status":"ok","supabaseRespondendo":true,...}`.

## Domínio

`api.sancocore.com.br` aponta (CNAME, **DNS-only, não proxiado pela
Cloudflare**) para o endereço gerado pela Northflank
(`api.sancocore.com.br.san-rp22.dns.northflank.app`) — decisão registrada
(a API é pública por desenho, `docs/erros/2026-09-14-origem-direta-alcancavel-por-fora.md`).
Ver `.ia/ACCESS.md` e `runbooks/cloudflare.md` para a configuração DNS
completa.

## Restart / rollback

**Não exercitado nesta auditoria.** `RUNBOOK.md` (raiz), seções "3.
Publicar" e "4. Reverter", tem o procedimento textual — confirme os
comandos exatos ali antes de executar, e trate como operação de cautela
(afeta produção) mesmo sendo reversível.

## Addons (bancos gerenciados pela Northflank)

```bash
northflank list addons --project san-checkout -o json
```

Confirmado: **vazio**. O banco deste projeto é o Supabase externo, não
um addon Northflank — não crie um addon sem decisão explícita do dono.
