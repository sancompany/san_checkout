# `.ia/` — memória operacional compartilhada

Esta pasta é a **fonte de verdade persistente** entre agentes de IA que trabalham
neste repositório (Claude Code, OpenAI Codex, Google Jules, e qualquer outro que
vier depois). O histórico de conversa de qualquer agente **não é memória**: ele
desaparece quando a sessão termina. O que sobrevive é o que está commitado aqui.

Se você é um agente entrando neste repositório agora e não tem contexto nenhum,
comece pelo `AGENTS.md` na raiz — ele te manda para cá.

## Onboarding rápido (nesta ordem)

1. `/AGENTS.md` (raiz do repositório) — ponto de entrada, uma página
2. `.ia/HANDOFF.md` — o que o agente anterior estava fazendo, e a próxima tarefa
3. `.ia/PROJECT_STATE.md` — estado verificável do sistema agora
4. `.ia/CONTEXT.md` — o que é o projeto, para quem, por quê
5. `.ia/ARCHITECTURE.md` — como o sistema é montado
6. `.ia/DECISIONS.md` — decisões já tomadas (não reabrir sem motivo novo)
7. Documentação específica da tarefa em mãos — ver tabela abaixo

## Onde cada pergunta é respondida

| Pergunta | Documento |
|---|---|
| O que é este projeto e por que existe? | `CONTEXT.md` |
| Como o sistema é montado (stack, módulos, fluxo)? | `ARCHITECTURE.md` |
| O que está no ar agora, e como confiro de novo? | `PROJECT_STATE.md` |
| Como funciona o plugin `san-co` que controla o processo? | `CONTROL_PLANE.md` |
| Quais serviços externos existem e para que servem? | `INTEGRATIONS.md` |
| Como eu, agente, acesso cada serviço? | `ACCESS.md` |
| O que posso fazer sozinho, sem perguntar? | `AUTONOMY.md` |
| Como rodo, testo, faço deploy, revert? | `OPERATIONS.md` |
| Por que as coisas são como são? | `DECISIONS.md` (ADRs) |
| O que falta fazer? | `TODO.md` |
| O que pode dar errado, e o quão grave é? | `RISKS.md` |
| O que o último agente fez, e o que vem agora? | `HANDOFF.md` |
| Qual é o protocolo universal de trabalho? | `AGENT_PROTOCOL.md` |
| Instruções específicas do meu agente | `agents/CLAUDE.md`, `agents/CODEX.md`, `agents/JULES.md` |
| Comandos práticos por serviço | `runbooks/*.md` |

## Permanente vs. atualizado com frequência

**Muda pouco** (revisar só quando a realidade descrita mudar de verdade):
`README.md` (este arquivo), `CONTEXT.md`, `ARCHITECTURE.md`, `CONTROL_PLANE.md`,
`INTEGRATIONS.md`, `ACCESS.md`, `AUTONOMY.md`, `OPERATIONS.md`, `AGENT_PROTOCOL.md`,
`agents/*.md`, `runbooks/*.md`.

**Atualiza a cada tarefa relevante** (é o ponto do arquivo):
`HANDOFF.md` (toda vez), `PROJECT_STATE.md` (quando o estado verificável mudar),
`DECISIONS.md` (nova decisão ou decisão superada), `TODO.md` (item resolvido ou
descoberto), `RISKS.md` (risco novo, mitigado ou reclassificado).

## Regra de ouro

**Infraestrutura real vence documento; documento vence memória de conversa.**
A hierarquia completa está em `AGENT_PROTOCOL.md`. Encontrou este `.ia/`
desatualizado contra o que você mediu de verdade? Corrija o arquivo na mesma
tarefa — documento errado é pior que documento ausente, porque faz o próximo
agente agir com confiança sobre informação falsa.

## O que esta pasta NÃO é

- **Não é o lugar de segredos.** Nenhum valor de variável de ambiente, token,
  chave ou senha entra aqui — só o nome da variável e para que serve. Ver
  `ACCESS.md` e a seção "Secrets" de `AUTONOMY.md`.
- **Não substitui o `CLAUDE.md` da raiz.** Aquele arquivo é o diário de bordo
  específico do processo `san-co` (a esteira de sete estações, o plugin, o
  histórico dia-a-dia de decisões do dono) — denso, específico de domínio,
  em uso desde antes desta pasta existir. Esta pasta (`.ia/`) é a camada
  **agnóstica de agente e de metodologia**: qualquer um dos três (Claude,
  Codex, Jules) precisa conseguir entender e operar o projeto lendo só ela,
  mesmo sem conhecer o plugin `san-co`. `CONTROL_PLANE.md` explica a relação
  entre os dois em detalhe.
- **Não é o backlog do produto.** `docs/pendencias.md` e `docs/proximas-versoes.md`
  continuam existindo e são a fonte para o que entra em `TODO.md` — esta pasta
  não os duplica, ela resume e aponta.
