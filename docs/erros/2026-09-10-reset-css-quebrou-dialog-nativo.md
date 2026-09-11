# Reset de CSS quebrou a centralização do `<dialog>`

**Sintoma.** Os modais do painel administrativo abriam grudados no canto
superior esquerdo em vez de centralizados.

**Causa raiz.** O reset `*, *::before, *::after { margin: 0 }` zerou o
`margin: auto` que o próprio navegador aplica ao `<dialog>` — é ele que
centraliza o elemento nativo, e não uma regra do projeto.

**Correção.** Restaurar `margin: auto` no `dialog`, com comentário
dizendo de onde vem.

**Guarda.** Nenhuma automática, e isto é declaração e não omissão:
defeito de estilo nativo não falha em teste, porque nada quebra — só
fica errado na tela. A verificação é a da última linha, feita a olho na
tela renderizada, e o comentário ao lado da regra restaurada diz de onde
vem o `margin: auto` para ninguém "limpar" de novo.

**Como evitar na origem.** Reset universal também apaga o estilo padrão
de elementos nativos que dependem dele (`dialog`, `details`, controles de
formulário). Ao usar um elemento nativo pela primeira vez depois de um
reset agressivo, conferir visualmente antes de considerar pronto — três
defeitos reais desta leva apareceram só quando a tela foi de fato
renderizada e olhada.

**Ecossistema:** sim — reset universal de CSS é prática comum em
qualquer projeto de front, e em todos eles apaga o estilo padrão de
elementos nativos que dependem dele (`dialog`, `details`, controles de
formulário).
