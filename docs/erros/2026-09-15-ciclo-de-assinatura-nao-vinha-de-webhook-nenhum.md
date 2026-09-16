# Corrigi um campo que não existia no webhook lendo outro campo que também não existia

**Quando:** 15/09/2026, verificando ao vivo o reparo manual da cobrança
do mostrai (a que motivou o PR #15, o vínculo de `charge_id`).
**Onde:** `src/controllers/webhookController.js`,
`amarrarAssinaturaACobranca`.

## O que aconteceu

Depois de reparar a cobrança órfã e conferir o resultado, a linha em
`assinaturas` mostrava `ciclo: MONTHLY` — mas o plano do mostrai é
`QUARTERLY`, e isso estava certo desde o início: o `CHECKOUT_PAID`
original trazia `checkout.subscription.cycle: "QUARTERLY"`, no payload
cru gravado em `webhook_eventos`.

A causa imediata: `amarrarAssinaturaACobranca` lia `payment.cycle`, que
não existe em nenhum payload medido — nem `CHECKOUT_PAID` nem
`PAYMENT_CONFIRMED` o carregam. O `?? null` caía direto no default de
`assinaturaService.upsertAssinatura` (`ciclo ?? 'MONTHLY'`).

**Minha primeira correção repetiu o padrão do bug que eu tinha acabado
de corrigir.** Em vez de reconhecer que "ler um campo que não existe no
webhook" era o problema, tratei como "li o campo errado" — e escrevi um
mecanismo de *relay*: capturar `checkout.subscription.cycle` no
`CHECKOUT_PAID` (onde ele de fato existe) e carregar até o
`PAYMENT_CONFIRMED`, via duas colunas novas em `cobrancas`. Funcionava,
tinha teste, sobreviveu a duas sabotagens. E era complexidade
desnecessária: migration, função nova (`salvarCicloAssinaturaPendente`),
mais um residual (se `PAYMENT_CONFIRMED` chegasse antes do
`CHECKOUT_PAID`, o relay ainda não teria sido escrito — a mesma classe
de bug, só que mais estreita).

## A correção de verdade

`ciclo` **não é dado de webhook**. É informação que o próprio checkout
já conhece, com certeza, antes de mandar qualquer coisa pra Asaas:
`criarCheckoutAssinatura` lê `plano.ciclo`, valida contra
`CICLOS_VALIDOS`, e usa esse valor pra montar `subscription.cycle` na
criação da sessão. O único lugar que precisava mudar era gravar esse
mesmo valor, já em mãos, na própria cobrança
(`registrarCobrancaPendentePopup`) — no nascimento da linha, não em
reação a um webhook.

Isso elimina o relay inteiro, e com ele o residual de ordem: `ciclo`
está na linha desde antes de existir qualquer sessão na Asaas, então
antes de qualquer webhook poder chegar. Não importa se `CHECKOUT_PAID`
ou `PAYMENT_CONFIRMED` chega primeiro — o dado já estava lá.

Migration 0006 ficou mais enxuta (só `cobrancas.ciclo`, mais uma coluna
`proxima_cobranca` reservada e explicitamente **não** populada — ver
abaixo). `salvarCicloAssinaturaPendente` nunca chegou a existir na
versão final.

## O que ainda não tem solução, e por quê

`proximaCobranca` continua `null`. `payment.nextDueDate` também não
existe em payload nenhum, e — diferente do `ciclo` — não há uma fonte
alternativa igualmente simples: o `nextDueDate` que **nós mandamos** pra
Asaas na criação é a data de **hoje** (a cobrança é imediata), não uma
projeção da próxima cobrança real. Gravar esse valor seria pior que
`null`: pareceria uma informação precisa sem ser uma.

## A lição

Achar que corrigiu um bug de "campo errado" sem perguntar **por que**
aquele campo nunca existia é o mesmo erro com um passo a menos de
distância. A pergunta certa não é "de onde vem esse dado no webhook" —
é "esse dado *precisa* vir de um webhook?". Quando a resposta é não, e
a informação já está em mãos antes de qualquer chamada externa, a
correção mais simples também é a mais robusta: não relaiar, não
esperar, não ter ordem para se preocupar.
