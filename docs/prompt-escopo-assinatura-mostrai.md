# Prompt de verificação — escopo de assinatura do San Checkout

**Para que serve este arquivo.** Entregar a uma sessão do **MostrAí** (ou
de qualquer contratante) o escopo completo de assinatura do San Checkout
como ele é hoje, para que essa sessão **confira os documentos dela**
contra este, e diga onde as duas versões discordam.

Escrito em 17/09/2026, depois de uma pergunta do dono que derrubou uma
afirmação minha ("não é possível alterar preço de plano já
contratado?"). Tudo que está marcado como **medido** foi medido no
sandbox naquele dia; o que é decisão está marcado como decisão.

**Como usar:** copie tudo abaixo da linha e cole na sessão do MostrAí.

---

Você é a sessão do **MostrAí**, um projeto que consome o **San Checkout**
como motor de pagamento. Recebeu abaixo o escopo de assinatura do
checkout, atualizado em 17/09/2026 e **medido contra a Asaas no
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
| **trocar de plano** | `POST /trocar-plano` | **nova em 17/09/2026** — cobra o acerto no cartão salvo e só então troca |

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

**O que NUNCA chega:**

- **nada de assinatura encerrada fora do nosso fluxo.** Medido em
  16/09/2026: **zero eventos `SUBSCRIPTION_*` entre os 53 configurados**
  na conta Asaas. Assinatura cancelada direto no painel da Asaas, ou
  encerrada por ela após falhas seguidas, **só chega até você se você
  chamar a conciliação**.
- **nada quando o preço muda.** Medido em 17/09/2026: nenhuma alteração
  de valor, de ciclo, de pausa ou de exclusão gerou evento.
- **renovação abandonada não avisa nada** (desde 15/09/2026). Fechar o
  pop-up de troca de cartão sem pagar deixa a assinatura antiga
  intocada e ativa; antes disso o checkout mandava `cancelada` nesse
  caso, o que fazia um contratante revogar acesso de quem estava
  pagando.

**Consequência de desenho para você:** o estado de assinatura no MostrAí
não pode depender só de webhook. Rodar a conciliação **uma vez por dia**
por assinante ativo é o que fecha o buraco.

## 4. A conciliação, e o campo em que você não pode confiar

`POST /consultar-assinatura` devolve `status`, `valor`, `ciclo`,
`proximaCobranca` e `ultimaCobranca`.

**Três desses quatro primeiros são reconferidos contra a Asaas a cada
chamada: `status`, `ciclo` e `proximaCobranca`.**

⚠️ **`valor` NÃO é.** Ele sai do banco do checkout. E como a Asaas
aceita alterar o valor de uma assinatura ativa (seção 5), um preço
mudado lá deixa esse campo errado **para sempre e sem sintoma**.

- **Não use `valor` como "o preço que está sendo cobrado".**
- Use **`ultimaCobranca.valorCobrado`** — esse é histórico de cobrança
  real, e por isso é verdade.

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

1. **Sim, dá para aumentar e diminuir** — e **o checkout passou a expor
   isso** no fim de 17/09/2026, como troca de PLANO:
   `POST /api/checkout/trocar-plano` (`API.md` §5.6). ⚠️ Esta seção
   dizia "não existe rota nossa" até aquele dia; a rota foi autorizada e
   construída depois de o dono do checkout decidir as sete regras do
   acerto. **Leia a §5.6 do `API.md`, não esta lista, como contrato.**
2. **O piso de R$ 5,00 vale na alteração também**, com mensagem por meio
   de pagamento. A rota valida antes de chamar a Asaas e devolve `400`.
3. **Ciclo novo não move a data já marcada.** Trocar mensal por anual
   mantém a próxima data; o ciclo novo conta dali. Quem assumir "virou
   anual, próxima em um ano" erra por onze meses. A troca de plano vive
   disso: o acerto cobre os dias que faltam, e o plano novo inteiro entra
   na data que o assinante já tinha.
4. **`200` não prova alteração nessa API** — a Asaas ignora em silêncio
   campo que não conhece. A rota **relê** a assinatura depois de alterar,
   e responde `502` sem mexer no registro se a alteração não pegou.
5. **`value` não está no schema documentado** do `PUT` da Asaas.
   Funciona, é comportamento não documentado, e pode mudar sem aviso —
   o dia em que mudar, o `502` acima é o que aparece.
6. **Alterar pelo PAINEL da Asaas continua sendo o caminho ruim**: nada
   nos avisa, e o `valor` do checkout fica errado para sempre (seção 4).
   Se for para mudar preço, mude pela rota.

**Como se muda preço hoje — três caminhos:**

0. **`POST /trocar-plano`** (o novo): o assinante vai do plano A para o
   plano B, o acerto proporcional é cobrado **no cartão já salvo** (ele
   não digita nada), e o plano só muda se o acerto for aprovado. Para
   baixo não cobra e não devolve — o preço novo vale no vencimento.
   **O valor e o ciclo saem do SEU `GET /plano/{planoNovoId}`**, nunca
   do corpo da requisição.
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
- **duas trocas simultâneas**: a segunda recebe `409` e **nada é
  cobrado** — a guarda existe para ninguém pagar o mesmo acerto duas
  vezes;
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
- `docs/funcional.md` — as regras de negócio numeradas (RN-15 a RN-34).
