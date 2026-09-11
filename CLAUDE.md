# San Checkout — SAN & CO. Pay Engine

Projeto da San & Co. Segue as leis de construção do plugin `san-co`.

Motor de pagamento whitelabel, modelo *pull*: o checkout não guarda
catálogo — pergunta os dados de cada pedido à API do próprio contratante
e cobra o valor que recebeu nessa resposta.

## Antes de propor ou escrever qualquer coisa, leia

- `CONSTRAINTS.md` — o que este projeto deliberadamente NÃO faz, e os limites assumidos
- `docs/specs/2026-09-11-san-checkout.md` — por que existe, para quem, e o veredito dos contrapontos
- `docs/erros/` — o que já deu errado aqui; não repita
- `README.md` — como rodar e como executar os testes
- `API.md` — o contrato com quem integra (fica na raiz de propósito: é o documento mais lido do repositório)
- `docs/inventario-de-dados.md` — que dado de pessoa este projeto coleta
- `docs/proximas-versoes.md` — o que ficou para depois. **Não autoriza
  construir nada**: o `CONSTRAINTS.md` diz "não construa", este diz
  "ainda não"

## Classificação

Porte: plataforma multi-inquilino (contratantes, painel administrativo,
5 métodos de pagamento, recorrência, webhooks de saída) ·
Dado: **alto** — nome, e-mail, CPF/CNPJ, telefone e endereço completo de
compradores terceiros, mais histórico financeiro; cartão nunca toca o
servidor (delegado à Asaas) ·
Vida útil: **longa e declarada** — infraestrutura compartilhada do
ecossistema, com exigência explícita de não precisar de atualização
constante
→ rigor **topo da escala**. Nenhuma lei é dispensável por
proporcionalidade.

## Onde a esteira está

Estações 1 (Escopo) e 2 (Fronteiras) fechadas. Classificação registrada
em `docs/specs/2026-09-11-san-checkout.md`: San Checkout é **estrutura**,
não projeto — banco próprio e isolado, consome domínio/DNS, GitHub,
Render e Cloudflare Pages da San & Co.; não consome e-mail nem Drive.

**Estação 3 (Fundação) fechada.** Repositório, árvore de pastas, segredo
fora do código (Leis 1, 3, 9) e CI verde num push real (run #5,
reverificado ao vivo; o commit era `4c01cda` e virou `1fc7038` na
reescrita de histórico da Estação 4) — ver
`docs/erros/2026-09-11-ci-preso-em-node-20.md`.

**Estação 4 (Contratos) fechada.** Verificado: contrato de API
explícito com entrada, saída e tabela de erros (`API.md`, seções 4-5 e
9-10); RLS habilitada nas quatro tabelas com negação por padrão; schema
alterado só pelo SQL Editor, nunca por `DATABASE_URL`; migrations
numeradas e imutáveis a partir de `supabase/migrations/0001_baseline.sql`
(`CONSTRAINTS.md` §2.1), com o `schema.sql` antigo fora do
versionamento; backup registrado como exceção com gatilho no primeiro
pagamento real; inventário de dados preenchido, com o caminho de exclusão
conferido contra a modelagem (§6.2) e o dado pessoal do histórico do git
removido (§6.1). Reverificado ao vivo no commit `d515317`: árvore do
GitHub e CI verde (run #7).

**Estação 5 (Construção) está ABERTA.** Ela chegou a ser dada como
fechada em 11/09/2026 e **não estava** — ver
`docs/erros/2026-09-11-abri-a-estacao-seguinte-com-a-anterior-aberta.md`.
Duas das três condições estão cumpridas; a terceira depende de uma ação
que ainda não aconteceu.

- *Escopo da v1 implementado* — **parcial.** O que está em produção está
  implementado, mas o log de auditoria do webhook (migration `0002`,
  `auditoriaWebhookService.js`, a aba Webhook no painel) existe só no
  disco: não foi commitado, não foi enviado ao GitHub, a migration não
  rodou no Supabase e o Render não recebeu deploy. **Construção que não
  subiu não é construção fechada.**
- *Teste no caminho crítico* — feito. O webhook de entrada, onde dinheiro
  é confirmado, tem suíte cobrindo guarda de origem, mapa de
  evento→status, idempotência, ciclo novo de assinatura, a ordem do
  cancelamento na renovação, o contrato de sempre responder 200 e a
  gravação da linha de auditoria. Para isso o `webhookController.js`
  ganhou injeção de dependências, com o núcleo (`processarWebhook`)
  separado da casca do Express. Validados por mutação: quebrar a
  idempotência, inverter a ordem do cancelamento, furar a lista branca da
  redação, voltar a imprimir o payload cru ou aguardar a auditoria antes
  do 200 fazem a suíte falhar.
- *Ciclo de revisão limpo* — feito. A skill `revisar` rodou sobre os três
  diffs desta estação: 4 ciclos no do webhook, 3 no do frontend e 3 no do
  log de auditoria, todos terminando sem achado novo.

Leis verificadas até aqui: 2 (as exceções registradas seguem valendo; a
separação núcleo/casca melhorou), 5 (auditada com a tela renderizada —
anel de foco restaurado, campo com definição única, total que não mente,
aba Webhook conferida a 1280px e a 400px) e 6 (fechada na Estação 4).
Documentação oficial consultada onde a estação pede: o mínimo de
contraste do indicador de foco veio do WCAG 2.2 (1.4.11) e os 10 eventos
do grupo Pix Automático vieram da documentação da Asaas — nenhum dos dois
de memória.

Em 11/09/2026 a versão subiu (commit, push, migration `0002` rodada no
Supabase, deploy no Render e Cloudflare Pages) — e a **primeira
verificação em produção achou um defeito desta mesma estação**: a guarda
de total zero derrubou a porta de entrada do painel administrativo, que
estava pendurada num contratante de mentira com pedido de R$ 0,00. O
aparato inteiro foi removido e o painel passou a ser protegido na borda
(`CONSTRAINTS.md` §2.6). Registro em
`docs/erros/2026-09-11-guarda-de-total-zero-derrubou-a-porta-do-admin.md`.

Na mesma data entrou o **arquivamento de contratante e de subconta**
(migration `0003`), pedido do dono e caminho que o `CONSTRAINTS.md`
§1.10 já apontava desde o começo: não existe excluir contratante, existe
arquivar — sai da lista, **para de cobrar**, histórico inteiro guardado,
reversível num clique.

**O que falta para a Estação 5 fechar** está na lista de pendências
abaixo, e é ação do dono.

**Estação 6 (Prontidão) NÃO foi iniciada**, e não pode ser enquanto a 5
estiver aberta. Quando abrir, ela faz segurança em ciclos, teste no
navegador, limites declarados, log e alerta, verificando as Leis 4, 7 e 8
com a skill `seguranca-san` — e o que ela verifica é **o que está no ar**.
Rodá-la sobre código que só existe no disco mede o lugar errado, que é
exatamente o motivo de a ordem das estações não ser negociável. A tabela
pede Opus com esforço alto.

**O log de auditoria é construção da Estação 5, não entrega da 6.**
Escrever código que a Lei 8 um dia vai verificar não abre a estação que
faz essa verificação: estação é etapa, lei é verificação, e as duas
numerações não se correspondem.

(A Lei 0 como um todo continua aberta e não bloqueia — ver pendências:
falta a skill `revisar` rodar sobre o que está em produção.)

## Conformidade é obrigatória

Violação encontrada segue o ciclo das leis: corrigir o aditivo na hora,
propor o estrutural, registrar a decisão no documento certo, reverificar.
Não existe estado final fora de conformidade — ou corrige, ou vira
exceção registrada no `CONSTRAINTS.md`.

## Pendências de conformidade abertas

Esta é a lista única. O que não está aqui, está fechado.

### Bloqueiam a esteira — dependem de ação do dono

- **🔴 Rodar `supabase/migrations/0003_arquivamento.sql`** no SQL Editor
  do Supabase. Sem ela o backend sobe e toda listagem de contratante e
  de subconta falha: as consultas filtram por uma coluna que ainda não
  existe.

- **🔴 Subir e conferir ao vivo:** commit, push, deploy, e então abrir o
  painel (passando pelo Cloudflare Access), cadastrar um contratante,
  arquivar, e confirmar que ele sai da lista e volta com "Restaurar".

  Em 11/09/2026 os dois contratantes que existiam (`admin-master` e o de
  teste) foram apagados pelo dono — os dois eram rascunho e nenhum tinha
  cobrança, que é a única condição em que apagar é aceitável
  (`CONSTRAINTS.md` §1.10). **A base está sem contratante nenhum**, então
  o checkout responde "Contratante não encontrado" para qualquer link até
  o primeiro cadastro.

### Abertas, não bloqueiam

- **🟠 Lei 5 · o cache de JS e CSS em produção ainda é de 4 horas.** O
  `Cache-Control: max-age=0` do bloco `/*` do `_headers` vale para o
  HTML e **é sobreposto pelo Cloudflare Pages nos assets** — medido ao
  vivo em 11/09/2026. A correção que o
  `docs/erros/2026-09-11-cache-desencontrado-html-novo-js-velho.md`
  registrava como pronta não funciona para `.js` e `.css`, e o registro
  foi corrigido. Efeito prático: depois de todo deploy que mexa em JS ou
  CSS, o navegador pode rodar HTML novo com script velho por até 4h —
  que é exatamente o defeito que derrubou o painel no login uma vez.
  **Contorno hoje: Ctrl+Shift+R depois do deploy.** Correção de verdade:
  Transform Rule de resposta na zona para `/js/*` e `/css/*`. Não
  bloqueia porque tem contorno conhecido, mas é a primeira coisa da
  Estação 6.

- **Lei 8 · eventos que chegam e só entram no log.**
  `PAYMENT_APPROVED_BY_RISK_ANALYSIS`, os três de divergência de split e
  os grupos de transferência/saldo estão marcados no painel e caem no
  ramo de não mapeado. Isso é o desenho, não descuido: a aba Webhook os
  mostra, e o primeiro payload real é o que decide o tratamento. Dar
  comportamento a eles é entrada em `docs/proximas-versoes.md`, porque
  mexeria no mapa de status que o `API.md` publica como contrato —
  caminho de dinheiro e contrato de estrutura, os dois na lista curta da
  lei.
- **Lei 0 · a skill `revisar` nunca rodou** sobre o que está em produção.
- **Lei 0 · cobertura de teste ainda não alcança as rotas HTTP.** As 6
  suítes cobrem assinatura de webhook, conversão de taxa, id
  imprevisível, hash de senha, a redação do log de auditoria e o caminho
  crítico do webhook de entrada (guarda de origem, mapa de
  evento→status, idempotência, ciclo de assinatura, sempre-200 e a
  gravação da auditoria). Falta teste que suba o Express e exercite as
  rotas de criação de cobrança (`/api/checkout/pix`, `/cartao`,
  `/boleto`) de ponta a ponta.
- **🟠 Estação 6 · o painel é LENTO, e a causa está medida.** Em
  produção, 11/09/2026: `/api/admin/*` leva **~3.000ms**, enquanto a
  mesma rota com banco e sem senha (`/api/checkout/pedido/...`) leva
  **~500ms**. A diferença é a derivação scrypt N=2^17, que roda em
  **toda** requisição de admin — é consequência direta de não haver
  sessão. Cada clique que fala com o backend paga 3 segundos.
  **Paralelizar as chamadas seria o contrário do certo:** três
  derivações simultâneas pedem ~384 MiB numa instância de 512 MiB (ver o
  item de amplificação de memória abaixo). O que resolve é sessão de
  curta duração, que é o mesmo item logo abaixo — os dois são a mesma
  correção vista de dois ângulos, e fazer uma resolve a outra.
- **Estação 6 · a senha do admin trafega em todo request** (`X-Admin-Pass`)
  e fica no `sessionStorage` do navegador. O hash protege o repouso, não
  o trânsito. Um XSS no painel entrega a senha. Correção é token de
  sessão de curta duração — arquitetura de acesso, avaliada pela skill
  `seguranca-san`.
- **Estação 6 · amplificação de memória em `/api/admin` — ACONTECEU.**
  Deixou de ser risco previsto e virou incidente em 11/09/2026: o serviço
  estourou os 512 MiB e o Render reiniciou a instância. Contido com fila
  de uma derivação por vez em `senhaAdmin.js`
  (`docs/erros/2026-09-11-duas-derivacoes-simultaneas-derrubaram-o-servico.md`).
  **A memória está limitada; a lentidão não.** Cada requisição de admin
  continua custando ~3s, e agora elas também esperam na fila umas pelas
  outras — o que torna a sessão de curta duração mais urgente, não menos.
  O texto abaixo é o registro original do risco:
- **Estação 6 · amplificação de memória em `/api/admin`.** Cada tentativa
  de login deriva scrypt a N=2^17, que custa **128 MB**. O rate limit
  atual (10/min por IP) limita a taxa, não a simultaneidade: 10 chamadas
  disparadas juntas pedem 1,28 GB numa instância de 512 MB. Uso normal do
  painel não chega perto (as chamadas são sequenciais, pico de uma
  derivação por vez), mas é vetor de negação de serviço de quem sondar.
  Mitigação provável: limitar derivações concorrentes. Levantado ao subir
  o parâmetro de 2^14 para 2^17 — é consequência direta dessa mudança.
- **Lei 10 · a rotina de expurgo não existe.** O prazo de retenção está
  decidido (5 anos), mas nada apaga nada hoje. A modelagem **suporta** o
  expurgo (verificado na Estação 4 — ver `docs/inventario-de-dados.md`
  §6.2); falta escrever a rotina. Validação jurídica é da Estação 7, com
  a skill `legal`.
- **Lei 10 · a rotina de expurgo do dado do COMPRADOR não existe.** O
  prazo (5 anos) está decidido e a modelagem suporta, mas nada apaga
  cobrança nenhuma hoje. O expurgo que passou a existir em 11/09/2026 é
  o do log de auditoria (90 dias) — é rotina de verdade, rodando, mas
  cobre outra coisa.
