# Escrevi um vínculo em cima de um campo que a Asaas nunca mandou

**Quando:** descoberto em 15/09/2026 pelo MostrAí, primeiro integrador
real, com uma assinatura paga de verdade no sandbox.
**Onde:** `src/controllers/webhookController.js`, `processarEventoCheckout`
— o ramo do `CHECKOUT_PAID`.

## O que aconteceu

O código lia o id do pagamento assim:

```js
const payment = corpo?.checkout?.payment ?? corpo?.payment ?? null;
const chargeId = payment?.id ?? null;
```

E o comentário ao lado dizia, em 08/09/2026, o que eu já sabia na hora
de escrever:

> o payment recém-criado pode vir em dois lugares, dependendo de como a
> Asaas realmente estrutura isso — **tenta os dois**.

"Tenta os dois" não é conhecimento, é chute com dois palpites. E a
resposta certa era uma terceira: **a Asaas não manda o pagamento em
nenhum dos dois**, porque não manda pagamento nenhum no `CHECKOUT_PAID`.
O id chega 279 ms depois, no `PAYMENT_CONFIRMED`, junto de um campo que
eu nunca tinha olhado — `payment.checkoutSession`, que aponta de volta
para a sessão.

Duas linhas abaixo, o mesmo arquivo trazia mais dois chutes assumidos:

```js
ciclo: payment.cycle ?? null, // ⚠️ não confirmado se a Asaas manda isso aqui
proximaCobranca: payment.nextDueDate ?? null // ⚠️ idem
```

Três suposições empilhadas num ramo que ninguém tinha exercitado ao vivo.

## O estrago

`chargeId` vinha `null` sempre. Com ele, caía o bloco inteiro logo
abaixo — o que grava `asaas_subscription_id` e cria a linha em
`assinaturas` — porque estava condicionado a `chargeIdFinal` existir.
A cobrança ficava assim, para sempre:

```
status: confirmado      ← o dinheiro entrou
charge_id: null         ← e nada mais sabia disso
asaas_subscription_id: null
```

A partir daí, tudo que dependia desse vínculo falhava **em silêncio**:

- `/cancelar-assinatura` não achava assinatura para cancelar;
- cada ciclo seguinte chegava como `PAYMENT_CONFIRMED` puro, procurava a
  cobrança-modelo por `asaas_subscription_id`, não achava, e era
  descartado — o contratante **nunca recebia `cobranca_confirmada`**;
- pedido avulso pela pop-up (cartão) era notificado com `chargeId: null`,
  que o próprio `API.md` §4.3.6 torna impossível de deduplicar.

Nada disso acendeu luz vermelha. O `console.error` do ciclo órfão dizia
"nunca vimos a 1ª cobrança dela?" — com interrogação, como se fosse um
mistério, quando era consequência determinística de três linhas acima.

## Por que passou

**O ramo nunca rodou ao vivo.** O autoteste do `CHECKOUT_PAID` existia e
passava — mas ele montava o payload à mão, com `payment: { id: 'pay_novo' }`
dentro. O teste confirmava a minha suposição em vez de confrontá-la: eu
tinha escrito os dois lados, o código e o exemplo, a partir da mesma
crença errada. Um teste que usa como entrada a forma que eu imaginei não
testa integração, testa memória.

A Estação 6 fechou o Pix ponta a ponta ao vivo em 14/09 e registrou, com
todas as letras, que faltava "a metade paga" da assinatura. Estava certo
no diagnóstico e errado na leitura do risco: eu tratei como pendência de
cobertura o que era um ramo de produção nunca executado no caminho do
dinheiro.

## O que ficou

- A vinculação mudou de evento: quem fecha é o `PAYMENT_CONFIRMED`,
  ancorado em `payment.checkoutSession`
  (`vincularPrimeiraCobrancaDoCheckout`).
- **A correção não depende de eu ter acertado desta vez.** Uma guarda
  (`if (cobranca.charge_id) return null`) faz o segundo pagamento que
  citar a mesma sessão cair no caminho de ciclo novo — então funciona
  tanto se a Asaas mandar `checkoutSession` só na primeira cobrança
  quanto se mandar em todas. Não troquei uma suposição por outra.
- O teste agora reproduz a **sequência real** medida: `CHECKOUT_PAID` sem
  `payment`, depois `PAYMENT_CONFIRMED` com `checkoutSession`. E foi
  verificado por sabotagem: desligando a correção, ele falha com a
  mensagem que explica o quê.
- `API.md` §4.3.6 foi corrigido: dizia que a chave de idempotência é
  sempre `chargeId` + `status`, sem ressalvar que o payload de assinatura
  não tem `chargeId` por desenho. O MostrAí leu ao pé da letra e recusou
  creditar — **ele estava certo, o texto é que estava incompleto**.

## A lição

**Comentário que admite não saber é bug esperando data, não documentação.**
Havia três marcados no arquivo — um "tenta os dois" e dois "⚠️ não
confirmado" — todos no caminho do dinheiro, todos passando no CI. Marcar
a dúvida e seguir em frente dá a sensação de honestidade sem nenhum dos
efeitos dela.

A regra que fica: **ramo que trata dinheiro e nunca rodou contra o
provedor de verdade é ramo não escrito.** Ou se exercita ao vivo, ou vira
pendência declarada com o risco escrito — nunca comentário de rodapé.

E quando o campo é opcional no código mas obrigatório para o efeito
acontecer (`if (chargeId)` guardando a criação da assinatura inteira),
o `null` não é caso de borda: é o caminho principal esperando para
acontecer.
