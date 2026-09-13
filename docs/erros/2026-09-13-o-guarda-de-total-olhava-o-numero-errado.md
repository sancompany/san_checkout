# O guarda de total olhava o número errado

**Quando:** 13/09/2026, no passo 1 do teste de ponta a ponta — a primeira
vez que um contratante de teste de verdade respondeu.
**Onde:** `src/controllers/pedidoController.js` e
`public/js/modules/assinaturaHandler.js`.

## O que aconteceu

O contratante de teste expõe, de propósito, um pedido sem preço
(`ped_sem_valor`). A resposta do nosso próprio backend para ele foi:

```
GET /api/checkout/pedido/testemaster/ped_sem_valor
  pedido.valorComDesconto: 0
  taxa.valorCobrado:       1.49
```

**R$ 1,49 de total para um pedido que não vale nada.** O número não veio
de lugar nenhum errado: é a taxa da Asaas mais a taxa própria, somadas
sobre uma base zero. `calcularTaxa(0, 'pix', …)` faz a conta que pediram.

O front lê `taxa.valorCobrado` como "o total". Ele tem um guarda, e o
guarda estava certo no que se propunha — recusa total não finito ou
menor ou igual a zero. Só que 1,49 é finito e maior que zero. A tela
renderizava normal: subtotal R$ 0,00, total R$ 1,49, botão de pagar
ligado.

Quem clicasse recebia 400 `Valor do pedido inválido.` — o
`valorValido` do caminho que cobra estava lá e funcionou. Ninguém
seria cobrado. Mas o comprador só descobria **depois** de preencher
nome, e-mail, CPF e telefone.

## A segunda cara do mesmo erro, na tela ao lado

Procurando o irmão do problema, a assinatura estava pior. O `app.js`
renderiza o total do plano com `formatarMoeda(plano.valor)`, e
`formatarMoeda` faz `Number(valor ?? 0)`. Sem nenhum guarda no caminho
do plano, plano com `valor` ausente virava **"R$ 0,00" com o botão de
assinar ligado** — que é, palavra por palavra, o erro de
`2026-09-11-total-ausente-virou-zero-na-tela.md`, dois dias depois, na
tela que o conserto daquele dia não tocou.

## A causa raiz

**O conserto de 11/09 foi aplicado ao caminho onde o erro apareceu, e
não à regra.** A regra existe e tem nome — `valorValido`, maior que zero
e até 100.000 — mas morava só no caminho que cobra. A rota que a tela
consulta para *montar* o preço não a usava, e a tela da assinatura não
tinha guarda nenhum.

Daí a assimetria que produziu os dois furos: o sistema sabia recusar a
cobrança e não sabia recusar a **vitrine** dela.

## O que fica

- **Onde um número vira preço na tela, a régua é a mesma do caminho que
  cobra.** Não é "um número finito"; é `valorValido`. Total que o
  servidor não vai cobrar não pode aparecer como total pagável.
- **Taxa sobre base inválida não é total, é ruído com aparência de
  número.** Somar taxa sobre zero devolve algo que passa em qualquer
  teste de "é número?".
- **Consertar a ocorrência não conserta a classe.** O conserto vai onde a
  regra mora, e depois se procuram as outras telas que leem preço. Aqui
  foram duas com botão de pagar — pedido e assinatura, as duas
  corrigidas. A terceira, a de status, também usa `Number(valor ?? 0)`,
  mas lê da nossa própria base, onde o valor já passou pelo guarda na
  criação, e não oferece nada para clicar: fica anotada como a próxima
  da fila se um dia uma linha vier incompleta, não como furo de hoje.
- **O teste de ponta a ponta achou isto no passo 1.** Onze suítes verdes
  e quatro dias de produção não acharam, porque nenhuma delas tinha um
  contratante devolvendo um pedido sem preço. Fixture de caso ruim vale
  o que custa.

Protegido por `tests/total-nao-confiavel-nao-vira-tela-compravel.js`.
