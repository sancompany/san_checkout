# Reset de CSS quebrou a centralização do `<dialog>`

**Sintoma.** Os modais do painel administrativo abriam grudados no canto
superior esquerdo em vez de centralizados.

**Causa raiz.** O reset `*, *::before, *::after { margin: 0 }` zerou o
`margin: auto` que o próprio navegador aplica ao `<dialog>` — é ele que
centraliza o elemento nativo, e não uma regra do projeto.

**Correção.** Restaurar `margin: auto` no `dialog`, com comentário
dizendo de onde vem.

**Como evitar na origem.** Reset universal também apaga o estilo padrão
de elementos nativos que dependem dele (`dialog`, `details`, controles de
formulário). Ao usar um elemento nativo pela primeira vez depois de um
reset agressivo, conferir visualmente antes de considerar pronto — três
defeitos reais desta leva apareceram só quando a tela foi de fato
renderizada e olhada.
