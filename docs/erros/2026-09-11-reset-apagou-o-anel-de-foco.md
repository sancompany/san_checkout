# Reset de CSS apagou o anel de foco do teclado

**Sintoma.** Nenhum — e é esse o problema. A tela funciona, o mouse
funciona, nada quebra. Quem navega por teclado é que não enxerga onde
está: ao chegar num botão com Tab, não aparece indicação nenhuma. No
checkout isso alcança o botão de pagar.

**Causa raiz.** `public/css/base.css` zerava o anel do navegador em dois
seletores (`button { outline: none }` e `input, select { outline: none }`).
Para `input` e `select` havia substituto (`input:focus` / `select:focus`
em `components/forms.css` desenham borda e sombra). Para **botão não
havia nenhum**, e não existia `:focus-visible` em lugar algum do projeto.
O `outline: none` costuma ser escrito para tirar o anel feio do clique de
mouse — mas ele tira dos dois, e só o do mouse era o alvo.

É a **segunda** vez que este mesmo reset apaga comportamento nativo: a
primeira foi o `margin: 0` universal descentralizando o `<dialog>`, em
`2026-09-10-reset-css-quebrou-dialog-nativo.md`.

**Correção.** Uma regra em `public/css/base.css`, logo abaixo das duas
que apagam:
`:focus-visible { outline: 2px solid var(--action-primary, #2563EB); outline-offset: 2px; }`.
`:focus-visible` acende só para teclado, então o clique de mouse continua
sem anel — o objetivo original do `outline: none` é preservado. A cor
**não** é a de foco do projeto (`--border-focus`, dourado): medido contra
o branco do cartão, o dourado dá 2,9:1, abaixo do mínimo de 3:1, e o azul
`--action-primary` dá 5,2:1. O `outline-offset` joga o anel para fora da
borda, para ele aparecer também sobre o botão primário, que já é azul.

O **3:1** veio do WCAG 2.2, critério 1.4.11 *Non-text Contrast*
(<https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html>),
consultado na data e não citado de memória. E a ressalva dele é o que
transforma isto em obrigação nossa: o critério **isenta** o que "o agente
de usuário determina e o autor não modificou". O anel padrão do navegador
era isento; no instante em que o projeto escreveu `outline: none`, o
contraste passou a ser responsabilidade do projeto.

**Guarda.** Verificação com a tela renderizada: subir a página com a API
stubada, navegar **por Tab** até o botão e ler o estilo computado —
`outline: solid 2px rgb(37, 99, 235)`, `outline-offset: 2px`. Antes da
correção, o mesmo caminho dava `outline: none`. Duas armadilhas dessa
verificação valem registro: o primeiro teste rodou no `admin.html`, que
**não carrega** `base.css`, e o botão de lá mostrava o anel padrão do
navegador dando a impressão de que a regra não tinha efeito — a página
errada quase produziu a conclusão certa pelo motivo errado; e
`.focus()` por script não aciona `:focus-visible`, então medir sem Tab de
verdade mostra `outline: none` mesmo com a regra no lugar.

**Como evitar na origem.** `outline: none` só entra acompanhado do
substituto, na mesma edição — nunca sozinho. Quem quer tirar o anel do
clique de mouse quer `:focus-visible`, não `:focus`. E, de novo, a regra
que o erro do `<dialog>` já tinha gerado: depois de um reset agressivo,
conferir **com a tela renderizada e navegando por teclado**, não lendo o
CSS — este defeito é invisível na leitura, porque o que falta não está
escrito em lugar nenhum.

**Ecossistema:** sim — qualquer projeto com reset de CSS pode cometê-lo,
e o dano cai sempre sobre quem navega por teclado, que é justamente quem
não costuma estar na sala quando a tela é aprovada.
