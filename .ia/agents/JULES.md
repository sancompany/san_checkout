# Instruções específicas — Google Jules

Base: `AGENT_PROTOCOL.md`. Este arquivo só cobre o que é diferente para você.

## O que muda para você

- **Você trabalha de forma assíncrona, na sua própria VM**, a partir de um
  checkout do repositório no GitHub — sem a sessão interativa contínua que
  Claude Code ou Codex têm. Isso torna `.ia/HANDOFF.md` ainda mais
  crítico para você: ele é a única forma de retomar exatamente de onde o
  agente anterior parou, já que você não herda nenhum estado de sessão.
- **Leia `.ia/HANDOFF.md` e `.ia/PROJECT_STATE.md` antes de qualquer
  outra coisa**, e confirme a branch/commit de partida bate com o que
  eles dizem (`git log -1`). Divergindo, trate como sinal de que outro
  agente mesclou trabalho nesse meio tempo — releia o estado antes de
  agir, não assuma que o `HANDOFF.md` ainda descreve o presente.
- **Você não carrega o plugin `san-co`** pelo mesmo motivo que o Codex: é
  um mecanismo do Claude Code. Leia `CLAUDE.md` (raiz) e `.ia/` como texto
  plano — mesma orientação da seção equivalente em `agents/CODEX.md`.
- **Acesso a serviços externos**: como você roda numa VM própria, CLIs e
  variáveis de ambiente presentes numa sessão Claude Code ou Codex podem
  não estar disponíveis na sua. Antes de assumir que um serviço está fora
  de alcance, confirme: CLI no PATH, variável pelo nome, qualquer
  integração/conector que o ambiente Jules já traga configurado. Os
  mecanismos confirmados nesta auditoria (`INTEGRATIONS.md`, `ACCESS.md`,
  `runbooks/`) descrevem **o que existe do lado do serviço**; o **como
  você chega lá** depende do que seu ambiente específico expõe.
- **Ao terminar (ou ao ser interrompido)**: como não há uma pessoa
  acompanhando em tempo real, é ainda mais importante deixar
  `HANDOFF.md` num estado que qualquer agente consiga retomar sem
  precisar te perguntar nada — inclusive o que você tentou e não deu
  certo, não só o que funcionou.

## Comportamento esperado

Igual ao protocolo universal. Commit e push do seu trabalho antes de
encerrar — trabalho que só existe na sua VM e não foi commitado é
trabalho que não existe para o próximo agente (`AGENT_PROTOCOL.md`,
"Fonte de verdade").
