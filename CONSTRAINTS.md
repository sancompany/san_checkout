# CONSTRAINTS — San Checkout

O que este projeto **não** faz, e os limites que ele assume.

Se a pergunta é "posso construir isso aqui?", a resposta está neste
arquivo. Um item vetado só sai daqui por decisão explícita do dono do
projeto — não por alguém (pessoa ou IA) achar que seria uma boa ideia.

---

## 1. Escopo negativo — funcionalidade deliberadamente fora

### 1.1 Upsell one-click pós-compra — VETADO
Exige guardar o cartão tokenizado. Hoje o cartão é digitado numa pop-up
hospedada pela Asaas e **nunca toca este servidor** — é isso que mantém o
projeto fora do escopo PCI-DSS. Trazer cartão para dentro troca um ganho
incerto por auditoria de segurança, custo recorrente e responsabilidade
legal. `creditCardToken` não resolve: tokenizar também exige receber o
cartão cru antes.

### 1.2 Trocar o cartão de uma assinatura pela API — VETADO
Mesma razão. `PUT /v3/subscriptions/{id}/creditCard` exige `creditCard`
(número e CVV) e `remoteIp` como obrigatórios. O caminho aprovado é a
**renovação** pela pop-up (`&renovar=1`), que cria uma assinatura nova e
cancela a antiga só depois que a nova confirma.

### 1.3 Prova social sintética — VETADO
"237 pessoas compraram hoje" e similares. Não há fonte séria de ganho de
conversão *na etapa de checkout* — a decisão social acontece na página de
produto — e o projeto não tem o dado real para gerar isso com honestidade,
o que empurra para número inventado.

### 1.4 Timer de escassez falso — VETADO
Risco de publicidade enganosa (CDC art. 37). O checkout **já tem**
expiração real: o campo `expiraEm` que o contratante manda. Mostrar o
tempo real restante é legítimo; inventar prazo não é.

### 1.5 Multimoeda e internacionalização — FORA DE ESCOPO
Asaas é BRL, contratantes são BR, métodos são Pix, boleto e cartão
nacional. É resolver problema que o projeto não tem. Não existe parâmetro
de moeda em lugar nenhum, e isso é intencional.

### 1.6 Cashback, desconto progressivo e order bump com catálogo próprio — VETADO
Regra de preço pertence ao contratante. A arquitetura acertou ao manter
cupom e desconto vindo da API dele. Se um dia houver order bump, o
parceiro devolve as ofertas no próprio `GET /pedido/{id}` — o checkout
nunca guarda produto.

### 1.7 Estorno parcial — FORA DE ESCOPO
Sempre tudo ou nada. Para cancelar parte de um pedido, estorna-se tudo e
cria-se um pedido novo com o que sobrou.

### 1.8 Sandbox para o parceiro — FECHADO EM 11/09/2026
Exigiria dois clientes Asaas vivos no mesmo processo e roteamento por
requisição — mudança estrutural, não recurso. Hoje há um único parceiro,
que é o próprio operador. Reabrir quando existir parceiro externo de
verdade; a saída barata, nesse dia, é subir uma segunda instância do
backend apontando para o sandbox da Asaas, com Supabase próprio.

### 1.9 Nota fiscal e e-mail ao comprador — FORA DE ESCOPO (removidos em 08/09/2026)
Cada contratante emite a própria nota e manda o próprio e-mail,
disparados pelo evento que já chega no `webhook_url` dele. O checkout
processa pagamento e avisa; não emite documento fiscal nem fala com o
comprador em nome de ninguém.

### 1.10 Exclusão física de contratante — VETADO; o caminho é arquivar (CONSTRUÍDO em 11/09/2026)
`cobrancas.contratante_id` é `on delete set null`: apagar um contratante
deixaria o histórico financeiro dele órfão — as cobranças continuam na
tabela, sem dono, e nenhuma conciliação futura consegue dizer de quem
eram. Por isso **o painel não oferece excluir contratante, e não vai
oferecer.**

O caminho que este veto sempre apontou foi construído (migration
`0003_arquivamento.sql`): **arquivar** tira o contratante da lista,
**para a cobrança** e guarda tudo. O que "parar a cobrança" quer dizer,
concretamente, é que `buscarContratante` e `buscarContratantePorChave`
recusam arquivado — então link antigo passa a responder "contratante não
encontrado" e a api_key dele deixa de autenticar estorno, no mesmo
instante. Sem isso, arquivar seria só esconder da lista, e o parceiro
desligado continuaria cobrando; é a cláusula mais importante da
funcionalidade e tem teste próprio no `pedidoService.js`.

Arquivar é reversível num clique ("mostrar arquivados" → "Restaurar") —
porta de mão única não é arquivamento, é exclusão com outro nome.

**Subconta também só arquiva, e faz menos:** ela é uma conta na Asaas,
que continua existindo lá e continua recebendo split. Arquivar tira da
lista do painel e nada mais — não existe apagar subconta pela API da
Asaas sem entrar na conta dela, e a tela diz isso em vez de fingir que
exclui. Ao arquivar, o backend informa se o `wallet_id` dela ainda está
no cadastro de algum contratante ativo: aviso, não bloqueio.

Exclusão física segue possível **só pelo SQL Editor e só para
contratante sem nenhuma cobrança** — caso de linha criada por engano,
não de parceiro que saiu.

---

## 2. Limites assumidos (Lei 7)

- **Volume**: dimensionado para os projetos próprios do ecossistema
  (Trimundi9, Vitrina ADS e sucessores), não para ser gateway de mercado
  aberto. Não há evidência de necessidade de fila, cache distribuído ou
  réplica — e nenhum dos três existe, de propósito.
- **Moeda**: BRL, único.
- **Valor por cobrança**: R$ 0,01 a R$ 100.000,00 (`valorValido`).
- **Parcelamento**: 1 a 12 vezes.
- **Retenção de dado pessoal**: 5 anos contados da transação (CDC art.
  27 + guarda fiscal). A rotina de expurgo ainda não existe e a validação
  jurídica é da Estação 7 — ver `docs/inventario-de-dados.md` §6.
- **Gargalos conhecidos, em ordem de probabilidade**:
  1. **Plano gratuito do Render** — hiberna por inatividade. Mitigado com
     ping externo (cron-job.org) em `/api/saude` a cada 10 minutos, que
     de quebra mantém o Supabase ativo. **Quando o tráfego real começar,
     o plano pago é a ação** — está decidido, só não contratado.
  2. **Fila de reenvio de webhook em memória** — 3 tentativas
     (1min/5min/15min) via `setTimeout`. Reinício do processo perde a
     notificação pendente. A rede de segurança é a conciliação
     (`API.md` 5.2 para pedido, 5.3 para assinatura). Virar fila
     persistente só com evidência real de perda.
  3. **Chave de API da Asaas expira por inatividade** — os eventos
     `ACCESS_TOKEN_*` viram alerta em `/api/saude`.
  4. **Cota gratuita do Supabase** — projeto pausa com 7 dias sem
     consulta; o mesmo ping resolve.

---

## 2.1 Regra de schema: migrations numeradas e imutáveis (Lei 6)

Vale a partir de 11/09/2026.

- O schema vive em `supabase/migrations/`, em arquivos numerados
  (`0001_baseline.sql`, `0002_…`, `0003_…`), rodados **em ordem** no SQL
  Editor do Supabase.
- **Arquivo que já rodou em produção não é editado. Nunca.** Correção é
  migration nova. Editar o que já foi aplicado é o modelo que derrubou o
  painel de admin em produção —
  `docs/erros/2026-09-11-coluna-nao-criada-por-create-table-if-not-exists.md`.
- `0001_baseline.sql` é o retrato congelado de quando essa regra passou a
  valer. É idempotente, então roda em banco novo sem susto — mas ser
  idempotente não o torna um retrato garantido da produção; para conferir
  divergência, consulte o `information_schema` do banco real.
- Schema **nunca** é alterado por conexão direta com `DATABASE_URL`. As
  exceções que a Lei 6 admite (DML em runtime, backup/restauração,
  ferramenta somente-leitura, ambiente local) continuam valendo.

## 2.2 Eventos do webhook da Asaas — o que está marcado e por quê (Lei 7)

Conferido contra o painel da Asaas e contra a documentação oficial em
11/09/2026. Esta seção é a referência única do assunto: o que estiver
aqui é o que deve estar marcado no painel.

Três fatos mandam nela:

1. **A seleção é individual. Não existe "receber todos".** Evento não
   marcado **nunca chega**.
2. **Evento faltando falha em silêncio** — sem erro, sem log, sem 4xx. O
   pagamento acontece na Asaas e o pedido fica pendente para sempre do
   lado do contratante. É o modo de falha mais caro deste projeto.
3. **Marcar evento que o código ignora não é grátis:** ele chega, é
   logado inteiro (payload cru, com dado pessoal — pendência aberta no
   `CLAUDE.md`) e é descartado. Marcar o que tem uso, não tudo.

Webhook existente **pode ser editado** para acrescentar eventos — não é
preciso criar outro. O limite é de 10 webhooks por conta, cada um com seu
próprio conjunto.

**Onde os eventos nascem.** Toda cobrança é criada com a chave da
conta-mãe (`ASAAS_API_KEY`) levando `split` quando o contratante tem
`wallet_id` — a cobrança **não** nasce dentro da subconta, que só recebe
a parte dela. Por isso `PAYMENT_*` e `CHECKOUT_*` disparam na conta-mãe,
que é onde o webhook do checkout está.

### Grupo "Cobranças" — 17 marcados

Treze que o código trata:

`PAYMENT_CONFIRMED` · `PAYMENT_RECEIVED` · `PAYMENT_OVERDUE` ·
`PAYMENT_REFUNDED` · `PAYMENT_PARTIALLY_REFUNDED` ·
`PAYMENT_REFUND_IN_PROGRESS` · `PAYMENT_REFUND_DENIED` ·
`PAYMENT_AWAITING_RISK_ANALYSIS` · `PAYMENT_REPROVED_BY_RISK_ANALYSIS` ·
`PAYMENT_CREDIT_CARD_CAPTURE_REFUSED` · `PAYMENT_CHARGEBACK_REQUESTED` ·
`PAYMENT_AWAITING_CHARGEBACK_REVERSAL` · `PAYMENT_RECEIVED_IN_CASH_UNDONE`

Quatro que o código **não** trata, marcados de propósito para o payload
chegar e ficar no log — são dinheiro que não chegou ao contratante, e
hoje só se descobriria se ele reclamasse. Dar comportamento a eles em
código é construção de uma versão futura, não item de estação nenhuma
desta — entrada em `docs/proximas-versoes.md`:

`PAYMENT_APPROVED_BY_RISK_ANALYSIS` · `PAYMENT_SPLIT_DIVERGENCE_BLOCK` ·
`PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED` · `PAYMENT_SPLIT_CANCELLED`

`PAYMENT_SPLIT_DONE` fica **fora** de propósito: é o caminho feliz,
dispara em toda cobrança com split e não informa nada que a confirmação
já não tenha dito — só engorda o log.

### Grupo "Checkouts" — 3 marcados

`CHECKOUT_PAID` · `CHECKOUT_CANCELED` · `CHECKOUT_EXPIRED` — os três
tratados. `CHECKOUT_CREATED` fica fora: a sessão é criada por nós, já
sabemos.

### Grupo "Chaves de API" — 4 marcados

`ACCESS_TOKEN_EXPIRING_SOON` · `ACCESS_TOKEN_EXPIRED` ·
`ACCESS_TOKEN_DISABLED` · `ACCESS_TOKEN_DELETED` — alimentam o alerta de
chave prestes a expirar em `/api/saude` (gargalo 3 da seção 2). Sem eles
a integração morre sozinha um dia, sem aviso. `CREATED` e `ENABLED` ficam
fora: o código os descarta explicitamente por serem rotina.

### Grupos "Transferências", "Movimentações Internas" e "Bloqueios de Saldo" — marcados

`TRANSFER_*`, `INTERNAL_TRANSFER_*` e `BALANCE_VALUE_*` falam da conta
do operador (saque, movimentação interna, saldo bloqueado), não do
pedido de um comprador — **o código não trata nenhum deles**. Estavam
fora até 11/09/2026 exatamente por isso; passaram a ser marcados quando
o log de auditoria (§2.5) deu a eles um destino visível, em vez de uma
linha no console do Render que ninguém lê.

Caem no ramo de evento não mapeado, respondem 200 e viram linha na aba
Webhook do painel. O leitor futuro é a Fairy, que é quem vai cuidar de
aviso financeiro — ver `docs/proximas-versoes.md`.

### Grupo "Situação da conta" — 18 marcados, o grupo inteiro

São 18 eventos em quatro famílias (`GENERAL_APPROVAL`, `COMMERCIAL_INFO`,
`BANK_ACCOUNT_INFO`, `DOCUMENT`, cada uma com
APPROVED/AWAITING_APPROVAL/PENDING/REJECTED), e o código trata **por
prefixo** — aceita qualquer nome da família. Volume é baixo: situação de
subconta muda raramente.

Alimentam a coluna de situação da subconta no painel administrativo.
Payload conferido na doc: `account.id` + `accountStatus.{general,
commercialInfo, bankAccountInfo, documentation}` — exatamente o que
`processarEventoSubconta` lê, e cada evento traz as quatro situações, não
só a que mudou.

> ⚠️ **Inferência ainda não confirmada ao vivo:** o código assume que a
> conta-mãe recebe os eventos de situação **das subcontas**, e não só da
> própria conta. O payload documentado tem um campo `ownerId` (nulo no
> exemplo, que é a própria conta), o que sustenta a leitura de que
> subconta preenche esse campo apontando para a mãe — mas a documentação
> não afirma isso. Se a suposição estiver errada, o efeito é uma coluna
> que nunca atualiza; nada quebra. O primeiro evento real resolve.

Subconta **pode** ter webhook próprio (campo `webhooks` na criação). Este
projeto não usa isso e não precisa no modelo atual. Se um dia a subconta
passar a emitir cobrança própria, o roteamento precisa ser confirmado
antes, não presumido.

### Grupos deliberadamente desmarcados

- **Notas fiscais (`INVOICE_*`)** — só disparam para nota emitida *nesta*
  conta, e este projeto não emite nenhuma (§1.9). A nota do contratante
  sai do sistema dele e não toca nossa conta Asaas: não chegaria aqui nem
  se quiséssemos. Não há nada "passando por nós" para repassar.
- **Créditos Pix (`PIX_CREDIT_*`)** — Pix sem cobrança vinculada (venda
  física). Aqui sempre existe cobrança.
- **Ruído de cobrança** — `PAYMENT_CREATED`, `PAYMENT_UPDATED`,
  `PAYMENT_DELETED`, `PAYMENT_RESTORED`, `PAYMENT_ANTICIPATED`,
  `PAYMENT_AUTHORIZED`, `PAYMENT_DUNNING_*`, `PAYMENT_BANK_SLIP_VIEWED`,
  `PAYMENT_CHECKOUT_VIEWED`. `PAYMENT_BANK_SLIP_CANCELLED` e
  `PAYMENT_CHARGEBACK_DISPUTE` também ficam fora: são estados
  intermediários de algo que o pedido já registrou por outro evento
  (`vencido` e `chargeback`).
- **Pix Automático** — ver §2.4: o grupo está indisponível nesta conta,
  com uma exceção.

**Grafia que engana:** `CHECKOUT_CANCELED` tem **um** L e
`PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED` tem **dois**. As duas
estão assim na documentação oficial e assim no código.

## 2.3 A Asaas PAUSA o webhook depois de 15 falhas seguidas (Lei 7)

Descoberto na documentação oficial em 11/09/2026, e é limite assumido
porque muda o que acontece num dia ruim: **após 15 falhas consecutivas a
fila é interrompida e só volta com reativação manual**, e os eventos
ficam retidos por **14 dias** — depois disso são apagados de vez.

Por que isso importa aqui mais que em outro projeto: o backend roda no
plano gratuito do Render, que hiberna (gargalo 1). O `sempre 200` do
`receberWebhookAsaas` existe justamente para nunca contar como falha —
mas ele só protege enquanto o serviço responde. Serviço fora do ar
durante uma janela de deploy ruim, ou uma queda de mais de 15 eventos
seguidos, derruba a fila inteira **sem alarme do nosso lado**.

O que fazer quando acontecer: reativar o webhook no painel da Asaas e
rodar a conciliação (`API.md` 5.2 para pedido, 5.3 para assinatura)
sobre tudo que ficou "aguardando pagamento" — é ela que recupera o que a
fila perdeu, desde que dentro dos 14 dias.

**Detectar isso ainda não existe**, e é entrada em
`docs/proximas-versoes.md`, não item desta versão: não há nada que avise
que a fila foi pausada. Hoje a descoberta seria por
ausência — ninguém recebe confirmação nenhuma — que é o pior jeito.

## 2.4 Pix Automático: indisponível nesta conta, menos um evento (Lei 7)

O grupo tem **10 eventos**, conferidos na documentação oficial da Asaas
em 11/09/2026 (*Eventos para Pix Automático*), e eles não são
intercambiáveis:

| Família | Eventos | O código trata? |
|---|---|---|
| Elegibilidade | `..._ELIGIBILITY_UPDATED` | **Não** |
| Autorização | `..._AUTHORIZATION_` + `CREATED`, `ACTIVATED`, `CANCELLED` (dois L), `EXPIRED`, `REFUSED` | **Sim**, pelo prefixo |
| Instrução de pagamento | `..._PAYMENT_INSTRUCTION_` + `CREATED`, `SCHEDULED`, `REFUSED`, `CANCELLED` (dois L) | **Não** |

Conferido no painel da Asaas na mesma data: os de **autorização** e os
de **instrução de pagamento** estão desabilitados, com a mensagem *"O
Pix Automático não está disponível para sua conta no momento."*

`PIX_AUTOMATIC_RECURRING_ELIGIBILITY_UPDATED` é a exceção: **está
disponível para marcar** mesmo com o resto do grupo bloqueado. Faz
sentido — ele é o aviso de que a elegibilidade da conta mudou, ou seja,
o evento que anuncia a liberação que os outros esperam. É o único jeito
de saber que a Asaas liberou sem ficar conferindo o painel na mão.

**O código não trata este evento**, e não há prefixo que o alcance:
`..._ELIGIBILITY_UPDATED` não começa com `..._AUTHORIZATION_`. Marcado,
ele cai no ramo de evento não mapeado, responde 200 e vira linha na aba
Webhook — que é exatamente o uso pretendido, e por isso não é mudança de
código.

**Quando ele aparecer, o painel já mostra o que fazer.** A instrução
está no `adminController.js` (`INSTRUCOES_POR_EVENTO`) e aparece junto
do evento na tela, em vez de morar só aqui — instrução que depende de
alguém lembrar deste documento no dia certo não é instrução. Ela diz:

1. Conferir no painel da Asaas se a conta foi **liberada** — o mesmo
   evento dispara se ela for bloqueada.
2. Marcar **os cinco de autorização**, que são os que o código trata.
3. Marcar também `..._PAYMENT_INSTRUCTION_REFUSED`: é cobrança da
   recorrência que não foi agendada, ou seja, dinheiro que não entra. O
   código ainda não trata — cai no log, como os de split.
4. **Não** marcar `..._PAYMENT_INSTRUCTION_CREATED`, `_SCHEDULED` nem
   `_CANCELLED`: disparam a cada cobrança da recorrência e não dizem
   nada que a confirmação já não diga. Mesmo critério que mantém
   `PAYMENT_SPLIT_DONE` fora.
5. Só **depois** disso habilitar "Assinatura por Pix" em algum
   contratante.

O fluxo completo (`assinatura_pix`) está implementado e o `API.md` o
documenta na seção 7.2 — mas ele **não funciona hoje**, e isso não é
defeito: depende de liberação da Asaas. O projeto já trata isso certo
por desenho: no cadastro de contratante, "Assinatura por Pix" **nasce
desmarcada**, com a explicação na própria tela. Habilitar o método antes
da liberação criaria um caminho de pagamento que falha na hora de
cobrar.

## 2.5 O log de auditoria do webhook não guarda payload (Leis 7 e 8)

Criado em 11/09/2026 pela migration `0002_webhook_auditoria.sql`. É o
que dá destino visível ao evento que o código não trata — antes dele,
esse evento virava `console.log` no Render e sumia, o que tornava inútil
marcar evento "para usar um dia".

Os limites que ele assume, e que são o motivo de estar aqui e não só no
`README`:

- **O payload cru não é gravado, e não é mais nem impresso.** O que
  entra é o resultado da redação por **lista branca** de nome de campo
  (`redigirPayload`, em `src/services/auditoriaWebhookService.js`): o
  que não está na lista vira só o **caminho da chave**, sem valor. Lista
  branca e não lista negra porque lista negra falha aberta, e falhar
  aberta aqui é CPF no banco. Isso fechou a pendência da Lei 10 sobre
  dado pessoal em log (ver `docs/inventario-de-dados.md` §7).
- **Retenção de 90 dias**, com o expurgo rodando de fato (`server.js`,
  no boot e a cada 24h). Log de diagnóstico não herda os 5 anos do dado
  de cobrança.
- **Tentativa recusada pela guarda de origem não vira uma linha por
  requisição.** É contada em memória e descarregada por hora, com no
  máximo 20 amostras por hora. Isso não é economia: essa contagem é
  alimentada por requisição **não autenticada**, e uma linha por
  tentativa daria escrita ilimitada no banco a quem só descobriu a URL.
- **O token recusado nunca é gravado** — é credencial em texto puro, e
  quem errar uma letra do token certo gravaria o token certo.
- **A auditoria nunca derruba o webhook.** A escrita não é aguardada
  antes do 200, porque resposta lenta conta como falha para a Asaas e 15
  falhas seguidas pausam a fila (§2.3). Perder uma linha de log é
  aceitável; perder a fila não é.

**O que este log NÃO faz:** detectar que a fila da Asaas foi pausada.
Fila pausada não manda evento, então o que existe é ausência — o painel
mostra "último evento recebido há X", o que a torna visível para quem
olha, mas não avisa ninguém. Detecção de verdade está em
`docs/proximas-versoes.md`.


## 2.6 Como o painel administrativo é protegido (Lei 4)

Decidido em 11/09/2026, depois de o arranjo anterior quebrar em produção
(`docs/erros/2026-09-11-guarda-de-total-zero-derrubou-a-porta-do-admin.md`).

**O que havia até aqui, e por que saiu.** O caminho do painel era
escondido dentro do checkout público: um contratante de mentira
(`admin-master`) devolvia um pedido de R$ 0,00, a tela renderizava, e
digitar um e-mail específico no campo de e-mail redirecionava para
`admin.html`. Isso escondia o caminho de quem **olhava o checkout** e de
mais ninguém — `https://checkout.sancocore.com.br/admin.html` sempre
respondeu direto, para qualquer um, sem passar por nada. Em troca, o
arranjo custava uma linha na tabela de contratantes, uma rota montada na
raiz do backend, um id de pedido fantasma alcançável na página pública de
status, e um ponto de acoplamento entre a porta de operação e o fluxo de
pagamento — que foi exatamente o que quebrou.

Removidos: `masterController.js`, `masterRoutes.js`, a rota na raiz, o
contratante `admin-master` e o `ligarAtalhoAdmin()` do `app.js`.

**O que protege o painel agora**, em camadas independentes:

1. **Cloudflare Access sobre `/admin.html`** — configurado e verificado
   ao vivo em 11/09/2026. Aplicativo auto-hospedado "Painel admin do San
   Checkout", plano Zero Trust Free, política **"Somente o operador"**
   (ação Permitir, regra: e-mail do dono) — e políticas de Access negam
   por padrão, então qualquer outro e-mail é recusado sem precisar de
   regra própria.

   **Dois destinos, não um**, e o segundo é o que fecha a porta dos
   fundos: todo projeto no Cloudflare Pages responde também no domínio
   `*.pages.dev`, então `san-checkout.pages.dev/admin.html` era um
   caminho alternativo para a mesma página, sem passar por nada.
   Proteger só o domínio próprio teria deixado a porta aberta ao lado.
   Os dois destinos são `.../admin.html`, com caminho específico — o
   checkout público NÃO passa pelo Access, e isso foi conferido abrindo
   `index.html` depois de configurar.

   A diferença para a obscuridade que havia antes é de natureza:
   obscuridade depende de ninguém adivinhar, Access depende de alguém
   provar quem é.
2. **Usuário e senha validados no backend**, em toda rota de
   `/api/admin` (`verificarAdminKey`), com scrypt a N=2^17. Vale mesmo
   que a camada 1 caia ou não esteja configurada, e é ela que protege a
   API — que fica em outro domínio e não passa pelo Access.
3. **`X-Robots-Tag: noindex, nofollow, noarchive`** em `public/_headers`,
   para `/admin.html` e `/status.html`.

**Por que NÃO existe `robots.txt` neste projeto:** um `robots.txt` com
`Disallow: /admin.html` publica exatamente o caminho que se quer
esconder — é lido por qualquer um, e vira índice do que interessa. O
header alcança o mesmo buscador sem anunciar nada. Se alguém propuser
criar o arquivo "por padrão", esta é a razão de não criar.

**Limite assumido, declarado:** a API (`/api/admin/*`) fica em outro
domínio, no Render, e **não passa pelo Access** — quem a protege é só a
camada 2. Isso é o desenho, não descuido: o Access da Cloudflare cobre o
que a Cloudflare serve. Consequência prática: a senha do admin continua
sendo a única barreira da API, e a pendência de ela trafegar em todo
request (`X-Admin-Pass`) segue aberta e segue valendo.

**Se o operador perder o acesso ao e-mail cadastrado**, o caminho de
volta é o próprio painel da Cloudflare, com a conta dela — não há
dependência circular entre as duas camadas.

**Renomear o arquivo para algo imprevisível** foi considerado e recusado:
troca uma fechadura por um segredo que vive em URL — histórico do
navegador, favoritos, cabeçalho de referência — e acrescenta risco de o
operador único perder o próprio acesso. Obscuridade não vira segurança
por ser mais difícil de adivinhar.

---

## 3. Exceções de conformidade registradas

Exceção aceita entra aqui com a lei, o motivo e a data — exceção
esquecida não é conformidade.

### Lei 6 · não há backup do banco — exceção COM GATILHO, 11/09/2026

A Lei 6 exige backup automático do que não pode ser perdido, testado ao
menos uma vez. **Não existe backup nenhum hoje.** O plano gratuito da
Supabase não inclui backup automático (conferido em 11/09/2026 na página
de preços: *"Automatic backups — Not included in free"*; Pro dá 7 dias de
retenção, Team 14), e não há rotina própria no repositório.

**Decisão do dono: roda sem backup por enquanto**, pela mesma lógica do
plano gratuito do Render — o volume real ainda não começou, e o dado em
risco hoje é de teste, não histórico financeiro de cliente.

**O gatilho, que é o que torna isto exceção e não omissão: o primeiro
pagamento real de terceiro fecha esta exceção.** A partir daí, rodar sem
backup deixa de ser aceitável — perder o projeto Supabase passaria a
significar perder o histórico financeiro de todos os contratantes, sem
cópia em lugar nenhum. A ação nesse dia é Supabase Pro (backup diário,
7 dias, com Point-in-Time Recovery disponível), junto do plano pago do
Render que já está decidido. Backup só conta como feito depois de uma
restauração testada pelo menos uma vez.

### Lei 1 · `infra/` não existe — 11/09/2026
Não há infraestrutura como código neste projeto, e por isso a pasta não
foi criada vazia. As duas configurações de deploy que existem não podem
morar nela:

- **Cloudflare Pages** exige o `_headers` dentro do diretório publicado —
  por isso ele é `public/_headers`, e não `infra/_headers`.
- **Render** é configurado pelo painel, sem arquivo no repositório.

Revisar esta exceção no dia em que houver Terraform, Pulumi ou qualquer
descrição versionada de infraestrutura.

### Lei 2 · `taxaService` alcança `asaasService` — 11/09/2026
A Lei 2 diz que módulo de domínio não importa infraestrutura. Aqui
`taxaService`, que guarda a fórmula da taxa, busca as taxas reais da
conta no `asaasService`. **Decisão do dono: fica como está.** Razões:

- `services/` é a camada de infraestrutura deste projeto por desenho —
  todos os outros importam `config/supabase.js`. `taxaService` não é uma
  exceção isolada, é a regra da pasta.
- A parte pura (`calcularTaxa`) é síncrona, não importa nada, e roda
  isolada — verificado: `node src/services/taxaService.js` passa as 13
  checagens sem `.env`.
- A orquestração já está no lugar certo (`server.js` chama a
  sincronização no boot e a cada 24h).

Mexer aqui é alterar rota de dinheiro por arrumação arquitetural, sem
defeito observado. Revisar se um dia existir uma camada de domínio
separada de verdade.

### Lei 2 · `webhookController.js` e `adminController.js` são grandes — 11/09/2026
Os dois fazem mais de uma coisa (`webhookController` trata três
vocabulários de evento, mais notificação e retry; `adminController` faz
contratantes, subcontas e métricas). **Decisão do dono: não dividir
agora.** As leis não estabelecem limite de tamanho, e dividir um
controller que **nunca recebeu um webhook real em produção** troca um
risco conhecido por um desconhecido. Revisar depois que assinatura e
estorno tiverem rodado ao vivo.
