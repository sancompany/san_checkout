# A troca de plano tirou a estabilidade de uma chave, e o código inteiro assumia que ela era estável

**17/09/2026 — achado em revisão (ciclos 3, 4 e 5), antes de ir ao ar.**

## O que aconteceu

Construí `POST /trocar-plano`. Ela faz uma coisa que nunca tinha
acontecido neste sistema: **muda o `plano_id` de uma assinatura viva**.

Até aquele dia, o par `plano_id` + `documento` era a chave de uma
assinatura em todo lugar — é assim que o contratante cancela, pausa,
retoma e concilia, e é assim que o webhook de assinatura identifica quem
pagou (`API.md` §4.3.4). A chave nunca mudava, então ninguém precisava
perguntar o que aconteceria se ela mudasse.

A rota passou pelo autoteste, por nove sabotagens e por medição ao vivo.
O que ela NÃO tinha era a pergunta: **quem mais depende de essa chave
nunca mudar?**

## Os três furos, todos da mesma raiz

1. **A segunda troca dentro do mesmo período era impossível.** O ciclo
   pago fica gravado sob o plano ANTIGO; procurar o último ciclo pelo
   plano atual não achava nada, e a rota respondia "a cobrança do período
   não está confirmada" — falso, e no caminho do dinheiro.
2. **Todo ciclo seguinte avisaria o contratante com o plano errado, para
   sempre.** O ciclo novo se monta copiando a cobrança anterior, e a
   anterior guarda o plano que era. Como cada ciclo copia do anterior, o
   erro não se corrigiria sozinho nunca — o contratante creditaria o
   plano que o assinante deixou de ter, a cada cobrança.
3. **A conciliação diria "nenhuma cobrança"** para uma assinatura que já
   cobrou, entre a troca e o ciclo seguinte — justamente no campo que o
   `API.md` §5.3 manda usar como valor de verdade (RN-34).

Os três têm a mesma correção: **ancorar na assinatura, não no plano.**
A assinatura é o que não muda quando o plano muda.

## A lição

**Quando uma mudança faz um identificador deixar de ser estável, o
trabalho não é a mudança — é a varredura de quem dependia da
estabilidade.** E ela não se faz achando um lugar por vez: o ciclo 3
achou um, o ciclo 4 achou outro, e só no ciclo 5 eu parei de remendar e
varri de uma vez todos os pontos que usavam o plano como chave de
assinatura. Os dois primeiros custaram um ciclo cada; a varredura custou
cinco minutos e fechou o assunto.

Vale a pergunta, em toda mudança que reescreve um campo existente:
**este campo é chave de alguma coisa em outro lugar?** Se for, a lista de
lugares é parte da mudança, não trabalho posterior.

## Como isto não volta

- `buscarCobrancaPorSubscriptionId` e `buscarUltimaCobrancaDaAssinatura`
  filtram por método de assinatura, e há checagem no texto-fonte que
  reprova se o filtro sair.
- O ciclo novo tira o plano da tabela `assinaturas`, e o autoteste do
  `webhookController` trava isso nos dois sentidos (com troca e sem).
- A conciliação ancora na assinatura e mantém a busca por plano como
  rede, com checagem no texto-fonte.
- `API.md` §5.6 diz, na cara do integrador, que depois da troca o
  `planoId` dele é o novo — e é por isso que o evento `plano_trocado`
  carrega `planoAnterior`.
