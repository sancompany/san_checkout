# `git filter-repo --force` apagou trabalho que não tinha sido commitado

## O que aconteceu

Na Estação 4, a reescrita de histórico para remover `Claude outputs/`
funcionou — mas levou junto seis arquivos de trabalho que estavam
modificados no diretório e **ainda não tinham sido commitados**:
`CLAUDE.md`, `CONSTRAINTS.md`, `README.md`, `src/server.js`,
`docs/inventario-de-dados.md` e
`docs/erros/2026-09-11-ci-preso-em-node-20.md`. O `git rm
supabase/schema.sql`, que também tinha sido rodado, foi desfeito junto.

## Causa raiz

O comando entregue para a reescrita incluía `--force`:

```
git filter-repo --path "Claude outputs" --invert-paths --force
```

O `git filter-repo` se recusa a rodar fora de um clone limpo justamente
para proteger quem tem trabalho pendente. `--force` desliga essa
proteção. Depois de reescrever, ele deixa a árvore de trabalho igual ao
novo `HEAD` — e o que não estava commitado não existia em `HEAD` nenhum.

A culpa é de quem passou o comando, não de quem rodou: a instrução
mandou fazer uma cópia da pasta antes, mas **não** mandou commitar as
alterações pendentes primeiro, que era a proteção que de fato importava.

## Como foi detectado

Não pelo erro — o comando não falha, ele "funciona". Foi na
reverificação: ao conferir se `supabase/schema.sql` tinha saído do
repositório, a árvore do GitHub ainda mostrava o arquivo, e o último
commit continuava sendo o anterior. No disco, os seis arquivos tinham
todos a mesma data de modificação (a do checkout do filter-repo) e o
`schema.sql` tinha voltado 250 bytes maior — exatamente uma quebra de
linha a mais por linha, a assinatura de um checkout do git convertendo
LF para CRLF no Windows.

**A lição de diagnóstico:** data de modificação idêntica em vários
arquivos e tamanho que cresce pelo número exato de linhas são pistas de
"o git reescreveu isso", não de "alguém editou".

## Correção

Os seis arquivos foram regravados a partir das cópias que existiam fora
do repositório. Nada se perdeu de forma definitiva, mas só porque havia
cópia — não havia garantia nenhuma de que houvesse.

## Como não repetir

Antes de qualquer operação que reescreva histórico (`filter-repo`,
`filter-branch`, `rebase -i`, `reset --hard`):

1. **Commitar tudo que está pendente.** É a única proteção que vale;
   cópia da pasta ajuda a recuperar, mas commit evita perder.
2. Rodar `git status` e conferir que a árvore está limpa.
3. Só então reescrever — de preferência num clone fresco, que é o modo
   em que o `filter-repo` roda sem precisar de `--force`.

Quem monta o comando para outra pessoa rodar assume o passo 1 junto: a
instrução tem que trazer o `git status` e o commit, não só o aviso de
fazer backup.
