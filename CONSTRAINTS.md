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

### 1.11 Cobrar pedido de valor zero — VETADO (decidido em 13/09/2026)

Pedido que não vale nada **não vira cobrança**, com taxa ligada ou
desligada. O que existe hoje já recusa (`valorValido`: de R$ 0,01 a
R$ 100.000), mas a regra estava só no código; aqui está o porquê.

**Com a taxa ligada**, cobrar zero significa cobrar **só a taxa** — o
comprador paga R$ 1,49 para levar nada. Não há como explicar isso na
tela, e não é o que o contratante quis dizer quando mandou um pedido
sem preço.

**Com a taxa desligada**, sobra uma cobrança de R$ 0,00, que é pior:
ela ocuparia uma linha em `cobrancas`, dispararia `cobranca_confirmada`
no webhook do contratante e entraria na métrica de sucesso — "cobrança
confirmada por contratante" (`docs/funcional.md` §9) passaria a contar
pagamento que ninguém fez. Uma métrica que conta zero como sucesso
deixa de servir para decidir qualquer coisa.

**O caminho certo é do lado do contratante:** benefício gratuito se
libera no projeto que vende, sem passar pelo checkout. O modelo pull já
funciona assim por desenho — quem decide mandar o comprador para cá é o
contratante, e pedido sem preço é sinal de que não havia o que cobrar.

Consequência na tela, escrita em `docs/funcional.md` §4.1: pedido sem
valor cobrável cai no estado **indisponível** (`R$ —`, sem botão), e não
numa compra de R$ 1,49. Foi assim que o veto apareceu — como bug, antes
de virar regra escrita
(`docs/erros/2026-09-13-o-guarda-de-total-olhava-o-numero-errado.md`).

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
  0. **Memória e CPU da instância: `nf-compute-50` no Northflank —
     0,5 vCPU e 1024 MiB.** Atualizado em 13/09/2026: até 12/09 a
     produção era o Render, com 512 MiB, e o texto anterior aqui
     descrevia aquela instância.
     A lição que trouxe este item para a lista continua valendo e não é
     sobre o tamanho: em 11/09/2026 a instância estourou de verdade, com
     duas derivações scrypt de ~128 MiB ao mesmo tempo, e a reação
     natural — "pagar o plano maior" — não teria resolvido. **A
     contenção foi limitar a simultaneidade no código, não comprar
     memória** (Lei 7; ver o limite declarado logo abaixo). O dobro de
     memória de hoje dá folga, não imunidade.
  1. **Custo por consulta ao banco: 50-270 ms, e é o piso da
     experiência.** Medido em 13/09/2026 **do navegador do operador**:
     rota sem banco 20-29 ms, rota com uma consulta 70-295 ms (mediana
     ~90). Não é geografia (backend em Osasco, Supabase em `sa-east-1`) e
     não é índice faltando (o linter só acusa índices não usados). É
     compute compartilhado do plano gratuito do Supabase, e só sai com
     plano pago. O código foi ajustado para **não multiplicar** esse
     número — chamadas do painel em paralelo, mutação sem rebuscar a
     lista. O Northflank não hiberna, então o gargalo de hibernação que
     existia no Render deixou de existir; o ping de 10 min em
     `/api/saude` continua, agora só para manter o Supabase ativo.
  2. **Fila de reenvio de webhook em memória** — 3 tentativas
     (1min/5min/15min) via `setTimeout`. Reinício do processo perde a
     notificação pendente. A rede de segurança é a conciliação
     (`API.md` 5.2 para pedido, 5.3 para assinatura). Virar fila
     persistente só com evidência real de perda.
  3. **Chave de API da Asaas expira por inatividade** — os eventos
     `ACCESS_TOKEN_*` viram alerta em `/api/saude`.
  4. **Cota gratuita do Supabase** — projeto pausa com 7 dias sem
     consulta; o mesmo ping resolve.
- **Custo de memória do hash de senha, e o teto de simultaneidade**
  (declarado em 13/09/2026, exigido pela Lei 7 e por
  `seguranca-san/references/senha-e-kdf.md`): scrypt a N=2^17, r=8, p=1
  consome `128 × N × r` bytes por derivação **em andamento**, ou seja
  **~128 MiB cada**. Numa instância de 1024 MiB, com o Node e o cliente
  Supabase já ocupando espaço, o teto seguro é **uma derivação por vez** —
  e é isso que `src/utils/senhaAdmin.js` impõe, com fila no código, não
  só limite por minuto. Limite de taxa não impede duas ao mesmo tempo;
  foi assim que a produção caiu em 11/09/2026. Desde o token de sessão
  (§2.6), a derivação roda **uma vez por login**, não uma por requisição,
  então a fila quase nunca é exercida — mas ela é o que impede a queda,
  não a raridade.
- **Limites de taxa e de tamanho**: ver §2.7 — declarados lá pelo que
  entregam de fato, não pelo número na configuração.

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

> **Conferido contra a conta, não contra a memória (16/09/2026).**
> `GET /v3/webhooks` rodado de dentro do container de produção: **53
> eventos configurados**, e entre eles **zero `SUBSCRIPTION_*`**. O que
> esta seção lista bate com o que está marcado lá — e a única ausência
> que importa é a das assinaturas, tratada logo abaixo.

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

### Grupo "Assinaturas" (`SUBSCRIPTION_*`) — desmarcado, e **não** por decisão

Medido em 16/09/2026: nenhum evento desse grupo está entre os 53
configurados. Isso nunca foi uma escolha registrada — esta seção
simplesmente não mencionava o grupo, o que é a falha que a própria
declaração de "referência única" existe para impedir.

Consequência: assinatura encerrada fora do nosso fluxo (cancelada direto
no painel, ou encerrada pela Asaas após falhas de cobrança) **não chega
por aviso**. Desde 16/09 ela chega por conciliação — `POST
/consultar-assinatura` reconfere o estado real contra
`GET /v3/subscriptions/{id}` (RN-26) —, então a divergência deixou de ser
permanente, mas continua tendo o atraso de quem concilia.

Marcar o grupo e tratar os eventos é trabalho aberto, e **exige medir
antes de codificar**: ler o payload real de um evento antes de escrever
tratamento. Escrever contra payload imaginado é exatamente o que causou
os dois bugs de 15/09. `docs/pendencias.md`.

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
da liberação criaria um caminho de pagamento que falha na hora de cobrar
— o comprador escolhe e a cobrança não sai.

> ⚠️ **Isso esteve QUEBRADO até 11/09/2026, e o documento afirmava o
> contrário.** O `admin.html` trazia a caixa desmarcada, mas
> `abrirModalContratante` a sobrescrevia: sem contratante para copiar,
> ele caía na lista `METODOS`, que inclui `assinatura_pix`. Duas fontes
> para o mesmo padrão, e a que valia era a errada — contratante criado
> nesse período pode ter saído com o método habilitado, então vale
> conferir os cadastros existentes. Corrigido com uma constante só
> (`METODOS_PADRAO`, espelho do `default` da coluna no banco).

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


## 2.5.1 A captura de exceção agrega, e por isso não vira porta de escrita (Leis 7 e 8)

Criada em 16/09/2026 pela migration `0007_captura_de_erro.sql`. É a
"captura de erro com contexto" que a Lei 8 exige, sem depender de conta
em serviço externo.

O limite que importa, e o motivo de estar aqui:

- **A chave primária é a impressão digital do erro**
  (contexto + tipo + primeiro quadro da pilha), não um id por
  ocorrência. Repetição vira `ocorrencias + 1`. Sem isso, qualquer rota
  pública que devolvesse 500 seria escrita ilimitada no banco para quem
  só descobriu a URL — o mesmo risco que a §2.5 já tinha resolvido para
  as tentativas recusadas do webhook, por outro caminho. **O tamanho da
  tabela é limitado pelos pontos de erro que existem no código**, não
  pelo tráfego.
- **A mensagem não entra na impressão digital.** Se entrasse, o mesmo
  bug com outro id no texto viraria linha nova e a agregação não
  agregaria nada. Travado por teste, verificado por sabotagem.
- **Só 5xx é capturado.** Validação recusada é o sistema funcionando;
  gravá-la encheria a tabela com tráfego normal e apagaria o sinal.
- **O incremento é atômico, no banco** (`registrar_erro`, com
  `search_path = ''` pela regra da 0004). Ler-somar-escrever na
  aplicação perde contagem em rajada — que é o único momento em que a
  contagem importa.
- **A captura nunca derruba a requisição**: não é aguardada e engole a
  própria falha. Observabilidade que vira defeito deixou de ser
  observabilidade.
- **Nada de pessoa entra** — ver `docs/inventario-de-dados.md` §7.2.

## 2.5.2 O processo de produção roda em UTC — data local do servidor é errada (Lei 7)

Medido em 16/09/2026, dentro do contêiner: `node:22-alpine`, `TZ` **não
definida**, então `Intl.DateTimeFormat().resolvedOptions().timeZone`
devolve `UTC`. Consequência para qualquer conta por data:

- `getDate()`, `getHours()` e `toLocaleDateString()` **sem fuso
  explícito** devolvem dia de UTC. Das 21h à meia-noite de Brasília isso
  já é o dia seguinte — **três horas por dia em que "hoje" está errado**.
- Toda conta por dia civil passa por `src/utils/diaCivil.js`, que aplica
  `America/Sao_Paulo` explicitamente. Nada de `-03:00` chumbado: offset
  fixo é decidir hoje o que vale até a próxima mudança de regra do país.

Medido junto, e é o que torna a solução possível: **o fuso nomeado
funciona** nesta imagem (ICU completo). Se um dia a imagem passar a ter
ICU reduzido, `Intl` com fuso nomeado cai para UTC **em silêncio** e a
métrica fica errada sem avisar — por isso o autoteste de `diaCivil.js`
falha nesse caso. É a única coisa que impede essa regressão de passar.

Definir `TZ=America/Sao_Paulo` no serviço resolveria o sintoma e é
**pior**: a data passaria a depender de uma variável de ambiente que
ninguém vê no código, e log em UTC é o que se quer num serviço. O fuso
fica explícito onde a conta acontece.

## 2.5.3 Subconta exige que a conta-mãe seja PJ no REGISTRO, não no comercial (Lei 7)

Medido no sandbox em 17/09/2026, com controle positivo.

**A conta-mãe deste projeto não cria subconta**, e o motivo é o tipo de
pessoa dela. A Asaas guarda duas identidades separadas na mesma conta:

| endpoint | `personType` | documento |
|---|---|---|
| `/v3/myAccount` — o **registro** | `FISICA` | CPF |
| `/v3/myAccount/commercialInfo` — o **comercial** | `JURIDICA` | CNPJ (`LIMITED`) |

Com `commercialInfo`, `general` e `documentation` todos `APPROVED`. A
conta parece PJ no painel; a regra de subconta olha o **registro**, e
`POST /v3/accounts` devolve `403`.

**Preencher o CNPJ da empresa nas informações comerciais não converte a
conta.** Converter o registro é pedido ao suporte da Asaas.

**O documento da subconta é irrelevante enquanto isso valer:** CPF e
CNPJ levam o **mesmo 403, com a mensagem idêntica** — testado nos dois.
Sem esse controle positivo a leitura natural do erro (que culpa "contas
de pessoa física") levaria a concluir que a restrição é sobre a subconta.

**Consequência para o modelo de negócio, e é a que importa:** sem
subconta não há `wallet_id`, e sem `wallet_id` a cobrança não leva
`split` — **100% de toda cobrança cai na conta-mãe**, e o repasse ao
contratante é manual, por fora do sistema. A tabela `subcontas` e a tela
do painel existem e ficam sem uso. Isso não quebra nada no caminho do
dinheiro; muda quem recebe primeiro.

**Virou decisão em 17/09/2026, não pendência:** o dono optou por operar
na conta como ela está. A exceção com o custo escrito está na §3 ("sem
split: 100% da cobrança cai na conta-mãe"), e a conversão do registro é
atualização futura (`docs/proximas-versoes.md`), com gatilho no segundo
contratante.

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

   > **Furo encontrado e fechado no mesmo dia (11/09/2026).** O
   > Cloudflare Pages serve o mesmo arquivo **também sem a extensão** —
   > `/admin` entrega `admin.html` — e a política casa caminho exato.
   > Durante algumas horas, requisição sem cookie nenhum a
   > `checkout.sancocore.com.br/admin` **recebia o painel**, sem passar
   > pelo Access.
   >
   > O aplicativo tem hoje **quatro destinos**, não dois: `/admin.html` e
   > `/admin` em cada um dos dois domínios. Conferido depois: `/admin` nos
   > dois passa a ser interceptado, e `/index.html` continua público —
   > que é o teste que importa nos dois sentidos, porque caminho mal
   > escopado colocaria o Access na frente do checkout inteiro.
   >
   > **A lição atravessa o caso, e é de método:** testar controle de
   > acesso de dentro da sessão autenticada não testa nada. O primeiro
   > teste passou porque o navegador já tinha o cookie do Access — a
   > verificação tem que vir de onde não há cookie, e tem que cobrir as
   > outras grafias da mesma URL: com e sem extensão, com e sem barra
   > final.

2. **Token de sessão validado no backend**, em toda rota de
   `/api/admin` (`verificarAdminKey`). Vale mesmo que a camada 1 caia ou
   não esteja configurada, e é ela que protege a API — que fica em outro
   domínio e não passa pelo Access. Como o token nasce e como ele é
   conferido está logo abaixo, em "A sessão do admin".
3. **`X-Robots-Tag: noindex, nofollow, noarchive`** em `public/_headers`,
   para **seis** caminhos: `/admin.html`, `/admin`, `/admin/`,
   `/status.html`, `/status` e `/status/`.

   > **Corrigido em 11/09/2026, no ciclo da Estação 6.** Eram dois
   > caminhos, e o header não chegava em nenhuma página. O Pages responde
   > 308 de `/status.html` para `/status`, então a regra grudava o header
   > no **redirecionamento** — o buscador segue o 308 e recebe a página
   > final sem `noindex`. Medido: `/status.html` devolvia o header num
   > 308, `/status` devolvia 200 sem ele. É o mesmo erro do furo do
   > `/admin` acima, na camada de cima, e a mesma lição: a regra cita o
   > caminho que o servidor **entrega**.
   > (`docs/erros/2026-09-11-noindex-existia-no-arquivo-e-nao-na-web.md`)

**O `robots.txt` e o que ele não pode dizer.**

> **Corrigido em 13/09/2026.** Este parágrafo dizia "não existe
> `robots.txt` neste projeto". Existia: `/robots.txt` respondia — o
> automático da Cloudflare, não um nosso. A frase estava certa sobre o
> repositório e errada sobre a web, que é o mesmo formato de engano do
> `noindex` que existia no arquivo e não existia na web
> (`docs/erros/2026-09-11-noindex-existia-no-arquivo-e-nao-na-web.md`).
> Conferir no navegador, não no `ls`.

Desde 13/09/2026 existe um `public/robots.txt` nosso, e ele **não lista
`/admin` nem `/status`**.

> **O que o navegador recebe não é só o nosso arquivo.** Medido em
> produção depois do deploy de 13/09: a Cloudflare **prepende um bloco
> gerenciado** ao nosso conteúdo — `Content-Signal:
> search=yes,ai-train=no,use=reference` num grupo `User-agent: *`, mais
> `Disallow: /` para uma lista de rastreadores de IA (GPTBot, ClaudeBot,
> CCBot, Google-Extended, Bytespider e outros). Só depois vem o nosso
> grupo. Isso é configuração do painel da Cloudflare, não deste
> repositório, e vale saber ao ler o arquivo servido: `curl` mostra as
> duas coisas juntas.
>
> Os dois grupos `User-agent: *` se somam pela especificação, e não se
> contradizem — os dois dizem `Allow: /`. E o nosso `Allow: /` **não
> afrouxa** os `Disallow` de IA: rastreador que tem grupo próprio ignora
> o grupo `*`. Um `Disallow: /admin.html` publicaria
exatamente o caminho que se quer esconder: `robots.txt` é lido por
qualquer um e vira índice do que interessa. Quem cuida de indexação
dessas duas áreas é o `X-Robots-Tag` acima, que alcança o mesmo buscador
sem anunciar nada a quem não pediu.

O que o arquivo carrega é só o ponteiro para o `sitemap.xml`, e o
sitemap lista duas páginas — Termos e Privacidade. O checkout aberto sem
`?c=` e `?pedido=` não é conteúdo indexável, e as duas áreas `noindex`
não entram ali pelo mesmo motivo de não entrarem no `robots.txt`.

**Limite assumido, declarado:** a API (`/api/admin/*`) fica em outro
domínio (`api.sancocore.com.br`, hoje no Northflank) e **não passa pelo
Access** — quem a protege é só a camada 2. Isso é o desenho, não
descuido: o Access da Cloudflare cobre o que a Cloudflare serve.

### A sessão do admin (substituiu a senha por requisição em 12/09/2026)

**Como era, e por que saiu.** O painel guardava `{usuario, senha}` em
`sessionStorage` em texto puro e mandava `X-Admin-User`/`X-Admin-Pass`
em toda chamada; o servidor rodava scrypt a N=2^17 a cada requisição.
Três defeitos num arranjo só, e nenhum deles aparecia na tela: a senha
ficava legível para qualquer XSS ou extensão que lesse storage, cada
clique custava ~830 ms de CPU, e um 401 no meio da sessão não limpava
nada — a aba seguia reenviando a senha velha, pagando uma derivação por
tentativa.

**Como é agora.** A senha entra em **um** ponto, `POST
/api/admin/sessao`, e é trocada por um token. Nada além do token fica no
navegador.

- **Formato:** `base64url(conteúdo).base64url(HMAC-SHA256)`, conteúdo
  `{u: usuário, exp: vencimento, n: 9 bytes aleatórios}`. Verificação em
  ~25 µs, contra os ~830 ms do scrypt.
- **A chave que assina é derivada do `CHECKOUT_ADMIN_PASS_HASH`**, não
  de um segredo novo. Duas consequências deliberadas: **trocar a senha
  do admin invalida todas as sessões abertas**, de graça, sem lista de
  revogação; e não existe variável de ambiente nova que, faltando,
  faria o sistema falhar aberto.
- **Validade de 8 horas**, no `exp` assinado. Token sem `exp` é
  recusado — falha fechada, não aberta.
- **A assinatura é conferida ANTES do conteúdo**, com
  `timingSafeEqual`. Conferir o conteúdo primeiro seria decidir a partir
  de dado não autenticado.
- **`/api/admin/sessao` é a única rota antes da guarda**, e tem o teto
  mais apertado do projeto: **5/min**. É o único lugar caro que sobrou,
  e a 10/min um atacante consumiria 8,3 s de CPU por minuto numa
  instância de 0,5 vCPU só tentando adivinhar. O resto de `/api/admin`
  passou de 10/min para 60/min, porque ficou barato.
- **Um 401 com `sessaoExpirada` derruba o painel para a tela de login**,
  com a razão escrita.

**Limites que continuam valendo, ditos por inteiro:**

- **A senha ainda passa pelo navegador uma vez**, no corpo do POST de
  login. Uma XSS ativa no exato momento da digitação a alcança. A CSP
  (`script-src 'self'` sem `unsafe-inline`) é o que impede o script
  injetado de executar, e por isso ela é parte da proteção da
  credencial, não só higiene de cabeçalho — a XSS encontrada no ciclo de
  revisão da Estação 5 (`celulaCampos`, dados do payload interpolados
  sem escape) era exatamente esse par.
- **O token no `sessionStorage` é roubável por XSS**, como a senha era.
  A diferença é o que o roubo entrega: no máximo o que restar das 8
  horas, e nada que sirva em outro lugar. A senha entregava acesso
  permanente e reutilizável.
- **Não há revogação individual.** Derrubar uma sessão específica não
  existe; derrubar todas é trocar a senha do admin. Aceito para um
  operador só.
- O teste `tests/senha-nao-fica-no-navegador.js` trava o arranjo: falha
  se a senha voltar a trafegar em cabeçalho, se a guarda voltar a
  conferir senha, ou se `/sessao` cair para trás da guarda.

**Se o operador perder o acesso ao e-mail cadastrado**, o caminho de
volta é o próprio painel da Cloudflare, com a conta dela — não há
dependência circular entre as duas camadas.

**Renomear o arquivo para algo imprevisível** foi considerado e recusado:
troca uma fechadura por um segredo que vive em URL — histórico do
navegador, favoritos, cabeçalho de referência — e acrescenta risco de o
operador único perder o próprio acesso. Obscuridade não vira segurança
por ser mais difícil de adivinhar.

---

## 2.7 Limites de taxa e de tamanho — o que eles realmente entregam (Lei 7)

Escrito em 11/09/2026, no ciclo de segurança da Estação 6. Esta seção
existe porque o número na configuração e a proteção efetiva **não são a
mesma coisa**, e declarar o primeiro achando que declarou o segundo é o
jeito mais comum de acreditar que se está protegido.

### O teto por rota

| Rota | Teto | Por quê esse número |
|---|---|---|
| `/api/checkout/{pix,cartao,boleto,assinatura,assinatura-pix}`, `/estornar`, `/cancelar-assinatura`, `/pausar-assinatura`, `/retomar-assinatura`, `/api/admin` | 10/min | Cria cobrança ou exige credencial. O teto é de força bruta, não de uso. |
| `/api/checkout/{pedido,plano,asaas-checkout,status,cobranca,consultar-assinatura}` | 60/min **cada** | Consulta. Uma instância por rota — a mesma instância nas seis somaria num balde só (`docs/erros/2026-09-10-rate-limit-balde-compartilhado.md`). |
| `/api/saude` | 30/min | Faz consulta real no Supabase por chamada. O consumidor legítimo é o cron externo: 6/hora. |
| `/api/webhooks` | 300/min | Teto alto de propósito: a Asaas dispara em rajada, e cortar evento legítimo **pausa a fila dela por 15 falhas seguidas** (§2.3). |

### O que esse teto NÃO entrega

**O limite é por IP, e quem tiver mais de um IP multiplica o teto pelo
número deles.** Isso não é hipótese: foi medido sem querer em
11/09/2026, quando doze requisições de teste passaram por um limite de
10/min porque o proxy de saída alternava entre três endereços
(`docs/erros/2026-09-11-meu-proxy-rotacionou-ip-e-quase-reportei-limite-quebrado.md`).
Um /24 de qualquer provedor de nuvem transforma 10/min em 2.560/min.

Portanto, e isto é o que importa: **o limite por IP não é a guarda de
força bruta da `X-Checkout-Key` nem da senha do admin.** Ele reduz
ruído e tapa o caso absurdo. Quem protege a credencial é:

- na chave do contratante — o tamanho e a imprevisibilidade dela, mais
  nada. **Não há bloqueio por tentativas erradas**, e isso é limite
  declarado, não pendência escondida.
- na senha do admin — o Cloudflare Access na frente (§2.6), que impede a
  requisição de chegar ao backend sem identidade verificada, e o scrypt
  de ~800 ms, que faz cada tentativa custar caro **para o servidor
  também** (por isso a fila de uma derivação por vez, §2, gargalo 0).

Contador por credencial, e não por IP, é o próximo degrau. Está em
`docs/proximas-versoes.md`, não aqui, porque ainda não há evidência de
tentativa real — e o log de rejeição do webhook (§2.5) é o instrumento
que vai produzir essa evidência.

### O teto por campo

`express.json()` limita o **corpo inteiro** a 100 KB (padrão do
Express). Isso não é teto de campo: um corpo com um campo só transforma
o limite do corpo no limite daquele campo, e foi assim que um `nome` de
100 KB atravessou a validação
(`docs/erros/2026-09-11-o-teto-do-corpo-parecia-teto-do-campo.md`).

Os tetos por campo vivem em `TETOS`, em `src/utils/validadores.js`, e
são aplicados **antes** da normalização:

| Campo | Teto | Origem do número |
|---|---|---|
| `nome` | 2 a 150 | Nome de pessoa com folga; só tamanho, nunca formato — regra de "letras e espaços" recusa apóstrofo, hífen e outro alfabeto. |
| `email` | 254 | Máximo de um endereço na RFC 5321. |
| `documento` | 32 | CPF pontuado tem 14; folga para formatação. |
| `telefone` | 32 | Telefone com DDD e traço tem 15. |
| `cep` | 16 | CEP pontuado tem 9. |

Longo demais é **recusa, não truncamento**: truncar aceitaria um dado
que o comprador não digitou e mandaria isso para a Asaas.

---

## 2.7.1 Teto de tempo em toda chamada de saída (Lei 7)

Escrito em 15/09/2026, na varredura que se seguiu ao bug do vínculo.

`fetch` **não tem timeout padrão**: sem `AbortController`, ele espera
para sempre. Dois dos quatro pontos de saída do servidor estavam assim,
e os dois no caminho do dinheiro:

| onde | teto | por que esse número |
|---|---|---|
| `pedidoService` — pull do contratante | 45 s | tolera cold start de hospedagem gratuita, com o comprador esperando a tela |
| `asaasService.chamarAsaas` | 20 s | acima do pior tempo de sandbox, abaixo da paciência de quem está com o cartão na mão |
| `webhookController.tentarNotificar` | 10 s | a Asaas espera o nosso `200`, e lentidão conta como falha |

Os números são diferentes de propósito. Igualar os três perderia o
motivo de cada um.

**O pior dos dois casos era o aviso ao contratante**, e não por ser
lento: o receptor aguardava o processamento antes de responder à Asaas,
e a cadeia terminava no endpoint de um terceiro. Um contratante que
aceita a conexão e não responde segurava a nossa resposta — e resposta
lenta conta como falha para a Asaas, que **pausa a fila da conta inteira
depois de 15 seguidas** (§2.3). Um parceiro quebrado derrubaria a
confirmação de pagamento de **todos os outros**.

Por isso o aviso ao contratante hoje **não é aguardado** pelo fluxo que
responde à Asaas, pelo mesmo motivo que a auditoria nunca foi — e ali o
risco era menor, porque auditoria é escrita no nosso banco, não chamada
de rede a terceiro. A garantia de entrega não mudou: a fila de retry
sempre foi em memória e o `API.md` §4.3.6 documenta isso.

Cobrado por `tests/nenhuma-chamada-de-saida-sem-teto.js`, que varre o
`src/` inteiro — a regra já era conhecida (o `pedidoService` fazia
certo desde o começo) e mesmo assim não foi aplicada nos outros dois.
Memória não escala.

## 2.8 `returnUrl`: o destino é do contratante, e não há exceção (Lei 4)

Escrito em 15/09/2026, quando o `returnUrl` passou a ser honrado.

O checkout leva o comprador de volta à loja depois do pagamento. O
destino vem de `?returnUrl=` na barra de endereço — ou seja, **de quem
montou o link**, que não é necessariamente o contratante. Um checkout
que obedece esse parâmetro sem conferir vira *open redirect*: link com
o nosso domínio e o nosso cadeado na frente, destino escolhido pelo
atacante. O prejuízo não seria o servidor; seria a reputação do domínio
que cobra dinheiro, e ela não se recupera com um deploy.

**O que fica proibido, permanentemente:**

- **Decidir o destino no navegador.** O front manda o valor cru e
  obedece o que o servidor aprovar. Validar do lado que o atacante
  controla não é validar.
- **Mandar a lista de origens para o front.** Publicaria os domínios
  cadastrados de um contratante para qualquer um que abrisse um link de
  checkout. O servidor responde sobre a URL que o chamador já tem — não
  entrega o catálogo.
- **Comparar destino por texto.** `startsWith`, `endsWith`, `includes` e
  `split('/')` têm bypass conhecido para cada um
  (`src/utils/retornoSeguro.js` lista os cinco). A comparação é por
  `URL.origin` do WHATWG, e o valor devolvido é re-serializado a partir
  do objeto parseado — nunca o texto de entrada.
- **Mandar status de pagamento na URL de volta.** Query string é escrita
  por qualquer um; `?status=pago` faria um integrador desavisado
  entregar produto sem pagamento. Só o `pedidoId` viaja.
- **Cadastrar em `retorno_dominios` um domínio que não seja do
  contratante.** É a única forma de o mecanismo virar open redirect, e
  é decisão de operador, não de código. Mesma fronteira de confiança do
  `webhook_url` (`RUNBOOK.md` §5.2).

As três primeiras são cobradas por
`tests/retorno-nao-vira-open-redirect.js`, que lê o texto-fonte — a
forma de esta defesa morrer não é um bypass novo de parser, é alguém
"simplificando" daqui a três meses.

**O que isto NÃO protege, e é aceito:** contratante que cadastre um
domínio hostil redireciona para lá. Não é open redirect — é parte
confiável abusando do próprio cadastro, feito pelo dono no painel, de
alguém que já recebe dinheiro e já tem `api_key`.

## 2.9 A origem da cobrança é do processo, nunca da requisição (Lei 7)

Desde 17/09/2026 (migration 0009), toda linha de `cobrancas` nasce com
duas marcas, e a métrica de sucesso só conta a cobrança em que
`ambiente = 'producao'` **e** `e_teste = false` — a regra inteira é a
RN-33 de `docs/funcional.md`.

Os limites que este arquivo registra, porque são o que impede a marca de
virar mentira:

- **`ambiente` vem de `src/config/asaas.js`, nunca do corpo da
  requisição.** Se viesse de fora, quem paga escolheria em que ambiente
  a própria cobrança nasceu, e a métrica de sucesso passaria a ser
  escrita por terceiro. É a mesma razão do `valor` ser puxado do
  contratante em vez de aceito do navegador.
- **`e_teste` é de mão única, travada no BANCO.** O gatilho
  `cobrancas_e_teste_mao_unica` permite `true → false` (promover teste a
  real, que é corrigir marcação) e recusa `false → true` — marcar como
  teste uma cobrança real é esconder receita da métrica. Não é guarda de
  aplicação, porque guarda de aplicação vale só para quem passa pela
  aplicação, e migration, painel do Supabase e script avulso não passam.
  O caminho inverso apagaria da conta um resultado já contado, e
  apagaria calado.
- **`ambiente` é conjunto fechado** (`sandbox`/`producao`), por check
  constraint — valor novo é recusado pelo banco em vez de virar uma
  terceira categoria que o filtro da métrica não conhece.
- **A exclusão é relatada, nunca silenciosa.** A rota devolve
  `excluidas: { sandbox, teste, total }` e o painel mostra num cartão
  próprio, porque exclusão calada é indistinguível de dado que não
  existe: com dez cobranças de sandbox no banco, "nenhuma cobrança no
  período" seria uma frase falsa.
- **O filtro é aplicado em JS, não no SQL, e isso é deliberado.** A
  rota lê as linhas da janela e o agregador separa — porque o relatório
  precisa CONTAR o que excluiu, e `where ambiente = 'producao'` no banco
  devolveria as excluídas como se não existissem. Consequência a
  declarar: o índice parcial `idx_cobrancas_metrica_real`, criado pela
  0009, **não é usado pela consulta de hoje**; ele só passa a valer se
  algum dia o corte descer para o SQL. Fica como está — migration
  aplicada é imutável (§2.1), e índice não usado custa escrita, não
  leitura.
- **O que a marca NÃO faz:** ela não separa assinatura. `assinaturas`
  não tem `ambiente`, e é a assinatura de sandbox que vira zumbi depois
  da troca (`RUNBOOK.md` §6.2, passo 3) — a limpeza antes da troca
  continua sendo passo obrigatório, não faxina posterior.

## 3. Exceções de conformidade registradas

Exceção aceita entra aqui com a lei, o motivo e a data — exceção
esquecida não é conformidade.

### Lei 3 · a credencial do Cloudflare no ambiente é a conta inteira — 14/09/2026

Testado em 14/09 (`curl` direto com `CLOUDFLARE_EMAIL` +
`CLOUDFLARE_API_KEY`): é a **Global API Key**, papel "Super Administrator
— All Privileges" sobre a conta inteira do dono, não um token escopado à
zona `sancocore.com.br`. A Lei 3 pede segredo mínimo.

**Decisão do dono, 14/09/2026: fica ampla de propósito.** A credencial
vive só no ambiente da sessão de nuvem, não no código nem em `docs/`, e
o limite operacional é de conduta, não de escopo da chave: **a sessão só
toca neste projeto** — não lê, escreve nem apaga em outra zona, Worker ou
recurso da conta que não seja do San Checkout. Enquanto isso valer, a
amplitude da chave é aceita.

Revisar no dia em que uma segunda pessoa ou uma automação não-supervisionada
passar a receber esta variável — aí o limite de conduta deixa de bastar e
o caminho é o API Token escopado à zona (registrado em
`docs/erros/2026-09-14-listconnectors-vazio-nao-e-ausencia-de-acesso.md`).

### Lei 6 · não há backup do banco — exceção COM GATILHO, 11/09/2026

A Lei 6 exige backup automático do que não pode ser perdido, testado ao
menos uma vez. **Não existe backup nenhum hoje.** O plano gratuito da
Supabase não inclui backup automático (conferido em 11/09/2026 na página
de preços: *"Automatic backups — Not included in free"*; Pro dá 7 dias de
retenção, Team 14), e não há rotina própria no repositório.

**Decisão do dono: roda sem backup por enquanto**, pela mesma lógica do
plano gratuito do Render — o volume real ainda não começou, e o dado em
risco hoje é de teste, não histórico financeiro de cliente.

**Metade fechada em 16/09/2026 — a que não custava dinheiro.** O que
faltava aqui eram duas coisas diferentes, e só uma dependia de plano
pago: *saber restaurar* e *ter cópia*. A primeira agora existe e foi
**exercitada**: `npm run ensaio-restauracao` sobe um Postgres da mesma
major da produção, aplica as migrations, carrega os dados e compara o
resultado com o que está no ar em cinco níveis — colunas, restrições,
índices, RLS e contagem. Passou com zero divergência, **RTO de 1 s**, e o
comparador foi verificado por sabotagem. Registro em `RUNBOOK.md §6`.

Isso também fechou um risco que ninguém tinha olhado: era a primeira vez
que se provou que `supabase/migrations/` ainda descreve o banco real.

**O que continua aberto é a cópia, e com ela o RPO.** Sem job automático
de backup, o RPO é **indefinido** — no pior caso, perde-se tudo. O
despejo do ensaio sai do banco vivo, na hora: é cópia, não backup. Falta
decidir **onde** a cópia periódica fica, porque a regra 3-2-1-1-0 pede uma
fora do provedor principal, e Supabase Pro sozinho não atende isso (a
cópia ficaria no mesmo provedor que se está protegendo).

**DECISÃO DO DONO EM 17/09/2026 sobre a cópia: a Asaas é o backup.**
Todo dado de cobrança e de assinatura que importa existe também lá, e a
conciliação já sabe reconstruir status, ciclo e próxima cobrança a partir
dela (`API.md` §5.2 e §5.3) — exercitado ao vivo em 16/09, reparando três
linhas erradas com valores medidos na Asaas. A cópia periódica fora do
provedor virou atualização futura (`docs/proximas-versoes.md`).

**O que essa decisão NÃO cobre, e fica escrito aqui para não ser
descoberto na hora errada:** a Asaas não guarda o que é só nosso — o
cadastro de contratantes (inclusive `api_key`, `webhook_url` e os
domínios de retorno), o log de auditoria do webhook, a captura de erro,
e o vínculo entre a cobrança na Asaas e o `pedidoId` do contratante.
Perder o projeto Supabase significa recadastrar contratante à mão e
perder a conciliação com o lado do lojista, mesmo com a Asaas inteira.
Com um contratante isso é uma tarde; com dez, não é.

**O gatilho continua valendo, e é o que torna isto exceção e não
omissão: o primeiro pagamento real de terceiro reabre esta decisão.** A
partir daí o que se perde deixa de ser recadastro e passa a ser
histórico financeiro de terceiro. A ação nesse dia é Supabase Pro
(backup diário, 7 dias, com Point-in-Time Recovery disponível). Backup
só conta como feito depois de uma restauração testada pelo menos uma vez
— e essa metade já está feita e continua rodando.

### Lei 3 · scrypt no lugar de Argon2id — 13/09/2026

A Lei 3 pede, nesta ordem, **Argon2id**; **scrypt** "quando Argon2id não
estiver disponível". Este projeto usa scrypt, e o motivo é o segundo
item da própria ordem: **o Node não traz Argon2id nativo.** Usá-lo
exigiria dependência com binário nativo, e
`seguranca-san/references/senha-e-kdf.md` diz que `crypto.scrypt` é
scrypt de verdade (RFC 7914), sem dependência nativa e sem superfície de
supply-chain.

A troca é aceita porque as quatro condições que a referência exige de
quem usa a primitiva crua estão implementadas **e testadas**
(`src/utils/senhaAdmin.js`, 22 checagens em `npm test`): salt aleatório
por senha; salt e parâmetros guardados junto do hash; comparação em
tempo constante com `timingSafeEqual`, com a entrada ausente tratada
(vazio não bate com vazio); e parâmetros explícitos, no piso
recomendado — **N=2^17, r=8, p=1** —, nunca no padrão do Node, que é
N=2^14 e produz hash fraco sem avisar.

**O que falta para esta exceção ficar completa:** a referência manda
calibrar mirando **0,5 a 1 segundo por hash medido no servidor real**.
O número que temos, ~830 ms, foi medido no Render, em outra máquina.
Refazer a medição no Northflank (0,5 vCPU) e ajustar N se sair fora da
faixa — pendência aberta em `docs/pendencias.md`.

### Estação 5 · deploy em produção apontando para o sandbox da Asaas — 13/09/2026

A skill `leis` diz, na seção "A estação 5 fecha no ar, e a 6 começa
nele": *"Deploy é produção de verdade, não ensaio — apontando para o
ambiente real dos provedores, inclusive pagamento. Subir em sandbox para
trocar depois é testar uma coisa e lançar outra: identificador, formato
de webhook, assinatura e erro mudam entre ambientes."* Hoje
`ASAAS_AMBIENTE=sandbox`.

**Decisão do dono, 13/09/2026**, com a leitura dele registrada como
está: o que a regra exige do deploy é o **servidor e o subdomínio no
ar** — que estão, `api.sancocore.com.br` no Northflank e
`checkout.sancocore.com.br` no Pages; **as variáveis apontarem para
sandbox ou produção é decisão dele, não da sessão.**

**O plano combinado, nesta ordem:**

1. a Estação 6 roda inteira no sandbox, com o contratante de teste
   `testemaster`, exercitando **todos** os meios de pagamento;
2. depois, as variáveis vão para produção;
3. a Estação 6 roda de novo, **sem** repetir os testes de pagamento —
   que é onde o dono avalia que sandbox e produção não se distinguem
   para o que está sendo verificado.

**O que a exceção custa, escrito para não virar surpresa:** o que muda
entre ambientes — identificador de cobrança, formato do webhook,
assinatura e mensagem de erro — não passa pelo ciclo na primeira
rodada. A segunda rodada precisa reconferir esses quatro pontos um a
um, e é isso que a torna diferente de "repetir o mesmo ciclo".

### Lei 7 · sem split: 100% da cobrança cai na conta-mãe — 17/09/2026

A Lei 7 pede que o limite assumido esteja escrito. Este é o mais
importante do projeto hoje, e virou decisão em 17/09/2026.

**O motivo não foi escolha de arquitetura, foi bloqueio medido:** a
conta-mãe da Asaas está **registrada como pessoa física** (`FISICA`,
CPF, em `/v3/myAccount`), e conta PF não cria subconta — `403` em
`POST /v3/accounts`, para CPF e para CNPJ igualmente. Sem subconta não há
`wallet_id`; sem `wallet_id` a cobrança não leva `split`. A medição
completa e a armadilha do `commercialInfo` estão em §2.5.3.

**Decisão do dono, 17/09/2026: operar na conta como ela está, sem
subconta e sem split, e tratar a conversão do registro como atualização
futura** (`docs/proximas-versoes.md`).

**O que a decisão custa, escrito para não virar surpresa:**

- **Todo o dinheiro do contratante passa pela conta da San & Co.** antes
  de chegar a ele. O repasse é **manual, por fora do sistema** — não há
  registro, conferência nem alerta de repasse que não aconteceu.
- Isso é sustentável com **um** contratante e alguém olhando. Com dois,
  o erro passa a ser silencioso: ninguém confere transferência que não
  foi feita.
- A tabela `subcontas`, a tela do painel e o `split` em `asaasService`
  ficam **sem uso** — existem, funcionam, e não são exercitados. Código
  que não roda apodrece; quando a conversão vier, ele precisa ser
  reverificado, não presumido.
- **A conta que recebe é PF e o operador do contrato é PJ.** Os
  documentos legais trazem a razão social e o CNPJ da empresa (que
  existe — é o que está no `commercialInfo`), então o texto não fica
  falso; mas quem recebe na Asaas e quem assina os Termos deixam de ser
  a mesma inscrição. O efeito contábil e fiscal disso é decisão do dono,
  fora do alcance desta sessão — fica registrado porque é consequência
  da decisão, não porque há veredito aqui.

Revisar no segundo contratante, ou quando o repasse manual passar de um
punhado de transferências por mês — é o gatilho escrito na entrada de
`docs/proximas-versoes.md`.

### Lei 10 · os documentos legais identificam PESSOA FÍSICA, em transição — 17/09/2026

Decisão do dono em 17/09/2026: os Termos de Uso e a Política de
Privacidade passam a identificar o operador como **pessoa física**
(nome civil + CPF + endereço), e anunciam a **transição para pessoa
jurídica**. O CNPJ que constava antes saiu dos dois documentos.

É a consequência de documento da decisão vizinha (§3, "sem split"):
quem recebe na Asaas é a conta de pessoa física, e o documento tem de
dizer quem recebe — não quem se pretende ser.

**Por que CPF e não omissão:** o Decreto 7.962/2013, art. 2º, exige que
o fornecedor se identifique com nome e inscrição **no CPF ou no CNPJ**.
Operando como pessoa física, o CPF é a inscrição exigida. Omitir
descumpre; publicar parcialmente não identifica.

**O custo, e ele é real:** CPF em página pública é identificador de alto
valor no Brasil, sujeito a coleta automatizada. Registrado em
`docs/inventario-de-dados.md` §4.1 como o único dado pessoal do operador
que este projeto publica. A saída é a conversão para CNPJ, anunciada nos
próprios documentos e com gatilho em `docs/proximas-versoes.md`.

**Consequência fiscal declarada, não resolvida:** a cláusula da NFS-e
deixou de afirmar "no CNPJ do operador" e passou a dizer "na inscrição
fiscal do Operador vigente". Se pessoa física consegue emitir NFS-e do
serviço tecnológico depende de regra municipal, e isso é pergunta para o
contador — não para esta sessão. A cláusula também ganhou a distinção
que faltava: o checkout **não** emite a nota do produto do Lojista
(§1.9), e agora os Termos dizem isso onde antes se podia ler o
contrário.

**A v1 (com CNPJ) está arquivada** em `docs/legal-arquivado/`, capturada
do commit anterior à troca — o arquivo exato que esteve no ar, não uma
reconstrução. Ela não precisou ser comunicada a ninguém porque **ninguém
a aceitou**: esteve no ar com o checkout fechado a terceiro, sem
divulgação, que é o que a lei das estações exige antes da 7. O único
contratante cadastrado é do mesmo dono, confirmado por ele em 17/09.

Revisar quando a conversão para CNPJ concluir: os dois documentos
voltam a identificar a pessoa jurídica, com nova data de versão.

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

## 4. Estação 6 · escopo do ciclo de segurança — 14/09/2026

O dono ampliou a Estação 6 além dos seis passos e do ciclo padrão.
Autorização de 14/09, com estas condições:

**Roda tudo no sandbox primeiro.** Terminado o sandbox, o dono troca as
variáveis para produção e o ciclo se repete no que muda entre ambientes
(identificador de cobrança, formato de webhook, assinatura, mensagem de
erro), possivelmente repetindo os mesmos testes. É a mesma lógica de duas
rodadas do §3.

**A invariante central que o ciclo verifica:** nenhuma informação
sensível — variável de ambiente, token de webhook, chave de contratante,
dado de pagador — pode ser obtida **de fora do perímetro**. O perímetro é
os quatro serviços (Supabase, backend no Northflank, Pages no Cloudflare,
Worker do contratante de teste) e o próprio canal do Checkout. Conseguir
extrair qualquer coisa privilegiada por fora é furo, e furo se corrige
até a reverificação passar limpa — não vira exceção.

**Seis testes de segurança extra, além do ciclo padrão da `seguranca-san`:**

1. Isolamento entre contratantes (IDOR): o RLS está ligado, mas o backend
   usa a service key e passa por cima dele — o isolamento é do código.
   Testar rota a rota com a chave do `testemaster` contra dado de outro.
2. SSRF no modelo pull: o backend faz requisição de saída para a
   `api_base_url` cadastrada. Testar teto de tamanho de resposta,
   redirecionamento e recusa de endereço interno.
3. Replay/assinatura de webhook exercitados: mesmo evento assinado duas
   vezes (idempotência), timestamp fora da janela de 300s, corpo assinado
   com a chave de outro contratante.
4. Autorização do estorno com credencial errada (teste negativo próprio
   da única rota que tira dinheiro).
5. Força bruta por credencial: o limite é por IP (§2.7); reencontrar e
   endereçar.
6. Segundo fator no admin: a `seguranca-san` o exige em área
   administrativa. Se o Access cumpre esse papel, tem de estar escrito —
   senão o 2FA depende de configuração externa ao repositório.

Autorização também de: ativar proteção desativada útil nos quatro
serviços, e corrigir/reforçar código onde faltar o básico de
cibersegurança. **Não autorizado nesta estação: excluir qualquer coisa**
(linha de banco, arquivo, serviço, registro de DNS).
