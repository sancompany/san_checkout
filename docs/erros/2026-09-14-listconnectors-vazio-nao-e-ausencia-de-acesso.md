# ListConnectors vazio não é ausência de acesso — é ausência de conector

**Quando:** 14/09/2026, abertura de sessão para a Estação 6.
**Onde:** relatório de acesso a Northflank e Cloudflare, antes de testar de verdade.

## O que aconteceu

O dono pediu para eu confirmar `ListPlugins` e `ListConnectors` antes de
qualquer coisa, porque uma sessão anterior tinha afirmado acesso que não
existia. `ListConnectors` devolveu só Supabase e Render — Northflank e
Cloudflare não apareceram. Eu reportei os dois como "não apareceram nesta
sessão", tratando a lista do conector como a lista do que o ambiente
alcança.

Estava incompleto. `NORTHFLANK_TOKEN`, `CLOUDFLARE_EMAIL` e
`CLOUDFLARE_API_KEY` estavam no ambiente o tempo todo. Chamando a API de
cada serviço direto (`curl` com o token, sem passar por conector nem MCP),
os dois responderam de verdade: Northflank devolveu o time (`san-co`), o
projeto (`san-checkout`) e o status do serviço batendo com o que o GitHub
Deployments já tinha mostrado; Cloudflare devolveu a conta com papel de
Super Administrador.

Só quando o dono perguntou "testa se você tem acesso de verdade" a chamada
real aconteceu, em vez de confiar na ausência na lista.

## A causa raiz

Tratei "a ferramenta que lista conectores" como autoridade sobre "o que
este ambiente alcança". São coisas diferentes: `ListConnectors` lista
integrações de conta feitas pelo claude.ai; credencial solta em variável
de ambiente é um caminho de acesso separado, e nenhuma ferramenta de
inventário o enumera — só testar enumera.

É a mesma forma do erro do `ListPlugins` (13/09): confiar que "a
ferramenta de inventário voltou vazia" significa "não tem acesso". Nos
dois casos a correção é a mesma — testar pelo uso real (Skill tool para
plugin; chamada de API real para credencial), nunca aceitar a lista vazia
como resposta final.

## O que fica

- **Lista de conector é sobre conta, não sobre ambiente.** Variável de
  ambiente com token é acesso e não aparece em `ListConnectors` nem em
  `ListPlugins` — checar `env` antes de declarar "sem acesso" a um
  serviço.
- **Reportar "não tenho acesso a X" exige ter tentado uma chamada real a
  X primeiro.** Declarar pela ausência numa lista é o mesmo erro do
  `ListPlugins` vazio, só que num serviço diferente.
- Northflank exige `teamId` na URL (`/v1/teams/{team}/...`) para token
  org-scoped — sem ele a API devolve 403 que parece "token inválido" e
  não é.
- Achado que ficou registrado à parte (`docs/pendencias.md`): a
  credencial do Cloudflare é a Global API Key da conta inteira, não um
  token escopado à zona do projeto.
