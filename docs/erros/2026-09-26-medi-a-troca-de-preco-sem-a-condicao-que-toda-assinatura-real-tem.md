# Medi a troca de preço sem a condição que toda assinatura real tem

**Data:** 26/09/2026 · **Onde:** homologação real, `POST /trocar-plano` · **Dinheiro movido:** nenhum

## O que aconteceu

Em 17/09/2026 eu medi no sandbox que a Asaas aceita `PUT /v3/subscriptions/{id}`
mudando `value` em assinatura de cartão, para cima e para baixo. Com base nisso
foi escrito que "a Asaas permite" trocar o preço, e a troca de plano foi
construída em cima disso (`API.md` §5.6 e §7.5).

Em 26/09/2026, na assinatura real `sub_39mjscz7vl2jwx7g` (anual, R$ 10, primeira
fatura paga no cartão), o rebaixamento para um anual de R$ 5 pelo fluxo oficial
voltou da Asaas com:

```
400 "Não é possível alterar o valor de assinaturas via cartão de crédito que já possuam faturas pagas"
```

A medição de 17/09 usou assinaturas de sandbox **sem fatura paga**. Pelo
Checkout, toda assinatura de cartão nasce com a primeira fatura paga. A condição
que decide o resultado era a que toda assinatura real tem, e a medição não a
incluiu.

## O que não deu errado

A recusa chegou antes de qualquer efeito. A rota não cobra nada no rebaixamento
e só grava depois de reler a Asaas. Conferido na Asaas e no banco depois da
chamada: valor 10, ciclo `YEARLY`, fatura `CONFIRMED`, 0 estornos, nenhuma
intenção, arrendamento devolvido.

## A lição

Medir o provedor no estado em que o dado real vai estar, não no estado mais
fácil de montar. "Assinatura de cartão" no sandbox, criada por API e nunca paga,
não é a mesma coisa que "assinatura de cartão" criada pelo Checkout. Antes de
afirmar que o provedor permite algo, listar as condições que o dado real sempre
tem (fatura paga, meio de pagamento, estado) e medir com elas.

## Estado

Declarado em `docs/pendencias.md` e em `API.md` §5.6/§7.5. O que fazer com a troca
de preço de assinatura de cartão paga é decisão do dono.
