# Contrato de autonomia

Este documento é a régua de quando agir sozinho e quando envolver o
usuário. Ele não substitui `CONSTRAINTS.md` (raiz) nem a skill `leis` —
onde os dois falarem da mesma categoria (ex.: "caminho de dinheiro exige
autorização para construir"), a regra mais específica do projeto vence.

## Regra principal

**Resolver sozinho antes de perguntar.** Uma pergunta que o próprio
agente conseguiria responder lendo, medindo, testando ou consultando a
documentação/serviço é trabalho transferido, não colaboração.

## Sequência de descoberta (antes de perguntar qualquer coisa operacional)

1. **`.ia/`** — este diretório provavelmente já responde.
2. **Código do repositório** — a implementação real é mais confiável
   que qualquer resumo.
3. **Git** — `log`, `status`, `branch`, `diff` como evidência de estado.
4. **Arquivos de configuração** — `.env.example`, `package.json`,
   `supabase/`, `.github/workflows/`.
5. **Variáveis disponíveis pelo nome** — `env | cut -d= -f1` para saber
   o que existe sem nunca imprimir valor.
6. **CLIs disponíveis** — `command -v <ferramenta>` antes de assumir
   ausência.
7. **Integrações/MCP disponíveis** — `ToolSearch`/listagem de tools do
   próprio agente.
8. **Consultar o serviço externo diretamente**, quando autorizado —
   GitHub, Supabase, Cloudflare, Northflank, pelos mecanismos
   confirmados em `ACCESS.md`.
9. **Logs, status, configuração efetiva** do serviço — não só o que o
   código *pretende*, o que está *rodando*.
10. **Só então** considerar a informação genuinamente indisponível — e,
    nesse caso, dizer exatamente o que foi tentado, não só "não sei".

Prefira **descobrir → validar → agir** a **perguntar → esperar → agir**.

## Operações permitidas autonomamente (baixo risco, reversíveis)

- Consultar banco, schema, tabelas, migrations aplicadas (leitura).
- Verificar logs, status de deploy, saúde de serviço.
- Verificar configuração de DNS, variáveis (pelo nome), rotas montadas.
- Verificar GitHub Actions, status de CI, PRs abertos.
- Abrir branch, criar commit, abrir PR.
- Rodar migration **já revisada e aprovada** em uma tarefa anterior
  (não uma nova, criada nesta mesma tarefa, sem revisão).
- Corrigir configuração diretamente relacionada ao problema que está
  sendo resolvido agora.
- Atualizar documentação operacional (`.ia/`, `docs/`) depois de uma
  mudança.
- Rodar suíte de testes, lint, build, verificações de acessibilidade e
  desempenho.

## Operações que exigem cautela (avaliar impacto antes, mas não
necessariamente perguntar — depende do risco concreto)

- Mesclar PR na `main` — **já autorizado pelo dono de forma permanente**
  quando o CI está verde (`CLAUDE.md` raiz, "Mesclar é decisão tomada");
  a porta é o CI, não uma pessoa. Isso cobre mesclar, não cobre
  construir a mudança sem autorização quando ela cai na lista abaixo.
- Iniciar novo deploy, reiniciar serviço.
- Ativar/desativar um componente que faz parte direta da tarefa em
  curso.
- Rotacionar credencial — só quando a própria tarefa exigir (nunca por
  "boa prática" incidental, ver `RISKS.md` sobre a Global API Key da
  Cloudflare).

## Operações que exigem autorização explícita do usuário

Herdadas da skill `leis` ("lista curta que pede permissão sempre") e de
`CONSTRAINTS.md` — valem para **construir** a mudança, não para mesclar
uma já revisada:

- Qualquer coisa no **caminho de dinheiro**: cobrança, estorno, webhook
  de pagamento, split, conciliação, cálculo de acerto proporcional.
- **Autenticação, sessão, chave, segredo, permissão.**
- **Migration destrutiva** ou que reescreve dado já existente.
- **Contrato que outro projeto consome** (`API.md`) — mudança que quebra
  compatibilidade.
- **Remoção de funcionalidade em uso.**
- **Mudança verificável só em produção** (sem forma de testar antes).
- Decisão de produto que não pode ser inferida do que já está escrito
  (ex.: mudar o piso de cobrança, mudar regra de negócio do acerto de
  troca de plano).
- Qualquer custo financeiro novo (upgrade de plano, novo serviço pago).

## Operações destrutivas — nunca automaticamente

Apagar banco, projeto, bucket com dado, domínio, zone, organização;
apagar produção; remover backup; resetar banco de produção; apagar
histórico Git (`filter-repo`, `push --force` destrutivo em branch
compartilhada); force push em `main`; hard reset destrutivo; remover
grande volume de dado; alterar faturamento; contratar recurso pago;
remover controle de segurança (Cloudflare Access, rate limiting,
validação); reduzir proteção de autenticação; tornar público serviço
que era privado.

Esta lista intersecta a de `leis` (skill) e a de `CONSTRAINTS.md` — em
caso de dúvida sobre uma operação não listada aqui, tratar como
destrutiva até prova em contrário.

## Secrets — regra de manipulação

- **Nunca** gravar valor de API key, token, senha, cookie, refresh
  token, service role key, private key, ou qualquer credencial dentro
  do repositório — nem em código, nem em `.ia/`, nem em commit message,
  nem em comentário.
- **Pode** documentar: nome da variável, finalidade, serviço, ambiente,
  onde ela normalmente é configurada (exatamente como este `.ia/` faz).
- Encontrando segredo versionado por acidente: **não replicar o valor em
  lugar nenhum**, registrar o risco (`RISKS.md`), e o caminho de reparo
  é **revogar a credencial**, nunca reescrever histórico Git para
  "apagar" — reescrever histórico não alcança clone, fork nem cache já
  feito, e este repositório já aprendeu essa lição
  (`docs/erros/2026-09-11-filter-repo-apagou-trabalho-nao-commitado.md`).
- A **Global API Key** da Cloudflare no ambiente é a exceção mais
  sensível hoje — tratamento específico em `runbooks/cloudflare.md` e
  `RISKS.md`.

## Produção — regras específicas

- Este repositório publica em produção **a cada merge na `main`**
  (deploy automático, Northflank + Cloudflare Pages) — não existe
  ambiente de staging separado. Tratar todo merge como publicação real.
- O pagamento real (Asaas) está em **sandbox** por decisão do dono — não
  trocar para produção sem a autorização e o gatilho descritos em
  `CONSTRAINTS.md` §3 e `PROJECT_STATE.md`.
- Verificação pós-deploy é parte da tarefa, não opcional: confirmar
  `deployedSHA` (Northflank) bate com o commit mesclado, e `/api/saude`
  responde 200 — comandos em `runbooks/northflank.md`.

## Regra de escalonamento — quando envolver o usuário

Só nestes casos, depois de esgotada a sequência de descoberta:

- **Autenticação inexistente** — nenhuma credencial disponível para o
  serviço necessário, em nenhum mecanismo verificado.
- **Permissão inexistente** — a credencial existe mas não alcança a
  operação (ex.: escrita de DNS recusada pelo classificador de
  permissões do harness, como já aconteceu com o registro SPF em
  17-18/09/2026, resolvido só quando o dono liberou).
- **Decisão de produto que não pode ser inferida** — valor de negócio,
  prioridade entre trade-offs equivalentes, algo que depende do que o
  dono quer, não do que é tecnicamente correto.
- **Operação destrutiva de alto impacto fora do escopo da tarefa atual.**
- **Custo financeiro novo relevante.**
- **Risco de perda de dado.**

Ao escalonar, seguir o formato de `AGENT_PROTOCOL.md`/`CLAUDE.md` (raiz,
"O que chega ao dono é decisão, não problema"): causa, opções com
trade-off, o que já foi verificado, o que acontece se nada for feito.
