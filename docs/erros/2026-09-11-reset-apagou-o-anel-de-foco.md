# Reset de CSS apagou o anel de foco do teclado

> **Candidata a lição do ecossistema.** O erro não depende de nada
> específico deste código: qualquer projeto com reset de CSS pode
> cometê-lo. Promover para `licoes-aprendidas.md` na próxima
> republicação do plugin.

## Sintoma

Nenhum — e é esse o problema. A tela funciona, o mouse funciona, nada
quebra. Quem navega por teclado é que não enxerga onde está: ao chegar
num botão com Tab, não aparece indicação nenhuma. No checkout isso
alcança o botão de pagar.

## Causa raiz

`public/css/base.css` zerava o anel do navegador em dois seletores:

```css
button { … outline: none; }
input, select { … outline: none; }
```

Para `input` e `select` havia substituto (`input:focus` / `select:focus`
em `components/forms.css` desenham borda e sombra). Para **botão não
havia nenhum**, e não existia `:focus-visible` em lugar algum do
projeto. O `outline: none` costuma ser escrito para tirar o anel feio do
clique de mouse — mas ele tira dos dois, e só o do mouse era o alvo.

É a **segunda** vez que este mesmo reset apaga comportamento nativo: a
primeira foi o `margin: 0` universal descentralizando o `<dialog>`, em
`2026-09-10-reset-css-quebrou-dialog-nativo.md`.

## Correção

Uma regra em `public/css/base.css`, logo abaixo das duas que apagam:

```css
:focus-visible { outline: 2px solid var(--action-primary, #2563EB); outline-offset: 2px; }
```

`:focus-visible` acende só para teclado, então o clique de mouse continua
sem anel — o objetivo original do `outline: none` é preservado.

A cor **não** é a de foco do projeto (`--border-focus`, dourado): medido
contra o branco do cartão, o dourado dá 2,9:1, abaixo do mínimo de 3:1;
o azul `--action-primary` dá 5,2:1. O `outline-offset` joga o anel para
fora da borda, para ele aparecer também sobre o botão primário, que já é
azul.

**Fonte do 3:1** (consultada em 11/09/2026, não citada de memória):
WCAG 2.2, critério 1.4.11 *Non-text Contrast* —
<https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html>.
Ele exige 3:1 contra as cores adjacentes para componentes de interface e
declara que indicador de foco está coberto, em conjunto com o 2.4.7
*Focus Visible*.

E a ressalva dele é justamente o que transforma isto em obrigação
nossa: o critério **isenta** o que "o agente de usuário determina e o
autor não modificou". O anel padrão do navegador era isento. No instante
em que o projeto escreveu `outline: none`, a responsabilidade pelo
contraste passou a ser do projeto.

## Como foi verificado

Não por leitura. O checkout é renderizado por JavaScript e não mostra
controle nenhum sem um pedido carregado, então a verificação exigiu subir
a página com a API stubada, navegar por Tab até o botão e ler o estilo
computado: `outline: solid 2px rgb(37, 99, 235)`, `outline-offset: 2px`.
Antes da correção, o mesmo caminho dava `outline: none`.

Duas armadilhas apareceram nessa verificação e valem registro:

- O primeiro teste rodou no `admin.html`, que **não carrega**
  `base.css` — o botão de lá mostrava o anel padrão do navegador e dava
  a impressão de que a regra não tinha efeito. A página errada quase
  produziu a conclusão errada.
- A captura mostrou "Total R$ NaN", que parecia defeito do produto e era
  do stub: o código espera `taxa: { taxasTotais, valorCobrado }` e o
  stub mandava outro formato.

## Como evitar na origem

`outline: none` só entra acompanhado do substituto, na mesma edição —
nunca sozinho. Quem quer tirar o anel do clique de mouse quer
`:focus-visible`, não `:focus`.

E, de novo, a regra que o erro do `<dialog>` já tinha gerado: reset
universal apaga estilo padrão de comportamento nativo. Depois de um
reset agressivo, conferir **com a tela renderizada e navegando por
teclado**, não lendo o CSS — este defeito é invisível na leitura, porque
o que falta não está escrito em lugar nenhum.
