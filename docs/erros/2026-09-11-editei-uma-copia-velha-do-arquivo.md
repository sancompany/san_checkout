# Editei uma cópia velha do arquivo e achei que tinha gravado

## Sintoma

Nenhum, na hora — e é por isso que aconteceu duas vezes no mesmo dia.

A edição roda, a ferramenta responde "ok", o conteúdo novo está lá
quando releio. Só que o arquivo que eu li e editei não era o que está no
disco do projeto: era uma cópia antiga, trazida para o ambiente da
sessão em algum momento anterior. A gravação de volta ou não acontece,
ou grava por cima do arquivo certo um conteúdo montado a partir do
errado.

Na primeira vez, três documentos (`CONSTRAINTS.md`, `CLAUDE.md` e o
cabeçalho do `webhookController.js`) ficaram uma conversa inteira sem
chegar ao disco, enquanto eu tinha dito que estavam atualizados. Na
segunda, o `CONSTRAINTS.md` voltou sozinho para uma versão anterior
entre duas edições da mesma sessão — com seção duplicada e fora de
ordem, que era exatamente o defeito que a edição anterior tinha
corrigido.

## Causa raiz

A cópia do projeto que a sessão enxerga não é o projeto. Ela é
atualizada por uma transferência **assíncrona**: pedir o arquivo devolve
"ok" antes de a cópia nova chegar. Quem ler nesse intervalo lê a versão
velha; e uma transferência pedida antes pode chegar **depois** de uma
edição minha e sobrescrevê-la.

O erro por baixo disso não é de ferramenta, é de método: **eu tratei a
cópia como se fosse o original.** Confiar em "editei e reli, está certo"
funciona quando existe um arquivo só. Aqui existem dois, e o único que
importa é o que está no disco do projeto.

## Correção

Três regras, nesta ordem:

1. **Trazer o arquivo imediatamente antes de editar**, nunca no começo
   da sessão "para ter em mãos".
2. **Conferir o tamanho em bytes** do que chegou contra o que a listagem
   do diretório do projeto informa. Se não bate, a cópia ainda não
   chegou — esperar e conferir de novo, não editar.
3. **Depois de gravar, conferir o tamanho de novo pela listagem**, que
   lê o disco do projeto e não a cópia. Foi assim que o segundo caso
   apareceu: a gravação disse "escrito", e a listagem mostrou 18471
   bytes onde eu tinha mandado 18551.

## Como evitar na origem

Reler o próprio arquivo depois de editar **não prova nada** neste
arranjo — a releitura acerta a cópia, que é justamente a parte que pode
estar errada. A verificação só vale quando vem de uma fonte diferente da
que foi escrita.

É a mesma lição que este projeto já aprendeu de outro jeito em
`2026-09-11-filter-repo-apagou-trabalho-nao-commitado.md`: comando que
responde "sucesso" não é o mesmo que trabalho salvo, e quem passa o
comando é responsável por conferir o efeito, não a resposta.

E vale a comparação honesta de tamanho: documentação que eu afirmei
estar atualizada e não estava é do mesmo tipo de dano que documento
falso — o próximo a ler confia e não verifica.
