# A pop-up da Asaas nunca fechava sozinha, e atrapalhava o próprio `returnUrl`

**Quando:** 19/09/2026, relatado pelo dono ("a pop up do assas fica
aberta o tempo todo depois do pagamento... ela atrapalha o returnurl").
**Onde:** `public/js/modules/cartaoHandler.js` (Cartão avulso) e
`public/js/modules/assinaturaCheckoutHandler.js` (Assinatura por
cartão) — os dois fluxos que abrem `window.open(checkoutUrl, ...)`.

## O que aconteceu

Os dois fluxos de pagamento com pop-up detectam a confirmação por
polling no NOSSO backend (`GET
/api/checkout/asaas-checkout/status/:id`, refletindo o webhook
`CHECKOUT_PAID`), e no `aoConfirmar` trocavam o texto do botão da
janela PRINCIPAL, mostravam o toast e chamavam `ativarRetorno()` — que
é o que mostra o link "Voltar para {loja}" e a contagem de 10s até
`window.location.replace(destinoAprovado)` (o `returnUrl`,
`retornoSeguro.js`). Em nenhum dos dois lugares a pop-up era fechada.

Resultado: o comprador pagava, e a janela da Asaas continuava aberta e
em foco, na frente — cobrindo exatamente a janela principal onde o
"Pagamento Aprovado" e a contagem de volta pra loja estavam
acontecendo. Quem não fechasse a pop-up manualmente nunca via o
`returnUrl` funcionar, mesmo ele estando correto e sendo honrado.

## Por que passou despercebido

Já existe um mecanismo pensado pra isso: `callback`
(`successUrl`/`cancelUrl`/`expiredUrl`,
`asaasCheckoutController.montarCallbackPadrao`) redireciona a pop-up
pra `pagamento-popup-fechar.html`, que se fecha sozinha
(`public/js/popup-fechar.js`, `window.close()` depois de 1,5s). Isso
criou a impressão de que "fechar a pop-up" já estava resolvido — só que
o próprio comentário da função avisa, desde que foi escrita: a Asaas
"pode (ou não) redirecionar", e quem manda de verdade é sempre o
webhook + polling no NOSSO backend, nunca esse redirect. Na prática, a
Asaas fica mostrando a própria tela de confirmação dela por padrão, sem
navegar pro `successUrl` — e ninguém tinha testado o fluxo até o fim
prestando atenção em qual janela ficava em foco depois.

## A regra que fica

**Quem detecta a confirmação de verdade (o polling no nosso backend)
também precisa ser quem fecha a pop-up — nunca só o redirect do
provedor, que é opcional por definição.** Corrigido chamando
`popup.close()` dentro do `aoConfirmar` dos dois fluxos, com a mesma
guarda que `observarFechamentoPopup` já usava
(`if (popup && !popup.closed)` — o pagador pode ter fechado a pop-up
sozinho antes do polling confirmar). O redirect via `callback` continua
existindo como reforço (harmless: fechar uma janela já fechada não faz
nada), não como único caminho.

Travado por `tests/popup-fecha-ao-confirmar.js`: varre os dois arquivos
e exige que o `aoConfirmar` (não o `aoFalhar`, nem o handler de
fechamento manual) feche a pop-up com a guarda — sabotagem verificada
manualmente (remover a linha de `cartaoHandler.js` reprova com a
mensagem certa; restaurado, volta a passar).

**Ecossistema:** sim. Vale para todo fluxo de pop-up de pagamento de
terceiro: se existe um redirect de callback controlado pelo provedor E
um polling nosso que é a fonte de verdade, a ação que depende da
confirmação (fechar a pop-up, redirecionar a janela principal) tem que
sair de quem tem a fonte de verdade — nunca só do redirect, que o
provedor pode pular, atrasar ou nunca disparar.
