# Instruções específicas — Claude Code

Base: `AGENT_PROTOCOL.md`. Este arquivo só cobre o que é diferente para você.

## O que você tem que os outros não têm

- **O plugin `san-co`**, carregado via marketplace (`.claude/settings.json`).
  Ele empacota a metodologia deste ecossistema (esteira de sete estações,
  onze leis, skills de revisão e segurança) como `Skill`s que entram no seu
  contexto sob demanda. `CONTROL_PLANE.md` documenta a fundo o que ele é e
  onde ele falha. **`ListPlugins` vazio no início da sessão significa que
  o plugin não carregou** — já custou uma estação fechada errado
  (`docs/erros/2026-09-13-fechei-uma-estacao-contra-a-parafrase-da-lei.md`).
  Sem ele carregado, ou clone `sancompany/Plugin_san-co` e leia de lá, ou
  trabalhe só pelo `.ia/` e pelo `CLAUDE.md` da raiz — nunca pela sua
  lembrança de uma sessão anterior de como uma skill funciona.
- **`CLAUDE.md` na raiz** é lido automaticamente no início da sessão — é o
  diário de bordo denso e específico do processo `san-co`. Ele continua
  sendo a referência para "que skill rodar" e para o histórico dia-a-dia
  de decisões do dono. `.ia/` não o substitui, complementa: leia os dois.
- **MCP tools** para GitHub e Supabase (`mcp__github__*`, `mcp__Supabase__*`)
  — confirmados funcionando nesta sessão. Ver `ACCESS.md` para o que cada
  um alcança e `runbooks/` para uso concreto.
- **Northflank CLI** (`northflank`) instalado e autenticado — comandos
  confirmados em `runbooks/northflank.md`. Existe também o plugin/skill
  `northflank:northflank` (marketplace oficial da Northflank) para deploy,
  banco e ambiente de preview — ele não disputa autoridade de processo com
  o `san-co` (README do plugin, seção "Skills"), só entrega comandos.
- **Cloudflare via API direta** — sem CLI (`wrangler` não instalado), sem
  MCP dedicado. `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` no ambiente são
  **Global API Key** (acesso à conta inteira, não escopado) — trate como
  altamente sensível, nunca logue os valores, nunca os escreva em arquivo.
  Comandos confirmados (`curl` read-only) em `runbooks/cloudflare.md`.

## Comportamento esperado

- **Use as ferramentas disponíveis antes de pedir operação manual.** Você
  tem CLI/API/MCP para os quatro serviços principais — não peça ao dono
  "qual é o deploy atual" ou "quais migrations foram aplicadas" quando
  você mesmo consegue descobrir (`AUTONOMY.md` tem a sequência exata).
- **Siga as práticas de commit/PR/branch já em uso neste repositório**
  (`CLAUDE.md` raiz, seção de commits) — trailers de atribuição, branch
  própria, PR com CI verde antes de mesclar. Isso já está estabelecido e
  não muda com esta tarefa.
- **A skill `revisar` e a skill `seguranca-san`** continuam sendo a régua
  de qualidade deste repositório para qualquer mudança que toque dinheiro,
  senha, documento pessoal ou área administrativa — mesmo em uma tarefa
  como esta, que não é código de produto.

## O que NÃO fazer

- Não reescreva o plugin `san-co` por conta própria — a governança dele
  ("só a sessão de manutenção edita skills") está descrita em
  `CONTROL_PLANE.md` e continua valendo.
- Não confie em memória de sessões anteriores sobre estado de infra —
  toda afirmação sobre deploy atual, schema atual ou variável configurada
  se reconfirma pela fonte (`AGENT_PROTOCOL.md`, hierarquia de verdade).
