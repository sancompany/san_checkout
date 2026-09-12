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

**Estação 6 (Prontidão) ABERTA em 11/09/2026.** Aberta por decisão do
dono com a 5 na última conferência (o teste de ponta a ponta do painel,
que exige a senha de admin). Ela faz segurança em ciclos, teste no
navegador, limites declarados, log e alerta — Leis 4, 7 e 8, com a skill
`seguranca-san`. Modelo: **Opus, esforço alto**, que é o que a tabela
pede e o que esta sessão já roda.

O que ela verifica é **o que está no ar**, e é por isso que ela só pôde
abrir agora: a versão está em produção, com Access na borda, migrations
aplicadas e as 6 suítes passando.

A fila de trabalho dela, em ordem de tamanho do risco:

1. **Sessão de curta duração** no lugar de derivar a senha a cada
   requisição. Resolve de uma vez os três itens abertos que são o mesmo
   problema visto de ângulos diferentes: a senha trafegando em todo
   request, a amplificação de memória (que já derrubou a produção uma
   vez) e os ~3s por clique no painel. **Ganhou um quarto ângulo no
   ciclo 1:** a senha fica em `sessionStorage` em texto puro enquanto a
   aba estiver aberta (`CONSTRAINTS.md` §2.6).
2. ~~**Ciclo da `seguranca-san` sobre o que está no ar**~~ — **ciclo 1
   rodado em 11/09/2026**, com o backend em produção, o navegador
   integrado sobre `checkout.sancocore.com.br` e a suíte local. Seis
   achados, todos corrigidos no repositório, todos com registro em
   `docs/erros/`. **O ciclo 2 rodou limpo sobre o código corrigido, mas
   rodou LOCAL** — as correções ainda não subiram. Ver a pendência
   bloqueante abaixo.
3. **Cache de 4h em JS e CSS** (item abaixo) — passou de incômodo a
   bloqueio de verificação.
4. **Detectar a fila pausada da Asaas** e o alerta de serviço fora do ar
   (Lei 8), hoje inexistentes.

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

- **🔴 Estação 6 · as correções do ciclo 1 de segurança não estão em
  produção.** A Estação 6 verifica **o que está no ar**, e o que está no
  ar hoje é a versão anterior a estas seis correções. O ciclo 2 passou
  limpo, mas passou sobre o repositório, não sobre produção — e é
  exatamente essa distância que a estação existe para medir.

  **A estação não fecha até isto subir e ser reconferido.** Arquivos
  alterados, todos já no disco em `D:\san-checkout-v2`:

  | Arquivo | O que mudou |
  |---|---|
  | `src/server.js` | limitador em `/api/saude` (30/min) e `/api/webhooks` (300/min); tratador de 404 e de erro em JSON no fim da pilha |
  | `src/utils/validadores.js` | tabela `TETOS` por campo, `nomeValido`, guarda de vazio no `compararSeguro`, autoteste novo (40 checagens) |
  | `src/controllers/checkoutController.js` | `nomeValido` nos 2 pontos de entrada |
  | `src/controllers/asaasCheckoutController.js` | `nomeValido` nos 3 pontos de entrada |
  | `public/_headers` | `noindex` nas seis grafias, não só nas duas com `.html` |
  | `tests/valor-vem-do-servidor.js` | **arquivo novo** — o corpo da requisição nunca dita quanto se cobra |
  | `tests/executar.js` | registra as duas suítes novas (8 no total) |

  Depois do deploy, o que precisa ser reconferido **de fora**, e que só
  faz sentido contra produção:

  1. `curl -D- https://checkout.sancocore.com.br/status` tem que trazer
     `x-robots-tag` **na página**, não só no 308 de `/status.html`.
  2. `curl https://san-checkout.onrender.com/api/checkout/naoexiste` tem
     que devolver `{"erro":"Rota não encontrada."}` em JSON, não HTML.
  3. `/api/saude` tem que trazer `RateLimit-Limit: 30`.
  4. Um `POST` em `/api/checkout/pix/...` com `nome` de 100 KB tem que
     devolver `{"erro":"Nome inválido."}`.

- **🟡 Última conferência da Estação 5, e só o dono consegue fazer:**
  entrar no painel (passando pelo Cloudflare Access), cadastrar um
  contratante conferindo que **"Assinatura por Pix" vem desmarcada**,
  arquivar, abrir a aba "Arquivados" e restaurar.

  Tudo que dá para conferir de fora já foi, em 11/09/2026 e em produção:
  backend novo respondendo, migration `0003` aplicada (o `/pedido` devolve
  404 e não 500, então a coluna existe), guarda do webhook devolvendo 401
  sem token, frontend com a correção sequencial e o `METODOS_PADRAO`, as
  6 suítes passando, e o Access barrando `/admin` nos dois domínios sem
  barrar o checkout. **O que falta é o teste de ponta a ponta do painel,
  que exige a senha do admin — e a senha é sua.**

  Em 11/09/2026 os dois contratantes que existiam (`admin-master` e o de
  teste) foram apagados pelo dono — os dois eram rascunho e nenhum tinha
  cobrança, que é a única condição em que apagar é aceitável
  (`CONSTRAINTS.md` §1.10). **A base está sem contratante nenhum**, então
  o checkout responde "Contratante não encontrado" para qualquer link até
  o primeiro cadastro.

### Abertas, não bloqueiam

- **🔴 Lei 5 · o cache de JS e CSS em produção ainda é de 4 horas, e já
  bloqueia verificação.** Subiu de 🟠 para 🔴 em 11/09/2026: pela
  terceira vez no dia, uma correção **já publicada e correta no servidor**
  apareceu como "não funcionou" porque o navegador estava rodando o
  arquivo antigo — desta vez a caixa "Assinatura por Pix", que o servidor
  já servia desmarcada. Deixou de ser incômodo: faz correção certa
  parecer errada, que é o pior tipo de ruído.

  **A correção certa é uma Cache Rule na zona** (Regras → Cache Rules),
  com *Browser TTL* forçado para zero em `/js/*` e `/css/*`. É
  configuração de painel, incluída no plano gratuito, e vale sem depender
  de deploy.

  **Deliberadamente NÃO foi feito** o paliativo de `?v=` nas tags do HTML:
  exige lembrar de incrementar a cada mudança de JS ou CSS, e ritual que
  se esquece é proteção de mentira — pior que ausência, porque dá
  confiança. Se um dia houver passo de build, o certo é hash no nome do
  arquivo.

  **Contorno enquanto não existe: Ctrl+Shift+R depois de todo deploy.**
- **(registro original)** Lei 5 · o cache de JS e CSS em produção ainda é de 4 horas. O
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

- **🟠 Estação 6 · o limite por IP não é guarda de força bruta, e a
  `X-Checkout-Key` não tem nenhuma outra.** Medido no ciclo 1: doze
  requisições passaram por um teto de 10/min porque o proxy de saída
  alternava entre três endereços. Declarado no `CONSTRAINTS.md` §2.7 como
  limite assumido — contador por credencial está em
  `docs/proximas-versoes.md`, esperando evidência de tentativa real no
  log de rejeição. Não bloqueia: é limite conhecido e escrito, não
  descoberta pendente.
- **🟡 Estação 6 · `NODE_ENV` no Render nunca foi confirmado.** Não dá
  para medir de fora — o proxy do Render sobrescreve o
  `x-forwarded-proto`, que era a única pista observável. Deixou de ser
  risco de vazamento (o tratador de erro novo fecha isso em código,
  independente do valor), mas se `NODE_ENV` não for `production` o
  **redirecionamento HTTP→HTTPS do `server.js` é código morto** —
  inofensivo hoje, porque o Render e o Cloudflare já entregam só HTTPS e
  o HSTS está ativo. Conferir no painel do Render quando abrir ele por
  outro motivo; não vale uma viagem só para isso.
- **🟡 Estação 6 · um 401 no meio da sessão não limpa o login guardado.**
  A aba segue reenviando a senha velha, e cada tentativa custa uma
  derivação scrypt no servidor. Some junto com a sessão de curta duração
  — não vale correção própria antes dela.
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
