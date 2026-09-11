# Total ausente aparecia como "R$ NaN", e "consertar para zero" era pior

> **Candidata a lição do ecossistema.** Vale para qualquer tela que
> exiba valor vindo de API. Promover para `licoes-aprendidas.md` na
> próxima republicação do plugin.

## Sintoma

No resumo do checkout, `subtotal`, `desconto` e `taxasTotais` eram lidos
com `Number(x ?? 0)`; só o total não:

```js
const total = taxa.valorCobrado;
```

Faltando esse campo na resposta, a tela mostrava **"Total R$ NaN"** —
com o formulário e o botão de pagar inteiros ao lado.

## Causa raiz

Três das quatro linhas de dinheiro foram defendidas e a quarta não. Não
é alcançável hoje (o backend sempre manda o campo), mas era a única sem
guarda, e o custo de errar ali é o mais alto da tela.

## A correção errada, que quase entrou

O reflexo é igualar as quatro: `Number(taxa?.valorCobrado ?? 0)`. Isso
troca "R$ NaN" por **"R$ 0,00"**, que é pior:

- NaN é visivelmente quebrado; ninguém confirma uma compra assim.
- "R$ 0,00" parece compra grátis. O comprador confirma — e o valor
  cobrado não é o da tela, vem do modelo pull no servidor. A tela mente
  e o cartão é debitado com outro número.

**Valor desconhecido não é valor zero.** Zero é um preço; ausência não é.

## A correção certa

Falhar o carregamento em vez de exibir preço que não se sabe — é o que
gateway nenhum faz diferente: sessão sem total não vira checkout.

1. `aplicarNoResumo` lança quando `valorCobrado` não é finito ou é `<= 0`
   (o backend já recusa esse intervalo em `valorValido`).
2. O `catch` de `resolverContexto` chama `marcarPedidoIndisponivel`, que
   escreve o erro, troca os valores por travessão (`—`) e **esconde o
   painel de pagamento**.
3. O `app.js` já saía antes de ligar os botões; agora a tela mostra o
   mesmo que o sistema faz.

## O detalhe que só a tela revelou

A primeira versão da correção parava no passo 1: lançava e escrevia o
erro no título. Parecia suficiente **lendo o código**. Renderizada, a
tela mostrava "Total **R$ 0,00**" e o botão "Gerar QR Code Pix" ativo —
porque o `0,00` é o **placeholder do HTML**, e lançar antes de preencher
simplesmente o deixa lá.

Ou seja: a correção contra o "parece compra grátis" tinha produzido
exatamente "parece compra grátis", e a revisão por leitura não pegou.

## Como evitar na origem

- Ao defender um valor exibido, defender **todos** os irmãos na mesma
  passada. Três de quatro protegidos é sinal de que a quarta foi
  esquecida, não de que ela é segura.
- Ausência de valor **nunca** vira zero numa tela de dinheiro: ou o dado
  aparece, ou a tela deixa de oferecer a ação.
- Estado de erro precisa **apagar o placeholder**. Marcação que começa
  com `0,00`, `R$ 0,00` ou `--` no HTML vira dado falso no instante em
  que o carregamento falha.
- Conferir estado de erro **renderizado**, nunca só pelo código: o que
  sobra na tela quando o preenchimento não acontece é invisível na
  leitura.
