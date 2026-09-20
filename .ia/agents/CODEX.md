# Instruções específicas — OpenAI Codex

Base: `AGENT_PROTOCOL.md`. Este arquivo só cobre o que é diferente para você.

## O que muda para você

- **Você não carrega o plugin `san-co`.** Ele é um pacote de skills no
  formato do Claude Code (`.claude-plugin/`, `SKILL.md`, carregado por
  `/plugin` e pelo `Skill` tool) — mecanismo específico daquela ferramenta.
  Você não tem acesso a ele por nenhum meio nativo. **Isso não significa
  que a metodologia não se aplica a você** — significa que ela precisa
  chegar até você por arquivo comum, que é exatamente o papel do
  `CLAUDE.md` da raiz e desta pasta `.ia/`. Leia os dois como texto plano;
  eles descrevem regras e processo, não comandos que só o Claude Code
  executa.
- **`CLAUDE.md` na raiz não é dirigido a você por nome**, mas o conteúdo
  (a esteira de sete estações, as leis, o histórico de decisões, o "Mapa
  de caminhos") é sobre o **projeto**, não sobre a ferramenta — leia-o
  como documentação do projeto, ignorando só as partes que citam
  mecanismo específico do Claude Code (`Skill`, `ListPlugins`,
  `/plugin marketplace add`).
- **Suas ferramentas de acesso a serviços externos** dependem de como este
  ambiente Codex foi configurado — MCP, variável de ambiente, ou CLI
  instalado. Não assuma nenhuma: siga a sequência de descoberta em
  `AUTONOMY.md` (procurar CLI no PATH, procurar variável pelo nome,
  procurar configuração de MCP) antes de perguntar. Os nomes de variável e
  os comandos confirmados nesta auditoria estão em `INTEGRATIONS.md`,
  `ACCESS.md` e `runbooks/` — eles valem como referência de **o que
  existe**, mesmo que o mecanismo de acesso no seu ambiente seja diferente
  do usado para confirmá-los (ex.: MCP do Claude Code vs. API direta).

## O que assumir como já resolvido

- Estrutura de pastas, convenções de nome, padrão de teste (sabotagem
  manual), estilo de commit — tudo isso está estabelecido neste
  repositório e documentado em `ARCHITECTURE.md` e `OPERATIONS.md`. Siga
  o padrão existente em vez de introduzir o seu.
- CI já valida sintaxe + suíte de testes a cada push (`.github/workflows/ci.yml`)
  e segurança semanalmente (`.github/workflows/seguranca.yml`) — não
  recrie, apenas rode localmente antes de propor uma mudança
  (`OPERATIONS.md` tem os comandos exatos).

## Comportamento esperado

Igual ao protocolo universal: descobrir → validar → agir, atualizar
`HANDOFF.md` ao terminar (ou ao pausar), nunca expor segredo, pedir só
quando o bloqueio for real (`AUTONOMY.md`, "Regra de escalonamento").
