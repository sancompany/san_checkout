# A descrição do pedido, sem teto, quebrava Cartão avulso por inteiro

**Quando:** 18/09/2026, verificando ao vivo se os métodos de pagamento
continuavam funcionais depois de dois ciclos de `revisar` do dia
(pedido direto do dono, PR #29 e #30 já mescladas).
**Onde:** `src/controllers/asaasCheckoutController.js`,
`criarCheckoutCartao` e `criarCheckoutAssinatura` — o `items[0].name`
mandado para `POST /v3/checkouts`.

## O que aconteceu

Chamei a rota de verdade, contra o sandbox, com o pedido de teste
`ped_completo` (contratante `testemaster`):

```
POST /api/checkout/cartao/testemaster/ped_completo
→ 400 "O campo name só pode conter no máximo 30 caracteres."
```

`ped_completo.descricao` é `"Pedido completo — desconto, cupom e
frete"` — 41 caracteres. O código mandava ela direto como
`items[0].name` pra Asaas:

```js
itens: [{
  name: pedido.descricao ?? 'Pagamento via SAN & CO. Pay Engine',
  quantity: 1,
  value: valorCobrado
}],
```

Pix e Boleto (`POST /v3/payments`) usam o MESMO dado num campo chamado
`description`, que não tem esse teto — testei os três de uma vez e só o
Cartão quebrou, o que confirmou que o problema era o nome do campo, não
o tamanho do texto em si.

`pedido.descricao` (e `plano.nome`, na Assinatura) vêm do CONTRATANTE,
nunca do pagador — nenhuma validação de fronteira o alcança, porque
fronteira nossa é onde dado de FORA entra, e este dado entra pela API
do próprio contratante. Qualquer descrição de produto ou nome de plano
um pouco mais longo — nada incomum — quebraria Cartão avulso ou
Assinatura por cartão **por inteiro**, para **todos** os compradores
daquele contratante, com um erro de campo que não diz ao operador o que
houve de fato (o `corpoAsaas` só vai pro `console.error`).

## Por que passou despercebido

Não é um caminho testado por `npm test`: a suíte inteira roda sem tocar
banco nem rede, e criar uma sessão de Checkout de verdade exige as duas
coisas. O `ped_completo` existe desde a Estação 4 justamente para
exercitar campos "normais" (desconto, cupom, frete) — nunca foi pensado
como um caso de borda de tamanho, e por isso nunca apareceu como
suspeito numa leitura de código. Só apareceu rodando a rota de
verdade.

## O que a medição também mostrou

Testado ao lado, `customerData.name` (o nome do COMPRADOR, que sim
passa pela nossa validação de fronteira) **não tem teto de tamanho** —
o que a Asaas recusa ali é uma string toda do MESMO caractere repetido
(antifraude): 150 "A"s foi recusado, e um nome realista de 206
caracteres — bem além do teto de 150 do `nomeValido()` — foi aceito sem
problema. Não é achado, é controle negativo: confirma que o teto de
`nomeValido` já cobre o que precisa ser coberto, e que não existe um
segundo teto escondido nesse campo esperando para quebrar depois.

## A regra que fica

**Dado do CONTRATANTE que vira campo de terceiro precisa do MESMO
cuidado que dado do pagador — só que o teto é medido contra o
provedor, não decidido por nós.** Corrigido com `nomeItemAsaas()`
(30 caracteres, com reticências) nos dois lugares que montam
`items[]` pro Checkout da Asaas; o texto INTEIRO continua indo em
`items[].description`, que a Asaas aceita sem teto (medido: 100+
caracteres passou) — cortar o `name` não é perder a informação, é só
não usá-la no campo que tem teto.

Travado por `tests/nome-do-item-nao-passa-do-teto-da-asaas.js`: a regra
pura (`nomeItemAsaas`) e o alcance (os dois chamadores passam pela
função, não pelo campo cru) — sabotagem verificada manualmente
(reverter um chamador pro campo cru reprova com a mensagem certa).

**Ecossistema:** sim. Vale para todo projeto que monte payload de
checkout/pop-up de terceiro a partir de um campo de texto livre vindo
de OUTRO sistema (nunca do usuário final) — o provedor de pagamento
pode ter teto num campo e não no outro que carrega o mesmo dado, e só
uma chamada real contra o sandbox revela qual.
