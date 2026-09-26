# Current Handoff

## Updated

2026-09-26 (UTC)

## Agent

Claude Code

## Branch

`claude/nifty-meitner-4ffp9s`, reconstruída a partir de `origin/main`
depois de cada PR mesclada nesta sessão. É assim que este projeto trata
uma branch cuja PR já mesclou: nunca empilha em cima de história já
mesclada, recomeça de `main`.

## Current objective

Estação 7 (Lançamento), parte jurídica: consolidar Termos de Uso,
Política de Privacidade e inventário de dados contra o sistema real,
antes do lançamento. A parte técnica da Estação 7 já está concluída
(PR #63).

## Current state

**PR #64 aberta, CI verde, esperando a aprovação do dono para
mesclar.** A tarefa mandava entregar o relatório e o diff antes do
merge. Mesclar publica, porque a `main` vai para produção sozinha.

- Termos v3 e Política v4 escritos; as versões anteriores estão
  arquivadas byte a byte em `docs/legal-arquivado/`.
- Inventário refeito campo a campo contra o banco de produção.
- Relatório com 16 divergências, matriz e fontes:
  `docs/CONSOLIDACAO_JURIDICA_ESTACAO_7_2026-09-26.md`.

## Work completed

Em 26/09/2026, em ordem:

1. **Estação 6 fechada** por decisão do dono. A homologação real usou
   só os pagamentos já recebidos.
2. **Parte técnica da Estação 7** (PR #63, mesclada, `d1af4a5` no ar):
   - migration 0020 aplicada pelo MCP do Supabase, com aprovação do
     dono, e validada: `anon`/`authenticated` sem privilégio, e o
     `service_role` funcionando;
   - health check do Northflank configurado como readiness TCP na porta
     3001, sem liveness (`RUNBOOK` §6.3);
   - admin pelo Access e itens do operador no RUNBOOK feitos pelo dono.
3. **Consolidação jurídica** (PR #64, aberta). Nenhum código alterado.

## Files changed

PR #64:

- `public/termos.html` e `public/privacidade.html`
- `docs/inventario-de-dados.md`
- `docs/legal-arquivado/`: duas cópias novas e o `README.md`
- `docs/CONSOLIDACAO_JURIDICA_ESTACAO_7_2026-09-26.md` (novo)
- `API.md` §2.0 e §8
- `CONSTRAINTS.md`: retenção, "sem split" e Lei 10
- `RUNBOOK.md` §1.1, §8.1 e §9
- `docs/funcional.md` §8
- `docs/pendencias.md`
- `CLAUDE.md`
- `.ia/DECISIONS.md`: ADR-006 revisto
- este arquivo
- comentário em `public/status.html`

## External systems touched

Só leitura, nesta tarefa:

- Supabase: colunas, RLS e região;
- Northflank: região do projeto;
- DNS público: MX e TXT;
- cabeçalhos das páginas em produção;
- fontes oficiais: Planalto, ANPD e Ministério da Justiça, Banco
  Central, Cloudflare e Google.

Nenhuma escrita em serviço externo.

## Deployments

Nenhum nesta tarefa. Produção segue em `d1af4a5` (PR #63).

## Database changes

Nenhuma. A migration 0020 foi aplicada na tarefa anterior e é a última.

## What is working

Produção saudável em `d1af4a5`: `/api/saude` responde 200, com
`workersAtrasados: []` e as filas zeradas. `npm run check` roda as 82
suítes, e `npm run acessibilidade` não acusa violação, legais incluídas.

## What is not working

Nada quebrado. Estão em aberto, declarados, e nenhum deles é bug:

- **REGULATORY_VALIDATION_REQUIRED:** o fluxo sem split, em que o
  dinheiro cai na conta PF do operador e o repasse é manual. Vira
  bloqueio antes de receber para um Lojista de outro titular.
- **ACCOUNTING_VALIDATION_REQUIRED:** a emissão fiscal pela taxa do
  checkout, e a contagem fiscal dos 5 anos (CTN art. 173, I).
- **LEGAL_REQUIRES_TECH_CHANGE:** três rotinas de expurgo que não
  existem, para `intencoes_troca_plano`, `clientes_asaas` e `subcontas`
  (`docs/inventario-de-dados.md` §1.3, §1.4 e §6.3).
- **Aceite dos documentos não gravado** no servidor. É decisão de
  produto, do dono (`docs/inventario-de-dados.md` §8).

## Next task

1. Dono aprova e mescla a PR #64. Depois, conferir o deploy
   (`deployedSHA` igual ao da `main`) e as páginas `/termos` e
   `/privacidade` no ar.
2. Varredura final da Estação 7, em duas rodadas
   (`references/varredura-final.md` do plugin `san-co`).
3. Entrega de manutenção ao dono: o que renova, o que vence (domínio em
   31/08/2027), o que é só dele.
4. As rotinas de expurgo exigidas pelo jurídico, quando o dono
   autorizar código.

## Known risks

Ver `.ia/RISKS.md`. O risco novo desta tarefa é regulatório, não de
infraestrutura, e está no relatório de consolidação, §4, e em
`CONSTRAINTS.md` §3 ("sem split").

## Do not undo

- Não reverter a autorização de merge automático com CI verde
  (`CLAUDE.md` raiz, "Mesclar é decisão tomada"). **Exceção desta
  tarefa:** a PR #64 espera o dono, por ordem dele.
- Não reutilizar o CNPJ da v1 em documento vigente. Ele pertence a outra
  atividade (decisão do dono, 26/09/2026).
- Não reescrever os arquivos de `docs/legal-arquivado/`: são o texto
  exato que esteve publicado.
- Não editar o conteúdo do plugin `san-co` em si. Só a sessão de
  manutenção do plugin edita skill.
- Não reabrir PR já mesclada. Trabalho de acompanhamento vira PR nova.

## Useful commands

```bash
git status --short && git log -5 --oneline
npm run check
npm run acessibilidade
curl -sS https://api.sancocore.com.br/api/saude
northflank get service --projectId san-checkout --serviceId san-checkout --output json
```

## Verification commands

```bash
# confirmar que nenhum secret foi escrito em .ia/
grep -rniE "api[_-]?key\s*=\s*['\"a-z0-9]{10,}|-----BEGIN|sk_live|sk_test" .ia/ || echo "limpo"

# confirmar que todo link interno .ia/ aponta para arquivo existente
grep -roE '\.ia/[A-Za-z0-9_./-]+\.md' .ia/*.md .ia/agents/*.md .ia/runbooks/*.md AGENTS.md CLAUDE.md 2>/dev/null \
  | cut -d: -f2 | sort -u | while read f; do [ -f "$f" ] || echo "QUEBRADO: $f"; done

# documentos vigentes sem o CNPJ antigo e sem a transição para PJ
grep -n "68.949.029" public/*.html docs/inventario-de-dados.md API.md || echo "limpo"
```

## Notes for next agent

Este arquivo ficou parado em 22/09/2026 enquanto a Estação 6 inteira e
a parte técnica da Estação 7 passavam por aqui. Quem achou foi a
revisão automática do Codex na PR #64, e é a segunda vez que isso
acontece (a primeira foi na PR #40). A regra continua: **toda PR que
mexe em código, schema ou documento legal termina atualizando este
arquivo.**

Documento legal aqui se escreve contra o sistema, não contra a
lembrança dele. A consolidação de 26/09 achou dois terceiros sem
declaração só porque olhou a CSP e o `public/js/`. Ela também achou um
"hash irreversível" que não era, só porque leu a chamada de
`createHash`.
