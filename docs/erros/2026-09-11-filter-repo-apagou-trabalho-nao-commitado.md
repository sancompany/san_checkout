# `git filter-repo --force` apagou trabalho que não tinha sido commitado

**Sintoma.** O comando não falha — ele "funciona". Depois de rodá-lo,
seis arquivos alterados e um `git rm` já executado tinham sumido, e a
árvore do GitHub ainda mostrava o estado anterior.

**Causa raiz.** O comando entregue incluía `--force`:
`git filter-repo --path "Claude outputs" --invert-paths --force`.
O `git filter-repo` se recusa a rodar fora de um clone limpo justamente
para proteger quem tem trabalho pendente; `--force` desliga essa
proteção. Depois de reescrever, ele deixa a árvore de trabalho igual ao
novo `HEAD` — e o que não estava commitado não existia em `HEAD` nenhum.

**A culpa é de quem passou o comando, não de quem rodou:** a instrução
mandou fazer uma cópia da pasta antes, mas **não** mandou commitar as
alterações pendentes primeiro, que era a proteção que de fato importava.

**Correção.** Os seis arquivos foram regravados a partir das cópias que
existiam fora do repositório. Nada se perdeu de forma definitiva, mas só
porque havia cópia — não havia garantia nenhuma de que houvesse.

**Guarda.** A detecção não veio de erro nenhum, veio da reverificação: ao
conferir se `supabase/schema.sql` tinha saído do repositório (o arquivo
existia na época; hoje o schema são as migrations numeradas), a árvore do
GitHub ainda mostrava o arquivo e o último commit continuava sendo o
anterior. No disco, os seis arquivos tinham todos a **mesma data de
modificação** e o `schema.sql` tinha voltado 250 bytes maior — exatamente
uma quebra de linha a mais por linha, assinatura de um checkout do git
convertendo LF para CRLF no Windows. Data idêntica em vários arquivos e
tamanho que cresce pelo número exato de linhas são pistas de "o git
reescreveu isso", não de "alguém editou".

**Como evitar na origem.** Antes de qualquer operação que reescreva
histórico (`filter-repo`, `filter-branch`, `rebase -i`, `reset --hard`):
commitar tudo que está pendente — é a única proteção que vale, porque
cópia da pasta ajuda a recuperar mas commit evita perder; rodar
`git status` e conferir que a árvore está limpa; e só então reescrever,
de preferência num clone fresco, que é o modo em que o `filter-repo` roda
sem precisar de `--force`. **Quem monta o comando para outra pessoa rodar
assume esse passo junto:** a instrução tem que trazer o `git status` e o
commit, não só o aviso de fazer backup.

**Ecossistema:** sim — vale para qualquer repositório e qualquer stack, e
o agravante é geral: comando destrutivo passado por quem não vai rodá-lo
transfere o risco sem transferir o contexto de quem sabe o que está
pendente.
