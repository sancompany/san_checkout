# Current Handoff

## Updated

2026-09-20 (UTC)

## Agent

Claude Code

## Branch

`claude/nifty-meitner-4ffp9s` (sincronizada com `origin/main` em `3c53868`
antes desta tarefa começar — nenhum trabalho de produto pendente antes
desta tarefa)

## Current objective

Preparar o repositório para desenvolvimento e operação colaborativa
entre múltiplos agentes de IA (Claude Code, OpenAI Codex, Google Jules),
criando a infraestrutura persistente `.ia/` como fonte de verdade
compartilhada — pedido explícito do dono, não uma tarefa de produto.

## Current state

Toda a estrutura `.ia/` foi criada e escrita nesta sessão, com base em
auditoria real (não suposição): repositório inteiro, o plugin `san-co`
(9 skills lidas por completo), e verificação read-only ao vivo de
GitHub, Supabase, Cloudflare e Northflank. `AGENTS.md` (raiz) foi
criado; `CLAUDE.md` (raiz) recebeu um cabeçalho apontando para `.ia/`,
sem alterar o conteúdo substantivo existente.

**Ainda não commitado no momento em que este HANDOFF foi escrito pela
primeira vez** — ver "Next task" para os passos finais de validação e
commit que fecham esta tarefa.

## Work completed

- Auditoria do repositório: estrutura, `package.json`, CI
  (`.github/workflows/ci.yml`, `seguranca.yml`), migrations (10
  arquivos), `docs/`, `scripts/`, `tests/` (38 suítes), `src/` completo.
- Auditoria do plugin `san-co` v1.3.0: as 9 `SKILL.md` lidas por
  completo (`novo-projeto`, `classificar`, `leis`, `construir`,
  `depurar`, `revisar`, `checkout`, `seguranca-san`, `legal`) — achado
  central documentado em `CONTROL_PLANE.md`: é puro texto/instrução,
  sem estado próprio, Claude-Code-only por construção.
- Verificação read-only ao vivo (20/09/2026): GitHub (`get_me`, repo
  confirmado), Supabase (`list_projects`, `list_tables` verbose,
  `list_migrations` — projeto `zacuaroarelaqnzjjlcz`), Cloudflare
  (zona `sancocore.com.br`, DNS records via API direta), Northflank
  (`list projects`, `get service` — serviço `san-checkout`).
- Achado de risco durante a verificação: divergência de nomenclatura
  entre `list_migrations` (Supabase) e os arquivos locais — sem dano,
  documentado em `RISKS.md` e `runbooks/supabase.md`.
- Criados todos os arquivos de `.ia/` (ver "Files changed").

## Files changed

**Criados:**
```
.ia/README.md
.ia/CONTEXT.md
.ia/ARCHITECTURE.md
.ia/PROJECT_STATE.md
.ia/CONTROL_PLANE.md
.ia/INTEGRATIONS.md
.ia/ACCESS.md
.ia/AUTONOMY.md
.ia/OPERATIONS.md
.ia/DECISIONS.md
.ia/TODO.md
.ia/RISKS.md
.ia/HANDOFF.md
.ia/AGENT_PROTOCOL.md
.ia/agents/CLAUDE.md
.ia/agents/CODEX.md
.ia/agents/JULES.md
.ia/runbooks/github.md
.ia/runbooks/supabase.md
.ia/runbooks/cloudflare.md
.ia/runbooks/northflank.md
AGENTS.md (raiz, novo)
```

**Atualizados:**
```
CLAUDE.md (raiz) — só um cabeçalho novo apontando para .ia/, conteúdo
                    substantivo preservado integralmente
```

Nenhum arquivo de código (`src/`, `public/`, `tests/`) foi tocado nesta
tarefa — é puramente documentação/infraestrutura de processo.

## External systems touched

**Nenhuma escrita.** Toda verificação foi read-only: `get_me` (GitHub),
`list_projects`/`list_tables`/`list_migrations` (Supabase),
`GET /zones`/`GET /dns_records` (Cloudflare), `list projects`/`get
service`/`list addons` (Northflank).

## Deployments

Nenhum — esta tarefa não toca código de produto, não há deploy
associado.

## Database changes

Nenhuma.

## What is working

Tudo o que já funcionava antes desta tarefa continua igual — nenhuma
mudança de comportamento. A adição é puramente informacional.

## What is not working

Nada quebrado por esta tarefa. Ver `.ia/RISKS.md` para riscos
pré-existentes encontrados (nenhum introduzido).

## Next task

1. **Rodar `npm run check`** para confirmar que nada foi quebrado
   (mudança é só documentação, mas validar é parte do protocolo).
2. **Revisar `.ia/` por completo uma vez** procurando link interno
   quebrado, nome de arquivo inconsistente, ou secret exposto
   acidentalmente (nenhum foi escrito de propósito — conferir mesmo
   assim).
3. **Commitar e dar push** na branch `claude/nifty-meitner-4ffp9s`,
   depois abrir PR — esta tarefa é infraestrutura de processo, não
   caminho de dinheiro, então não está na lista de itens que exigem
   autorização prévia para construir (`AUTONOMY.md`); mesclar segue a
   autorização permanente já existente (CI verde).
4. Depois de mesclada: **a primeira tarefa recomendada para Codex ou
   Jules** é ler `.ia/README.md` → `AGENTS.md` → este `HANDOFF.md`, e
   confirmar de forma independente (no próprio ambiente) quais
   mecanismos de acesso de `ACCESS.md` realmente funcionam por lá —
   fechando o "não verificado" que fica registrado quando um agente
   list a de outro ambiente.

## Known risks

Ver `.ia/RISKS.md` na íntegra. Os dois mais relevantes para quem for
mexer em infraestrutura a seguir: a Global API Key da Cloudflare no
ambiente (acesso à conta inteira, não só este projeto) e a ausência de
staging (todo merge na `main` publica em produção real).

## Do not undo

- Não reverter a autorização de merge automático com CI verde
  (`CLAUDE.md` raiz, "Mesclar é decisão tomada") — decisão do dono,
  anterior a esta tarefa.
- Não editar o conteúdo do plugin `san-co` em si (fora deste
  repositório) — governança dele é "só a sessão de manutenção edita",
  documentado em `CONTROL_PLANE.md`.
- Não trocar a credencial Cloudflare por um token escopado como efeito
  colateral de uma tarefa não relacionada — é melhoria registrada
  (`RISKS.md`, `DECISIONS.md` ADR-007), não uma correção urgente.

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

Esta tarefa foi deliberadamente **só documentação/infraestrutura de
processo** — nenhuma mudança de comportamento do produto. O valor dela
só se realiza se `.ia/` for de fato mantido daqui para frente: toda
tarefa futura relevante deveria terminar atualizando pelo menos este
`HANDOFF.md`, e `PROJECT_STATE.md`/`TODO.md`/`RISKS.md`/`DECISIONS.md`
quando aplicável. Um `.ia/` que para de ser atualizado depois de uma
sessão vira exatamente o problema que ele foi criado para evitar —
documento desatualizado é pior que ausente, porque gera confiança
falsa (mesma lição já registrada em `CLAUDE.md` raiz sobre o `CLAUDE.md`
em si).

A auditoria do plugin `san-co` (`CONTROL_PLANE.md`) é o achado mais
importante desta tarefa: ele é fundamentalmente Claude-Code-only, então
"integrar Codex e Jules à metodologia" não é uma tarefa de configuração
— é uma tarefa de **desenho** (que informação deve existir como arquivo
comum vs. como skill exclusiva). Isso não foi decidido nem implementado
aqui de propósito (era fora do escopo pedido) — está mapeado como
roadmap em `CONTROL_PLANE.md` e `TODO.md`, seção "PLUGIN / CONTROL
PLANE", para uma tarefa futura explícita.
