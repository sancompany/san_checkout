# AGENTS.md — San Checkout

Você é um agente de IA (Claude Code, OpenAI Codex, Google Jules, ou
outro) entrando neste repositório. Leia isto primeiro, depois siga para:

1. **`.ia/README.md`** — índice completo da memória operacional deste
   projeto, com ordem de leitura recomendada.
2. **`.ia/AGENT_PROTOCOL.md`** — o protocolo universal de trabalho (o
   que fazer ao iniciar, antes de modificar, durante, depois).
3. **`.ia/HANDOFF.md`** — o que o agente anterior estava fazendo, e a
   próxima tarefa. Leia antes de agir; atualize antes de parar.

Se seu agente tem instruções específicas, elas estão em
`.ia/agents/CLAUDE.md`, `.ia/agents/CODEX.md` ou `.ia/agents/JULES.md`.

## Princípios

- **O repositório é a fonte de verdade compartilhada entre agentes.**
  Histórico de conversa (seu ou de outro agente) não é memória — o que
  não está commitado não existe para o próximo agente.
- **Não confie só na sua lembrança de uma sessão anterior.** Estado de
  infraestrutura, deploy, schema e configuração se reconfirma pela
  fonte (`.ia/AGENT_PROTOCOL.md` tem a hierarquia completa), nunca por
  memória.
- **Não ignore decisão já registrada.** `.ia/DECISIONS.md` e
  `CONSTRAINTS.md` (raiz) guardam decisões tomadas com o porquê —
  contrariá-las exige motivo novo explícito, não desconhecimento.
- **Atualize `.ia/HANDOFF.md`** ao terminar ou pausar qualquer tarefa
  relevante — é o que permite o próximo agente (você mesmo depois, ou
  outro agente em outra superfície) continuar sem reconstituir contexto.
- **Use serviços externos diretamente quando autorizado**, em vez de
  pedir ao usuário uma informação que você mesmo consegue descobrir.
  `.ia/AUTONOMY.md` tem a sequência de descoberta e o que é permitido
  sem perguntar; `.ia/ACCESS.md` e `.ia/runbooks/` têm os mecanismos
  confirmados por serviço (GitHub, Supabase, Cloudflare, Northflank).
- **Nunca exponha segredo.** Nome de variável, sim; valor, nunca — em
  nenhum arquivo, commit, log ou resposta. `.ia/AUTONOMY.md`, seção
  "Secrets", tem a regra completa.
- **Verifique antes de perguntar.** Uma pergunta que documentação,
  código, Git, configuração ou um serviço externo já respondem é
  trabalho transferido, não colaboração.

## Este projeto também usa um plugin de processo (`san-co`)

Carregado só no Claude Code (via marketplace, `.claude/settings.json`).
Ele traz uma metodologia própria (esteira de sete estações, revisão de
segurança, etc.) documentada em `CLAUDE.md` (raiz) e auditada, para
efeito de coordenação multi-agente, em `.ia/CONTROL_PLANE.md`. Se você
não é uma sessão Claude Code com esse plugin carregado, ignore as
referências a `Skill`/`/plugin` que aparecerem em `CLAUDE.md` — o
conteúdo relevante ao projeto em si continua valendo como texto.
