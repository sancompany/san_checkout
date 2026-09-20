# Protocolo universal do agente

Vale para Claude Code, Codex, Jules e qualquer agente futuro. As diferenças
entre agentes são pequenas e estão em `agents/<NOME>.md`; este documento é a
regra, não a exceção.

## Ao iniciar uma sessão

1. Ler `/AGENTS.md` (raiz).
2. Ler `.ia/HANDOFF.md` — o que estava em andamento.
3. Ler `.ia/PROJECT_STATE.md` — estado verificável.
4. Rodar `git status` e `git log -5 --oneline` — o working tree pode ter
   trabalho não commitado de outra superfície (ver `AUTONOMY.md`, nunca
   descartar sem investigar).
5. Confirmar a branch atual bate com a que o `HANDOFF.md` diz. Divergindo,
   investigar antes de agir — pode ser um agente diferente que já mudou de
   branch, ou uma PR que mesclou nesse meio tempo.
6. Entender a tarefa pedida — pelo usuário, ou pelo `HANDOFF.md` se for
   continuação.
7. Consultar a documentação específica da tarefa: `ARCHITECTURE.md` para
   entender onde a mudança entra, `CONTROL_PLANE.md` se a tarefa tocar o
   plugin `san-co`, `INTEGRATIONS.md`/`ACCESS.md`/`runbooks/` se tocar um
   serviço externo.

## Antes de modificar qualquer coisa

1. **Localizar a implementação atual** — ler o código real, nunca assumir
   pelo nome do arquivo ou pela documentação sem conferir.
2. **Entender as dependências** — quem chama isto, o que isto chama.
3. **Verificar se existe decisão arquitetural registrada** — `DECISIONS.md`
   e `CONSTRAINTS.md` (raiz) podem já ter fechado essa pergunta, com o
   porquê. Contrariar uma decisão registrada exige motivo novo, explícito.
4. **Verificar efeitos colaterais** — a mudança toca dinheiro, dado pessoal,
   segredo, contrato que outro projeto consome, ou migration destrutiva?
   Essas categorias têm regra própria em `AUTONOMY.md` — cautela antes de
   agir, não depois.

## Durante o trabalho

1. **Evitar duplicação** — antes de escrever algo novo, procurar se já
   existe (helper, validador, padrão). `ARCHITECTURE.md` mapeia onde cada
   responsabilidade mora.
2. **Preservar os padrões do repositório** — nomes em português para
   domínio de negócio, comentários só quando explicam o porquê (não o quê),
   teste com sabotagem verificada manualmente para todo bug corrigido no
   caminho do dinheiro. Ver `CLAUDE.md` (raiz) para o estilo em uso.
3. **Rodar verificações incrementalmente**, não só no fim.
4. **Registrar descobertas relevantes** assim que aparecerem — não esperar
   o fim da tarefa para anotar algo que o próximo agente precisa saber.

## Depois do trabalho

1. Rodar testes (`npm test`), lint/sintaxe (`npm run check`), e qualquer
   verificação de navegador aplicável (`npm run acessibilidade`,
   `npm run desempenho`) — comandos confirmados em `OPERATIONS.md`.
2. Rodar build, se a mudança tocar algo que builda (este projeto não tem
   passo de build separado — `public/` é servido como está; conferir
   `OPERATIONS.md` antes de assumir o contrário).
3. Verificar a integração afetada de verdade — não basta o teste passar
   isoladamente; ver "Verificação" em `CONTROL_PLANE.md` e a seção
   correspondente em `OPERATIONS.md`.
4. Atualizar `TODO.md` — item resolvido sai da lista ou muda de status;
   item novo descoberto entra.
5. Atualizar `DECISIONS.md` quando a tarefa fechou uma decisão de
   arquitetura, não só implementou uma já tomada.
6. Atualizar `PROJECT_STATE.md` quando o estado verificável mudou (deploy
   novo, migration nova, componente que passou de quebrado para
   funcionando ou vice-versa).
7. **Atualizar `HANDOFF.md` sempre**, mesmo que a tarefa não tenha
   terminado — é o único documento que garante que o próximo agente (você
   mesmo amanhã, ou outro agente em outra superfície) não repete trabalho
   nem perde contexto.

## Fonte de verdade — hierarquia, em ordem

1. **Infraestrutura real** — o que o serviço responde agora (GitHub, Supabase,
   Cloudflare, Northflank, Asaas).
2. **Código real** — o que está no repositório, lido, não lembrado.
3. **Configuração real** — `.env.example`, `package.json`, migrations,
   workflows, exatamente como estão.
4. **Banco/schema real** — consultado direto (`list_tables`, `psql`, painel),
   nunca assumido pela migration mais recente sem conferir que ela foi
   aplicada.
5. **Git** — histórico de commits como evidência de o que realmente mudou
   e quando.
6. **Documentação `.ia/` e a documentação do projeto** (`CLAUDE.md`,
   `RUNBOOK.md`, `API.md`, `CONSTRAINTS.md`, `docs/`).
7. **Histórico de conversa** — a fonte mais fraca. Nunca a única base para
   uma afirmação sobre o estado do sistema.

Documentação errada contra uma fonte mais forte **se corrige na mesma
tarefa** — não se cria uma pendência para "revisar depois".

## Escalonamento — quando envolver o usuário

Só quando existir bloqueio real (ver a lista completa e os exemplos em
`AUTONOMY.md`, seção "Regra de escalonamento"). Antes de perguntar,
percorrer a sequência de descoberta: documentação → código → Git →
configuração → ferramentas disponíveis → serviço externo (autorizado) →
logs/status → só então considerar indisponível.
