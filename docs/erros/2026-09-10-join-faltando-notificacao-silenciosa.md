# `select('*')` sem join derrubou a notificação, em silêncio

**Sintoma.** Nenhum. É esse o problema. Pagamentos de Cartão e de
Assinatura eram confirmados corretamente no banco e o contratante
**nunca era avisado** — sem erro, sem log, sem falha visível.

**Causa raiz.** `buscarCobrancaPorCheckoutId` em
`src/services/cobrancaService.js` fazia `.select('*')` sem o join de
`contratantes`. A função que notifica desiste logo no
`if (!cobranca.contratantes?.webhook_url)` — e `contratantes` vinha
sempre `undefined`. A desistência silenciosa era o comportamento
projetado para "contratante sem webhook cadastrado"; ela apenas nunca
distinguiu isso de "o join não foi pedido".

Passou despercebido porque o fluxo de pop-up nunca tinha rodado com
webhook real.

**Correção.** `.select('*, contratantes(webhook_url, nome, api_key)')`.

**Guarda.** A mesma consulta passou a trazer `api_key`, que é o segredo
usado para assinar o webhook — sem ela o envio é recusado em vez de sair
sem assinatura.

**Como evitar na origem.** `select('*')` num ORM que exige join explícito
para relação **não** traz a relação. E toda desistência silenciosa
(`if (!x) return;`) num caminho que move dinheiro precisa distinguir
"não configurado" de "não carregado" — caso contrário um bug de consulta
vira comportamento normal.
