# Cancelar, pausar e retomar assinatura não tinham guarda de corrida entre si nem contra uma troca de plano em andamento

**Quando:** 22/09/2026, achado na mesma auditoria técnica externa
(Codex, sem acesso de push a este repositório — o dono repassou o
relatório) que achou o Pix/Boleto duplicado (AUD-001) e o estorno
duplicado (AUD-007).
**Onde:** `src/controllers/assinaturaController.js`
(`cancelarAssinatura`, `pausarAssinatura`, `retomarAssinatura`).

## O que aconteceu

As três rotas liam a assinatura, checavam o status aceito e chamavam a
Asaas — sem NENHUMA guarda contra outra chamada fazendo a mesma coisa
ao mesmo tempo. Diferente do AUD-001 e do AUD-007, nenhuma delas cobra
dinheiro diretamente, então o risco não é cobrança duplicada — é
**chamadas concorrentes na Asaas agindo sobre um estado que já mudou
debaixo delas**, e pior: nenhuma das três tinha guarda contra colidir
com uma **troca de plano em andamento** na mesma assinatura
(`trocaPlanoController.js`/`trocaExecucaoService.js`), que SIM cobra —
um cancelamento no meio de uma troca com acerto pendente de aprovação
deixaria o acerto cobrado numa assinatura que acabou de ser cancelada.

## A correção

Reaproveitou o arrendamento que já existia — `assinaturas.trocando_em`
(migration 0010), com `assinaturaService.reivindicarTroca`/
`liberarTroca` — em vez de criar um mecanismo novo. Apesar do nome
(nasceu com a troca de plano), ele já é o mutex certo: um `UPDATE`
condicional atômico no Postgres, com o mesmo prazo curto de 5 minutos.
As três rotas agora reivindicam antes de chamar a Asaas; perder a
corrida responde `409`.

Diferença importante em relação ao AUD-001/AUD-007: como nenhuma das
três operações cobra dinheiro, **a falha na Asaas SEMPRE libera o
arrendamento**, mesmo ambígua (timeout, 5xx) — não existe "será que já
cobrou" a proteger aqui. Se a Asaas processou a mudança mesmo com a
chamada tendo falhado do nosso lado, é a conciliação por pull
(`API.md` §5.3) que corrige o `status` local depois — mecanismo já
fechado em 16/09/2026 (`docs/pendencias.md`, "Sem reconciliação quando
cancelar/pausar/retomar perde a confirmação — CORRIGIDO 16/09") e fora
do escopo desta correção.

`assinaturaController.js` passou pro padrão de fábrica com `deps`
injetáveis (`criarAssinaturaController`) — não tinha NENHUM autoteste
até agora (nem estava em `tests/executar.js`), apesar de ser caminho de
dinheiro por tabela (a Lei 0 já deveria ter pego isso antes). 7
checagens novas: caminho feliz de cada operação, arrendamento ocupado
(troca em andamento) devolve `409` sem chamar a Asaas, falha na Asaas
sempre libera o arrendamento, `jaEstava` não reivindica nem chama a
Asaas (nada a serializar quando não vai haver chamada), corrida real
(duas chamadas simultâneas na mesma assinatura — só uma vence), e as
validações de sempre (401/404).

## Efeito colateral

`tests/assinatura-pausada-continua-cancelavel.js` fazia a checagem por
regex no texto-fonte assumindo `cancelarAssinatura` exportada
diretamente no topo do arquivo (`export async function
cancelarAssinatura...`) — não reconhecia a função vivendo dentro da
fábrica. Ajustado pra aceitar os dois formatos, e a nota do cabeçalho
que dizia "não dá pra testar sem refatorar" foi corrigida: agora dá,
e a suíte embutida faz isso.

## Lição

O mesmo arrendamento que uma mudança anterior criou para um propósito
específico (a troca de plano, 17/09/2026) já era, sem ninguém ter
decidido isso explicitamente, o mutex certo para qualquer operação que
muda uma assinatura na Asaas. Encontrar isso exigiu perguntar "o que
mais mexe nesta mesma linha, ao mesmo tempo, sem coordenação nenhuma?"
— não só "esta rota específica tem guarda?". As três rotas isoladas
pareciam simples demais para precisar de lock (nenhuma cobra); o risco
real só aparece quando se olha o conjunto contra a troca de plano.
