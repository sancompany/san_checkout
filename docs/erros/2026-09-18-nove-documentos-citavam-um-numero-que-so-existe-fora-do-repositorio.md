# Nove documentos citavam "53 eventos configurados", e nenhum teste podia pegar quando isso ficou falso

**Quando:** 18/09/2026, na mesma sessão do erro anterior
(`2026-09-18-respondi-com-uma-regra-que-o-mesmo-documento-contradizia.md`),
ao rodar `revisar` depois de o dono marcar 9 eventos a mais no painel da
Asaas.
**Onde:** `API.md`, `CLAUDE.md`, `CONSTRAINTS.md`, `RUNBOOK.md`,
`docs/funcional.md`, `docs/pendencias.md`,
`docs/ciclo-assinatura-mapa.md`, `docs/prompt-escopo-assinatura-mostrai.md`
— oito documentos vivos, todos citando "53 eventos configurados" ou
"zero eventos `SUBSCRIPTION_*`" como fato atual.

## O que aconteceu

O dono marcou 9 eventos a mais e desmarcou 1 no painel da Asaas — uma
ação **fora do repositório**, sem commit nenhum. No instante em que ele
salvou, toda frase em tempo presente que citava "53 eventos" ou "zero
`SUBSCRIPTION_*`" ficou falsa, em oito arquivos diferentes, e **nenhum
deles mudou uma letra**.

Isto é diferente da lição da "N suítes" (já corrigida em 17-18/09): lá o
número existe **dentro do repositório** — `tests/executar.js` sabe
quantas suítes tem, e um teste (`tests/o-que-os-documentos-afirmam.js`)
compara a prosa contra a lista real a cada `npm test`. Aqui o número
existe **na conta da Asaas**, um sistema de terceiro que o repositório
não enxerga. Não existe consulta que rode no CI e descubra que o painel
mudou — a única forma de saber é medir de novo, de propósito, contra a
API deles.

## A regra que fica

**Número que mora fora do repositório nunca é "fato", é "medido em
`<data>`" — e essa data tem de estar impressa ao lado do número toda
vez que ele aparece.** "53 eventos configurados" sem data é uma
afirmação que expira sem aviso; "53 eventos configurados, medido em
16/09/2026" é uma citação histórica que continua verdadeira para
sempre, porque não afirma nada sobre hoje.

A varredura para achar os nove lugares exigiu **grep amplo em todos os
documentos vivos**, não leitura sequencial — o mesmo método que achou a
divergência da lição anterior. Achar quatro na primeira passada e mais
cinco na segunda (repetindo o ciclo de `revisar`, como a skill manda)
confirma que uma passada só não basta quando o termo se espalhou por
citação-e-recitação ao longo de vários dias.

**O que corrigir na fonte, e não só nas cópias:** quando um mesmo dado
de terceiro é citado em mais de dois documentos, vale a pena escrever
uma vez só, no lugar mais autoritativo (`CONSTRAINTS.md` §2.2, que já se
declara "referência única"), e nos outros apontar **para lá** em vez de
repetir o número — um ponteiro por função nunca envelhece porque nunca
afirma o valor, só onde achá-lo.

**Ecossistema:** sim. Vale para qualquer projeto que documenta
configuração de um painel de terceiro (webhook, feature flag, cota,
plano contratado) em prosa — o número certo no dia em que foi escrito é
garantido de ficar errado no dia em que alguém mexer no painel sem
passar pelo repositório.
