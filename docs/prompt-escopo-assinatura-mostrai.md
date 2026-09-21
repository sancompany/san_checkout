# Prompt de verificação — escopo de assinatura do San Checkout

**Para que serve este arquivo.** Entregar a uma sessão do **MostrAí** (ou
de qualquer contratante) o escopo completo de assinatura do San Checkout
como ele é hoje, para que essa sessão **confira os documentos dela**
contra este, e diga onde as duas versões discordam.

Escrito em 17/09/2026, depois de uma pergunta do dono que derrubou uma
afirmação minha ("não é possível alterar preço de plano já
contratado?"). Tudo que está marcado como **medido** foi medido no
sandbox naquele dia; o que é decisão está marcado como decisão.

**Atualizado em 18/09/2026**, e a mudança é grande o suficiente para
merecer destaque: a **troca de plano passou a existir**
(`POST /trocar-plano`, seção 5). Ela não existia quando a primeira
versão deste escopo foi escrita, e a decisão de 16/09 — o MostrAí
resolver troca de preço por pedido avulso — foi tomada quando não
existia. Continua válida se o dono do MostrAí quiser; só deixou de ser
a única saída.

⚠️ E uma consequência que quebra integração em silêncio: **depois de uma
troca, o `planoId` do assinante é o NOVO.** Cancelar, pausar, retomar,
conciliar e gerar link de renovação passam a usar o plano novo; mandar o
antigo responde `404`.

⚠️ **Redesenho em 21/09/2026 — reverte o que a seção 5 descrevia até
então.** `POST /trocar-plano` **deixou de cobrar o acerto na mesma
chamada.** Havendo acerto a pagar (>= R$ 5,00), a rota agora responde
`202` com um link (`approvalUrl`): é o **ASSINANTE**, não o MostrAí,
quem aprova o valor exato numa tela do próprio Checkout
(`/troca#t=<token>`) — e só depois disso o cartão salvo é cobrado.
Sem acerto (rebaixamento, ou acerto abaixo do piso de R$ 5,00), a rota
continua `200` imediato, exatamente como sempre foi — nada muda nesse
caso. A confirmação da troca com acerto chega pelo webhook
(`evento: 'plano_trocado'`), nunca pela resposta HTTP original. Seção 5
reescrita inteira contra isto.

**Como usar:** copie tudo abaixo da linha e cole na sessão do MostrAí.

---

Você é a sessão do **MostrAí**, um projeto que consome o **San Checkout**
como motor de pagamento. Recebeu abaixo o escopo de assinatura do
checkout, atualizado em 18/09/2026 e **medido contra a Asaas no
sandbox**, não escrito de memória.

**Sua tarefa:** conferir a documentação e o código do MostrAí contra
este escopo, e responder com três listas:

1. **Onde o MostrAí discorda** — cada ponto em que o documento, o código
   ou a expectativa do MostrAí afirma algo diferente do que está aqui.
   Para cada um: onde está escrito, o que diz, e o que este escopo diz.
2. **Onde o MostrAí depende de algo que não existe** — comportamento
   que o MostrAí espera do checkout e que este escopo diz que não
   existe. Isto é o que quebra em produção sem aviso.
3. **O que este escopo não responde** — pergunta que você precisa fazer
   ao dono do checkout porque a resposta não está aqui. Não invente a
   resposta; liste a pergunta.

Não altere nada do checkout. Não presuma que o silêncio deste documento
significa "funciona". Onde algo estiver marcado como **não medido**,
trate como desconhecido.

## 1. O que é uma assinatura aqui

- O checkout cobra por **plano**, e **plano é um conceito nosso, não da
  Asaas** — a Asaas não tem entidade de plano. O contratante expõe
  `GET /plano/{id}` no sistema dele, e o checkout **puxa** dali o nome,
  o valor e o ciclo. Modelo pull: o checkout nunca recebe valor pelo
  navegador.
- O link de assinatura é `?c={contratante}&assinatura={planoId}`. O
  `planoId` é do contratante: pode ser um id de plano ou um id por
  assinante (é assim que a Vitrina ADS usa, com valor e prefill por
  anunciante).
- A assinatura só passa a existir **quando a primeira cobrança é paga**.
  Pop-up fechada sem pagar não cria assinatura.
- Meios: **cartão** (pop-up da Asaas) e **Pix Automático** — este último
  está **indisponível nesta conta** hoje.
- Uma assinatura é identificada, nas rotas, por
  `contratante + planoId + documento`. **`documento` é normalizado para
  dígitos** em toda fronteira desde 17/09/2026: mande com ou sem
  pontuação, é a mesma chave.

## 2. As cinco rotas que existem

| o que | rota | observação |
|---|---|---|
| criar | não há rota — é o **link** do pop-up | a assinatura nasce do pagamento |
| cancelar | `POST /cancelar-assinatura` | alcança também assinatura **pausada** |
| pausar | `POST /pausar-assinatura` | para de cobrar, vínculo vivo |
| retomar | `POST /retomar-assinatura` | volta a cobrar |
| conciliar | `POST /consultar-assinatura` | reconfere o estado real na Asaas |
| **trocar de plano** | `POST /trocar-plano` | **nova em 17/09/2026, redesenhada em 21/09/2026** — sem acerto, troca na hora (`200`); havendo acerto, responde `202` e o ASSINANTE aprova a cobrança numa tela do Checkout antes de qualquer coisa acontecer |

Todas com `X-Checkout-Key` do contratante, e corpo
`{ planoId, documento }` — a troca de plano leva um campo a mais,
`planoNovoId`. `POST` e não `GET` de propósito: documento em caminho de
URL vaza para log de acesso, histórico e referer.

⚠️ Esta seção dizia **"as quatro rotas"** e **"não existe rota para
alterar valor, ciclo ou data de um assinante"** até 17/09/2026. A troca
de plano passou a existir; o que continua não existindo é **mudar a
data de vencimento** de um assinante, e **mudar o valor para um número
solto** (sem um plano seu por trás). Ver a seção 5.

## 3. O que o checkout te avisa, e o que ele NÃO avisa

Eventos que chegam no seu `webhook_url`, com `evento` — **são seis, e o
seu código precisa tratar os seis**:

- `criada` — assinatura criada e primeira cobrança paga;
- `cobranca_confirmada` — um ciclo foi cobrado com sucesso;
- `cobranca_falhou` — ciclo recusado ou vencido. **Mande o link de
  renovação** (seção 6);
- `cobranca_estornada` — um ciclo foi estornado;
- `cobranca_contestada` — chargeback num ciclo. **Suspenda o acesso**;
- `cancelada` — assinatura encerrada, pelo seu pedido ou por abandono de
  assinatura nova.

A chave para localizar de quem é o evento é `planoId` + `documento` — o
payload de assinatura **não traz `chargeId`**.

**O que NUNCA chega até VOCÊ** (o checkout não repassa, mesmo que o
evento chegue até nós):

- **nada de assinatura encerrada fora do nosso fluxo, nem de preço
  mudado no painel da Asaas.** ⚠️ Atualizado em 18/09/2026: até então o
  grupo `SUBSCRIPTION_*` estava zero entre os eventos configurados na
  conta (medido em 16/09), então nem o checkout recebia o evento. Desde
  18/09 o dono marcou o grupo inteiro — o evento **passa a chegar ao
  checkout**, mas o código ainda não o lê nem o repassa; cai como "não
  mapeado" e vira só uma linha de log interna. **Pra você, na prática,
  nada muda ainda**: assinatura cancelada direto no painel da Asaas, ou
  preço/ciclo alterado por lá, **só chega até você se você chamar a
  conciliação** — o mesmo vale para pausa e exclusão.
- **renovação abandonada não avisa nada** (desde 15/09/2026). Fechar o
  pop-up de troca de cartão sem pagar deixa a assinatura antiga
  intocada e ativa; antes disso o checkout mandava `cancelada` nesse
  caso, o que fazia um contratante revogar acesso de quem estava
  pagando.

**Consequência de desenho para você:** o estado de assinatura no MostrAí
não pode depender só de webhook. Rodar a conciliação **uma vez por dia**
por assinante ativo é o que fecha o buraco.

## 4. A conciliação, e o campo que passou a ser confiável

`POST /consultar-assinatura` devolve `status`, `valor`, `ciclo`,
`proximaCobranca`, `divergenciaDeValor` e `ultimaCobranca`.

**Os quatro primeiros são reconferidos contra a Asaas a cada chamada.**

⚠️ **Isto mudou em 18/09/2026, e esta seção dizia o contrário:** até
então `valor` era a exceção — saía do banco do checkout, e o escopo
avisava para não confiar nele. Agora a conciliação, achando diferença:

1. devolve em `valor` **o que a Asaas cobra**;
2. corrige o registro do checkout;
3. e te conta em **`divergenciaDeValor`**:

```json
"divergenciaDeValor": { "nosso": 30.00, "asaas": 45.00 }
```

Ele vem `null` em quase toda chamada — só aparece na conciliação que
achou e corrigiu a diferença. **Trate como evento, não como estado:** é
o aviso de que o preço daquele assinante mudou **fora do fluxo do
checkout** (alguém no painel da Asaas, ou chamada direta de API). E
**quem avisa o assinante é você** — o checkout não fala com o pagador.

Duas coisas que continuam valendo:

- **não há aviso proativo.** Você descobre **quando roda a
  conciliação** — nada chega por webhook, porque o grupo
  `SUBSCRIPTION_*` não está marcado nesta conta. É mais um motivo para
  o "uma vez por dia";
- `ultimaCobranca.valorCobrado` continua sendo o histórico do que foi
  **de fato cobrado**, e continua útil para conferência — só deixou de
  ser a única coisa confiável aqui.

Outras coisas medidas sobre a conciliação:

- assinatura **cancelada** na Asaas responde `200` com `deleted: true` e
  `status: "INACTIVE"` — **o mesmo status de uma pausada**. Quem olhar o
  status antes do `deleted` marca toda cancelada como pausada;
- a Asaas **continua devolvendo `nextDueDate` de uma assinatura
  deletada**. O checkout não repassa isso: numa assinatura encerrada,
  `proximaCobranca` vem `null`;
- `ciclo` de assinaturas criadas **antes de 15/09/2026** foi gravado
  errado (`MONTHLY` para todo mundo). A conciliação repara. Se você
  guardou ciclo do seu lado antes dessa data, vale reconciliar.

## 5. Mudar o preço de quem já assinou — medido em 17/09/2026

**A Asaas permite.** Medido no sandbox, em assinatura de **cartão** (o
meio que o checkout usa) e de boleto, com fixtures descartáveis:

| tentativa | resposta | conferido no `GET` depois |
|---|---|---|
| **aumentar** R$ 30 → R$ 45 | `200` | `value: 45` |
| **diminuir** R$ 45 → R$ 12 | `200` | `value: 12` |
| **abaixo do piso** R$ 12 → R$ 3 | **`400 invalid_value`** — "O valor mínimo para cobranças via cartão de crédito é R$ 5,00." | nada mudou |
| **trocar o ciclo** `MONTHLY` → `YEARLY` | `200` | `cycle: YEARLY`, e **`nextDueDate` NÃO se moveu** |
| **em assinatura pausada** | `200` | valor novo, `status: INACTIVE` |
| **a cobrança pendente já gerada** | só muda com `updatePendingPayments: true` | sem a bandeira fica no valor antigo |
| **controle negativo:** campo inventado | `200`, **sem erro** | nada mudou |

**O que isso significa para o MostrAí:**

1. **Sim, dá para aumentar e diminuir** — e **o checkout expõe isso**
   como troca de PLANO: `POST /api/checkout/trocar-plano` (`API.md`
   §5.6). ⚠️ A rota nasceu em 17/09/2026 cobrando na mesma chamada, e
   foi **redesenhada em 21/09/2026**: o dono testou o MostrAí e viu a
   cobrança do acerto acontecer sem o assinante ver nada — achou errado.
   Hoje, havendo acerto, a rota nunca cobra sozinha: ela responde `202`
   com um link, e é o assinante quem aprova o valor exato numa tela do
   Checkout antes de qualquer débito. **Leia a §5.6 do `API.md`, não
   esta lista, como contrato.**
2. **O piso de R$ 5,00 vale na alteração também**, com mensagem por meio
   de pagamento. A rota valida antes de criar qualquer intenção e
   devolve `400`.
3. **Ciclo novo não move a data já marcada.** Trocar mensal por anual
   mantém a próxima data; o ciclo novo conta dali. Quem assumir "virou
   anual, próxima em um ano" erra por onze meses. A troca de plano vive
   disso: o acerto cobre os dias que faltam, e o plano novo inteiro entra
   na data que o assinante já tinha.
4. **`200` (sem acerto) não prova alteração nessa API** — a Asaas ignora
   em silêncio campo que não conhece. A rota **relê** a assinatura
   depois de alterar, e responde `502` sem mexer no registro se a
   alteração não pegou. Com acerto, quem confirma é o webhook, não a
   resposta HTTP (item 0 abaixo).
5. **`value` não está no schema documentado** do `PUT` da Asaas.
   Funciona, é comportamento não documentado, e pode mudar sem aviso —
   o dia em que mudar, o `502` acima é o que aparece.
6. **Alterar pelo PAINEL da Asaas continua sendo o caminho ruim**: nada
   nos avisa, e o `valor` do checkout fica errado para sempre (seção 4).
   Se for para mudar preço, mude pela rota.

#### O fluxo com acerto — o que o MostrAí precisa fazer, desde 21/09/2026

`POST /trocar-plano` respondendo `202` significa **nada foi cobrado nem
alterado ainda**:

```json
{
  "code": "PLAN_CHANGE_APPROVAL_REQUIRED",
  "status": "approval_required",
  "approvalUrl": "https://checkout.sancocore.com.br/troca#t=3f7a...",
  "expiresAt": "2026-09-25T15:15:00.000Z",
  "amount": 30.00
}
```

1. **O MostrAí leva o assinante até `approvalUrl`** (redirecionar, abrir
   em nova aba, mandar por e-mail — a escolha é sua). Essa URL é do
   **Checkout**, não do MostrAí; o assinante vê lá o valor exato do
   acerto e aprova (ou não) no cartão que já está salvo — ele **não
   escolhe plano, não digita cartão**, só confirma o valor.
2. **O link expira em 15 minutos.** Se o assinante não abrir a tempo, ou
   abrir e não aprovar, nada acontece: o plano continua o antigo, nada
   foi cobrado. Uma nova chamada a `POST /trocar-plano` gera um link
   novo.
3. **Quem confirma que a troca aconteceu é o webhook**
   (`evento: 'plano_trocado'`, seção 3), nunca a resposta HTTP original
   — ela só disse "existe um acerto pendente de aprovação", não "a troca
   aconteceu". Pode levar de segundos a nunca.
4. **Recusa não muda nada.** Se o assinante aprovar mas o cartão salvo
   recusar a cobrança, o plano permanece o antigo — não há estado
   intermediário para você tratar.

**Como se muda preço hoje — três caminhos:**

0. **`POST /trocar-plano`** (o novo): sem acerto, troca na hora (`200`).
   Havendo acerto, nasce um link de aprovação (`202`, acima) — o acerto
   só é cobrado, no cartão já salvo, depois que o **assinante** aprova
   na tela do Checkout. Para baixo não cobra e não devolve — o preço
   novo vale no vencimento. **O valor e o ciclo saem do SEU
   `GET /plano/{planoNovoId}`**, nunca do corpo da requisição, e são
   revalidados de novo na hora da aprovação (contra o que pode ter
   mudado na sua API entre a chamada e o assinante aprovar).
1. **Cancelar e assinar de novo** (o assinante digita o cartão outra vez).
2. **Cobrar a diferença como pedido avulso** mantendo a assinatura — era
   a decisão do dono em 16/09/2026, tomada quando a rota não existia.

#### A conta do acerto, que agora o checkout faz — e a armadilha que ela evita

A **Asaas não tem proporcional nenhum**: medido em 17/09,
`updatePendingPayments: true` põe na cobrança pendente o valor novo
**cheio**, não um rateio. Quem calcula é o checkout, e a conta é esta —
vale conferir, porque ela aparece aberta na resposta da rota (`credito`,
`debito`, `diasRestantes`):

```
dias_restantes = vencimento_atual − hoje
credito        = valor_PAGO_do_periodo × (dias_restantes ÷ dias_do_ciclo_atual)
debito         = valor_do_plano_novo  × (dias_restantes ÷ dias_do_ciclo_novo)
cobra_agora    = debito − credito     (se ≤ 0, não cobra nada)
```

**Base de dias: mês comercial de 30 dias**, e por consequência ano de
360 — decisão do dono do checkout em 17/09/2026. Semanal 7, quinzenal
14, mensal 30, bimestral 60, trimestral 90, semestral 180, anual 360.

Com 15 dias restantes de um mensal de R$ 100:

| troca para | crédito | débito | cobra agora |
|---|---|---|---|
| mensal R$ 160 | 50,00 | 80,00 | **R$ 30,00** |
| trimestral R$ 270 | 50,00 | 45,00 | **nada** (dá −5) |
| anual R$ 2.400 | 50,00 | 100,00 | **R$ 50,00** |

Esses três números saem do **mesmo código** que o checkout usa
(`src/services/proporcionalService.js`), não de conta feita à mão — o
autoteste dele trava os três.

**A armadilha é a linha do meio.** "Diferença entre os planos" daria
R$ 270 − R$ 100 = **R$ 170 por 15 dias** de um plano que custa R$ 90/mês.
Um plano mais caro no total pode ser **mais barato por dia** — e aí a
troca não gera acerto nenhum.

E as decisões do dono do checkout que você vai sentir na prática (são
**decisão**, não medição — a rota se comporta assim):

- **acerto abaixo de R$ 5,00 é absorvido**, nunca arredondado para cima:
  a Asaas recusaria a cobrança, e cobrar mais do que o devido para caber
  na régua dela seria pior;
- **para baixo não devolve nada**: o preço novo vale no vencimento que já
  estava marcado;
- **crédito não acumula**: cada troca recalcula sobre os dias que restam
  naquele momento, a partir do valor **pago** do período;
- **cobrança do período pendente recusa a troca** (`409`): não existe
  crédito de período que não foi pago;
- ⚠️ **duas chamadas de `POST /trocar-plano` com acerto a cobrar NÃO dão
  mais `409` uma na outra** — isto mudou em 21/09/2026. Antes, a trava
  era pega na própria chamada (nada esperava aprovação); agora, como
  nada é cobrado na criação da intenção, uma segunda chamada só
  recalcula e cria **outra** intenção/link, sem bloquear a primeira. A
  guarda contra pagar o mesmo acerto duas vezes existe do mesmo jeito,
  só que mudou de lugar: ela trava no **assinante aprovando**, não no
  MostrAí chamando a rota — só uma aprovação por assinatura consegue
  cobrar por vez, e um link vencido (15 min) simplesmente para de
  funcionar. Se o seu código depende do `409` aqui para saber "já existe
  uma troca pendente", ele vai parar de ver esse sinal;
- ⚠️ **depois da troca, o `planoId` do assinante é o NOVO**: cancelar,
  pausar, retomar, conciliar e gerar link de renovação passam a usar
  `planoNovoId`; mandar o antigo responde `404`. É por isso que o evento
  leva `planoAnterior`;
- **avisar o assinante da mudança de preço é obrigação SUA**, por e-mail
  e por aviso no site. O checkout não fala com o pagador — ele te manda
  `evento: 'plano_trocado'` com `planoAnterior`, `valor`, `ciclo` e
  `acertoCobrado`, e a resposta da rota traz crédito, débito e dias
  restantes para você explicar a cobrança.

> A decisão de 16/09 (seguir pelo pedido avulso) foi tomada sobre uma
> premissa **falsa** que eu havia escrito: que a Asaas não permitia
> alterar valor. Ela permite — e, corrigida a premissa, o dono decidiu
> construir a rota **nesta versão**, em 17/09. O pedido avulso continua
> funcionando; só deixou de ser a única saída.

## 6. Renovação e troca de cartão — MUDANÇA INCOMPATÍVEL

O parâmetro `&renovar=1` **deixou de funcionar** em 16/09/2026. Hoje
`renovar` precisa ser um **token HMAC-SHA256** assinado com a `api_key`
do contratante; a receita está no `API.md` §7.3, em Node, PHP e Python.

- Sem token válido — inclusive o formato antigo `&renovar=1` — o link
  **degrada para assinatura nova comum**: não amarra nem cancela nada. É
  o modo seguro, não um erro que trava o pagador.
- **Se o MostrAí ainda gera links com `&renovar=1`, eles estão criando
  assinatura nova sem encerrar a antiga.** Isto é ação para hoje.

O motivo da mudança: `renovar=1` sozinho bastava para achar e **cancelar
a assinatura de outra pessoa** — `documento` não é segredo e a rota de
criação é pública.

## 7. Limites que recusam antes de cobrar

- **Piso de R$ 5,00 por parcela**, não por total. R$ 24,00 em 12x é
  recusado pela Asaas (R$ 2,00 por parcela); o checkout **oferta menos
  parcelas** em vez de recusar a venda, e a tela corta a lista com o
  número que o servidor manda.
- **Telefone**: DDD ≥ 11, 10 ou 11 dígitos, e o 11º começa com 9. A
  regra de "dígito repetido" que já circulou aqui é **falsa** —
  `11988888888` é aceito (24 combinações medidas).
- **Valor zero é vetado** em qualquer caminho de cobrança.
- **Idempotência de webhook**: a Asaas pode entregar o mesmo evento mais
  de uma vez. A chave deduplica *retry*, **não ciclo** — e o payload de
  assinatura **não traz `chargeId`**, então você identifica por
  `planoId` + `documento`.

## 8. O que a assinatura NÃO faz — não prometa ao assinante

- carência, teste grátis, primeiro mês grátis: a primeira cobrança sai
  **no ato**;
- pular ou adiar um ciclo;
- desconto ou cupom no plano (`desconto` existe só no pedido avulso);
- ciclo de 4, 5 ou 8 meses — só os sete ciclos da lista;
- **mudar a data de vencimento** de um assinante — nem a troca de plano
  faz isso: a Asaas não move o `nextDueDate` nem quando o ciclo muda;
- **cobrar um valor solto** de um assinante (sem plano por trás) — para
  isso, pedido avulso.

> **Trocar de plano saiu desta lista em 17/09/2026** — passou a existir,
> e é a seção 5.

**E o que o checkout não faz e é SEU:** avisar o assinante quando o
preço dele muda — por e-mail e por aviso no site. O checkout não fala
com o pagador em nenhum caminho.

## 9. O estado do checkout hoje, que muda o que você deve testar

- **O pagamento está apontado para o SANDBOX da Asaas.** A troca para
  produção é decisão do dono e ainda não aconteceu. Todo id de
  assinatura, cobrança e `walletId` é **preso ao ambiente**: nada de
  sandbox atravessa a troca. Assinatura de teste que sobreviver à troca
  vira zumbi — a API de produção responde `404` para um id de sandbox.
- Por isso: **o que você testar agora, teste de novo depois da troca.**

---

## Os documentos do checkout que valem como fonte

Se algo aqui discordar deles, **eles estão certos** e este resumo
envelheceu:

- `API.md` — o contrato. Seção 4.2 (plano), 4.3 (webhooks), 5.3
  (conciliação), 5.5 (cancelar/pausar/retomar), 7 (assinaturas em
  detalhe), **7.5 (mudar preço de quem já assinou)**, 7.6 (o que ela não
  faz), 9 (limites), 11.1 (a troca de ambiente).
- `INTEGRACAO.md` — o mapa de para onde ir.
- `docs/ciclo-assinatura-mapa.md` — o ciclo de assinatura etapa por
  etapa, com todo erro já encontrado catalogado contra a etapa onde
  vive (a T12 é a alteração de preço direto na Asaas).
- `docs/funcional.md` — as regras de negócio numeradas (a última é a RN-36; as de assinatura vão da RN-15 em diante).
