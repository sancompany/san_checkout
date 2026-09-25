# Current Handoff

## Updated

2026-09-22 (UTC)

## Agent

Claude Code

## Branch

`claude/nifty-meitner-4ffp9s` (reconstruída a partir de `origin/main`
depois de cada PR mesclada nesta sessão — é assim que este projeto trata
"branch cuja PR já mesclou": nunca empilha em cima de história já
mesclada, recomeça de `main`)

## Current objective

Verificar e corrigir os 22 achados de uma auditoria técnica externa
(Codex, sem acesso a este repositório — o dono repassou o relatório em
texto), rodada sobre o código do caminho do dinheiro (checkout,
estorno, assinatura, migrations). Nenhum achado aceito só pela palavra
do relatório — cada um lido contra o código real antes de decidir
corrigir ou declarar.

## Current state

**PR #39 mesclada** (`b8111e1`): três corridas reais no caminho do
dinheiro corrigidas — Pix/Boleto duplicado (AUD-001), estorno duplicado
(AUD-007), cancelar/pausar/retomar assinatura sem guarda nenhuma
(AUD-005). A revisão automática do Codex sobre a própria PR achou um
furo DENTRO da correção do AUD-001 (`criarCobrancaPix` faz duas
chamadas à Asaas; uma falha limpa na segunda liberava a reserva com o
pagamento já criado) — corrigido antes de mesclar.

**PR #40 aberta** (verificação dos 19 achados restantes): dois
corrigidos (AUD-017, vocabulário fechado sem `check` no banco —
migration 0014; SUS-004, migration 0009 ausente do histórico do
Supabase — replay seguro), quatro já cobertos por trabalho anterior
(AUD-006/008/009/012), o resto declarado com caminho de fechamento em
`docs/pendencias.md` (AUD-004 exige checar o painel da Asaas; SUS-002 e
a ausência de fencing token no arrendamento por tempo são reais mas
baixa severidade).

## Work completed

- **PR #38** (mesclada antes desta sessão continuar): dois achados
  confirmados e corrigidos — escrita local engolida depois de cobrança
  real na Asaas.
- **PR #39** (mesclada, `b8111e1`): AUD-001 (reserve-then-charge em
  `gerarPix`/`gerarBoleto`, `checkoutController.js` migrado pro padrão
  de fábrica com `deps`), AUD-007 (CAS no estorno, migration 0013 —
  `cobrancas.estornando_em`), AUD-005 (lease comum em cancelar/pausar/
  retomar, reaproveitando `assinaturas.trocando_em` que antes era
  exclusivo da troca de plano — `assinaturaController.js` ganhou seu
  primeiro autoteste). Suíte: 43 → 46.
- **PR #40** (aberta, aguardando CI): AUD-017 (migration 0014 — `check`
  em `cobrancas.status`/`metodo_pagamento`/`assinaturas.status`/
  `ciclo`; a primeira enumeração de `cobrancas.status` estava
  incompleta, corrigida ANTES de aplicar depois de um `select distinct`
  contra produção achar `expirado` fora do conjunto lido só do código),
  SUS-004 (migration 0009 registrada no histórico do Supabase via
  replay idempotente — as colunas já existiam em produção desde 17/09,
  só o registro no tracking faltava).

## Files changed

Ver os diffs das PRs #39 e #40 no GitHub — lista completa não repetida
aqui de propósito (haveria dessincronia garantida). Resumo por área:

- `src/controllers/checkoutController.js`, `refundController.js`,
  `assinaturaController.js` — padrão de fábrica com `deps`, guardas de
  corrida.
- `src/services/asaasService.js`, `cobrancaService.js`,
  `assinaturaService.js` — `foiRecusaLimpaDaAsaas` (compartilhada),
  `reivindicarEstorno`/`liberarEstorno`, doc de `reivindicarTroca`
  ampliada.
- `supabase/migrations/0013_lease_de_estorno.sql`,
  `0014_vocabulario_fechado_no_banco.sql` — novas.
- `docs/erros/2026-09-22-*.md` — seis arquivos, um por achado fechado.
- `docs/pendencias.md`, `docs/funcional.md` (RN-37/38),
  `docs/ciclo-assinatura-mapa.md`, `API.md` §5.4/§5.5 — documentação.
- `CLAUDE.md` (raiz) — jornal de 22/09.

## External systems touched

- **Supabase** (`zacuaroarelaqnzjjlcz`): duas migrations aplicadas via
  MCP (`0013_lease_de_estorno`, `0014_vocabulario_fechado_no_banco`) e
  um replay idempotente da 0009 pra registrar no histórico. Todas
  verificadas contra dados reais (`select distinct`/`count(*)` por
  coluna) ANTES de aplicar — a verificação da 0014 achou um erro na
  minha própria primeira enumeração antes de ele virar `ALTER TABLE`.
- **GitHub**: PRs #39 (mesclada) e #40 (aberta), replies a review
  comments do Codex, threads resolvidas.

## Deployments

PR #39 mesclada → deploy automático em produção (Northflank + Cloudflare
Pages), CI verde é a porta (`CLAUDE.md`, "Mesclar é decisão tomada").
PR #40 ainda não mesclada no momento em que este HANDOFF foi escrito.

## Database changes

- Migration 0013 (`cobrancas.estornando_em`) — no ar via PR #39.
- Migration 0014 (`check` em quatro colunas) — aplicada diretamente via
  Supabase MCP, no ar antes mesmo do merge da PR #40 (constraint
  aditiva, sem risco de reverter comportamento).
- Migration 0009 — sem mudança de schema, só passou a aparecer no
  histórico do Supabase (estava aplicada desde 17/09, sem estar
  registrada lá).

## What is working

Tudo que a suíte cobre (67 suítes, `npm test`/`npm run check` verdes em
cada commit) e o que foi conferido ao vivo contra produção antes de
cada `ALTER TABLE` (ver "External systems touched").

## What is not working

Nada quebrado por este trabalho — só achados PRÉ-EXISTENTES,
documentados como corrigidos ou declarados (nunca "quebrado por esta
tarefa"). Ver `docs/pendencias.md` pelas entradas de 22/09 para o que
ficou declarado (AUD-004: sendType do webhook da Asaas não verificado;
SUS-002: corrida em `buscarOuCriarCliente`, baixa severidade; ausência
de fencing token no arrendamento por tempo).

## Next task

1. **Fechar a PR #40**: aguardar CI verde e mesclar (autorização
   permanente, `CLAUDE.md` raiz). Responder/resolver qualquer achado
   novo de revisão automática antes — nenhum ficou pendente até este
   HANDOFF ser escrito.
2. **AUD-004** (webhook fora de ordem) precisa de alguém com acesso ao
   painel da Asaas ou ao container de produção pra conferir o `sendType`
   configurado (`GET /v3/webhooks`) — só o dono ou um agente com essa
   credencial fecha isso. Caminho completo em `docs/pendencias.md`.
3. Depois de #40 mesclada: **`.ia/PROJECT_STATE.md` está desatualizado**
   (última verificação 20/09) — não bloqueia nada, porque o próprio
   arquivo é desenhado pra ser reconfirmado por comando, não por
   confiança no texto, mas vale uma passada quando a próxima tarefa
   mexer em algo que ele descreve.

## Known risks

Ver `.ia/RISKS.md` — inalterado por esta tarefa. Nada novo introduzido;
achados da auditoria externa que não foram corrigidos viraram entradas
em `docs/pendencias.md` (a lista de trabalho do projeto), não em
`RISKS.md` (que é sobre risco de infraestrutura/acesso, escopo
diferente).

## Do not undo

- Não reverter a autorização de merge automático com CI verde
  (`CLAUDE.md` raiz, "Mesclar é decisão tomada").
- Não editar o conteúdo do plugin `san-co` em si — só a sessão de
  manutenção do plugin edita skill.
- Não reabrir PR #38 ou #39 (já mescladas) — trabalho de acompanhamento
  vira PR nova, nunca commit em cima de história já mesclada (é assim
  que este HANDOFF trata "branch cujo PR já fechou", ver "Branch"
  acima).
- Não silenciar/pular achado de auditoria por parecer pequeno —
  verificar contra o código real e contra dados de produção antes de
  decidir "declarar" em vez de "corrigir" (a lição de 22/09: uma
  enumeração de vocabulário lida só do código estava incompleta, e só
  um `select distinct` contra produção achou o erro antes de ele virar
  `ALTER TABLE` em produção).

## Useful commands

```bash
git status --short && git log -5 --oneline
npm run check
curl -sS https://api.sancocore.com.br/api/saude
northflank get service --project san-checkout --service san-checkout -o json
```

## Verification commands

```bash
# confirmar que nenhum secret foi escrito em .ia/
grep -rniE "api[_-]?key\s*=\s*['\"a-z0-9]{10,}|-----BEGIN|sk_live|sk_test" .ia/ || echo "limpo"

# confirmar que todo link interno .ia/ aponta para arquivo existente
grep -roE '\.ia/[A-Za-z0-9_./-]+\.md' .ia/*.md .ia/agents/*.md .ia/runbooks/*.md AGENTS.md CLAUDE.md 2>/dev/null \
  | cut -d: -f2 | sort -u | while read f; do [ -f "$f" ] || echo "QUEBRADO: $f"; done
```

## Notes for next agent

Este HANDOFF ficou parado em 20/09/2026 (a tarefa de criar `.ia/`)
enquanto três PRs de código passaram por aqui sem atualizá-lo — achado
por revisão automática do Codex na PR #40, e a lição bate com o aviso
que a versão anterior deste mesmo arquivo já deixava escrito: "um
`.ia/` que para de ser atualizado depois de uma sessão vira exatamente
o problema que ele foi criado para evitar". Regra prática: **toda PR
que mexe em código ou schema termina atualizando este arquivo**, não só
tarefas de infraestrutura de processo — é fácil esquecer quando o foco
está no código, e é exatamente por isso que esquecer aconteceu aqui.

A auditoria do plugin `san-co` (`CONTROL_PLANE.md`, escrita em 20/09)
continua válida e não foi tocada por este trabalho — ele é
fundamentalmente Claude-Code-only, e "integrar Codex e Jules à
metodologia" segue como tarefa de desenho futura, mapeada em
`CONTROL_PLANE.md` e `TODO.md`.
