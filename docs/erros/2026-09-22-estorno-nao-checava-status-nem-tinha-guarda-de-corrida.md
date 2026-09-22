# Estorno não checava `status` nenhum, e duas chamadas simultâneas podiam estornar a mesma cobrança duas vezes

**Quando:** 22/09/2026, achado na mesma auditoria técnica externa
(Codex, sem acesso de push a este repositório — o dono repassou o
relatório) que achou o furo do Pix/Boleto duplicado (AUD-001, ver
`docs/erros/2026-09-22-duas-requisicoes-simultaneas-criavam-dois-pix-ou-boletos-reais.md`).
**Onde:** `src/controllers/refundController.js` (`estornar`).

## O que aconteceu

`estornar` ia direto de `buscarCobrancaPorPedido` — que devolve a
linha mais RECENTE do pedido, **sem filtro de `status` nenhum** — pra
`estornarCobranca` na Asaas. Duas consequências reais, e as duas no
caminho do dinheiro:

1. **Corrida.** Duas chamadas de `POST /estornar` quase simultâneas
   pro mesmo pedido liam as duas a mesma cobrança `confirmado` e as
   DUAS chamavam a Asaas pra estornar — o mesmo dinheiro devolvido
   duas vezes (ou a segunda batendo num estado que a primeira já
   mudou por baixo, dependendo do que a Asaas faz com um segundo
   `POST /refund` pro mesmo pagamento — não medido, e não precisava
   ser: a guarda certa impede a segunda chamada de sair daqui).
2. **Sem checagem de estado nenhuma.** Nada impedia tentar estornar
   uma cobrança `pendente` (nunca foi paga), já `estornado`, ou com
   `estorno_solicitado` (boleto) já em andamento — todas aceitas do
   mesmo jeito.

Mesma classe de furo do AUD-001: uma ação com efeito real no PSP,
disparada sem verificar um estado que já estava disponível.

## A correção

Mesmo padrão que `assinaturaService.reivindicarTroca`/`liberarTroca`
já usa pro acerto de troca de plano (`trocando_em`, migration 0010) —
um arrendamento (lease) por `update` condicional, atômico no Postgres:

- Migration 0013 acrescenta `cobrancas.estornando_em`.
- `cobrancaService.reivindicarEstorno(chargeId)` — `update` que só
  encontra linha quando `status = 'confirmado'` **e**
  (`estornando_em` livre ou vencido, 5 min). A MESMA condição fecha os
  dois problemas de uma vez: só reivindica quem está no único estado
  que pode ser estornado, e só uma chamada ganha a corrida.
- `cobrancaService.liberarEstorno(chargeId)` — devolve o arrendamento
  quando a Asaas recusa de forma **limpa** (4xx com corpo
  reconhecido, nunca timeout/5xx/429 — mesma classificação do AUD-001,
  agora extraída pra `asaasService.foiRecusaLimpaDaAsaas` porque as
  duas rotas precisavam da MESMA regra e ela é grave demais pra ter
  uma definição por chamador).
- Falha **ambígua** da Asaas nunca libera o arrendamento — fica
  registrada em Lei 8 (`erros`) com o pedido e o chargeId nomeados,
  pra reconciliação manual. A mesma cobrança fica bloqueada pra uma
  nova tentativa até o prazo vencer ou alguém resolver — pior
  experiência que antes, mas é o único lado seguro: uma segunda
  tentativa sobre um estorno que já pode ter sido processado é o
  próprio furo que isto corrige.

`refundController.js` passou pro padrão de fábrica com `deps`
injetáveis (`criarRefundController`, igual `checkoutController.js`
desde o AUD-001) — sem isso não dava pra testar a corrida sem banco
real. 11 checagens novas: 401 sem chave/com chave errada, 404 sem
cobrança, caminho feliz Pix (síncrono, vira `estornado`) e Boleto
(assíncrono, vira `estorno_solicitado`), `pendente`/`estornado` já
recusam em 409 sem chamar a Asaas, corrida de verdade (duas chamadas
simultâneas — só uma reivindica, só uma chama a Asaas, a outra recebe
409), recusa limpa libera sem registrar em Lei 8, falha ambígua
(timeout e 429) NÃO libera e registra em Lei 8.

## Lição

`buscarCobrancaPorPedido` foi escrita pra devolver "a linha mais
recente desse pedido", sem opinião sobre o `status` dela — correto
pro uso original (mostrar a cobrança pro contratante consultar), mas
o `refundController` reusou essa mesma busca pra decidir se PODE
estornar, sem acrescentar a checagem que faltava. Uma função de
leitura sem filtro de estado é neutra; quem decide uma ação a partir
dela é quem precisa da guarda — e essa guarda não pode ser um `if`
solto (dois `if`s simultâneos leem o mesmo estado), tem que ser
atômica no banco.
