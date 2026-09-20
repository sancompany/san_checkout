# Riscos

Riscos reais, encontrados por leitura de código/documentação ou
verificação direta — nada especulativo. Nível não é dramatizado: a
maioria aqui é **aceita conscientemente com compensação**, não um
alarme.

## Arquitetura

- **MEDIUM — Plugin `san-co` é Claude-Code-only por construção.** Toda a
  metodologia de processo deste projeto depende de uma ferramenta
  específica para carregar; Codex e Jules não têm acesso nativo a ela.
  É o risco que motivou esta tarefa. Mitigado por `.ia/` e pelo
  `CLAUDE.md` legível como texto plano. Detalhe: `CONTROL_PLANE.md`.
- **LOW — Estado do processo vive em prosa manual (`CLAUDE.md`, 58 KB)**,
  sem estrutura de dado. Já causou 3 contradições internas reais
  (estação dita "não iniciada" 3 dias depois de aberta; SHA de deploy
  escrito ficando falso no instante em que era escrito; contagens
  desatualizadas 3× na mesma semana) — todas descobertas e corrigidas,
  nenhuma causou dano em produção. `CONTROL_PLANE.md`/`TODO.md` propõem
  mitigação futura.

## Segurança

- **MEDIUM — Credencial Cloudflare no ambiente é a Global API Key**, com
  acesso à conta inteira (outras zonas/projetos além deste repositório,
  não só `sancocore.com.br`). Risco aceito conscientemente
  (`CONSTRAINTS.md` §3, ADR-007) —
  mitigação: nunca logar/persistir o valor, preferir token escopado
  quando uma tarefa já tocar essa configuração, nunca trocar por conta
  própria fora de escopo.
- **LOW — a chave sandbox da Asaas já apareceu na saída de um comando**
  de diagnóstico rodado por um agente (`northflank get service` com
  `runtimeEnvironment` completo) — registrado em `docs/pendencias.md`,
  17/09/2026. Não é chave de produção; o `RUNBOOK.md` §1.2 já foi
  corrigido para listar só nomes. Mitigação neste `.ia/`:
  `runbooks/northflank.md` avisa explicitamente sobre esse comando.
- **LOW — Rate limiting é por IP, não por credencial** — um proxy
  alternando IP já mediu 12 requisições passando por um teto de 10/min
  (`CONSTRAINTS.md` §2.7). Declarado, mitigação futura em `TODO.md`.

## Banco de dados

- **LOW — Divergência de nomenclatura entre o histórico de migrations
  do Supabase e os arquivos locais.** `list_migrations` não lista
  nenhuma entrada citando "0009" e lista duas para "0010" — mas o
  schema real (confirmado por `list_tables`) tem exatamente as colunas
  que as migrations 0009 e 0010 deveriam ter criado. Sem dano — é um
  risco de **confiança em fonte errada**: um agente que confiasse só no
  nome/número do histórico de migrations, sem checar a coluna real,
  poderia concluir erroneamente que uma migration não foi aplicada.
  Mitigação: `AGENT_PROTOCOL.md` já estabelece "schema real" acima de
  "nome de migration" na hierarquia de verdade.
- **LOW — Sem cópia de backup fora do provedor** — só ensaio de
  restauração contra o próprio Supabase (RTO ~1s, testado). Risco
  aceito com gatilho explícito em `CONSTRAINTS.md` §3.

## Infraestrutura / operação

- **LOW — Ausência de alerta ativo além do e-mail de falha da Asaas.**
  Silêncio total (app fora do ar sem nenhum evento de pagamento ou de
  conta) não gera aviso a ninguém. Decisão do dono (17/09/2026): aceito
  para o volume atual (um operador, sandbox).
- **LOW — Latência do painel administrativo depende do plano gratuito
  do Supabase** (50–270ms por consulta, medido) — decisão de custo
  pendente, não bug de código.
- **INFO — Check "Supabase Preview" aparece `skipped` em toda PR** —
  não confirmado nesta auditoria se é uma integração ativa mal
  configurada ou vestígio de uma tentativa anterior. Sem impacto
  observado (CI principal não depende dela).

## Deploy

- **LOW — Sem ambiente de staging.** Todo merge na `main` publica direto
  em produção (backend + front). Mitigação existente: CI (sintaxe +
  suíte completa) como porta obrigatória, mais o hábito já estabelecido
  de testar ao vivo contra o sandbox da Asaas antes de considerar uma
  mudança pronta.
- **INFO — Nome exato e configuração de build do projeto Cloudflare
  Pages não confirmados via API nesta auditoria** — inferido só pelo
  CNAME e pelo check que aparece nas PRs.

## Integração (contratantes)

- **LOW — Um contratante comprometido ou malicioso já foi tratado como
  vetor de SSRF/vazamento de chave**, e corrigido (`RN-30`, redirect
  revalidado por origem, teto de corpo). Risco residual: qualquer
  contratante NOVO cadastrado manualmente herda automaticamente essas
  proteções (são do lado do Checkout, não do contratante) — sem ação
  extra necessária por cadastro.

## Plugin / processo

- **LOW — Nenhuma verificação automática de que a metodologia (skills
  `revisar`/`seguranca-san`) realmente rodou antes de um merge** — é
  inteiramente dependente de o agente lembrar de invocá-la. Detalhe em
  `CONTROL_PLANE.md`.
- **LOW — Coordenação entre agentes em superfícies diferentes depende
  de disciplina, não de trava técnica** — dois agentes podem, em teoria,
  editar o mesmo arquivo ao mesmo tempo sem aviso além de conflito Git
  comum. Mitigação começando com esta tarefa (`.ia/HANDOFF.md`).

## Documentação

- **LOW — Documentos extensos e narrativos (`CLAUDE.md`, `CONSTRAINTS.md`,
  `RUNBOOK.md`, `API.md`, todos 50–100 KB) são caros de ler por inteiro
  a cada sessão.** Mitigado por este `.ia/` resumir e apontar, em vez de
  substituir — mas o risco de um agente não ler a seção certa antes de
  agir continua existindo por natureza (nenhum sumário substitui 100%
  do detalhe).
