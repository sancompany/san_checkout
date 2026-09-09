/**
 * public/js/popup-fechar.js
 * Extraído do <script> inline de pagamento-popup-fechar.html — precisa
 * ser arquivo externo pra script-src 'self' da CSP (public/_headers)
 * funcionar sem 'unsafe-inline'.
 *
 * A Asaas pode (ou não) redirecionar a pop-up pra cá conforme o
 * resultado (callback.successUrl/cancelUrl/expiredUrl é campo
 * obrigatório no Asaas Checkout, mas quem manda de verdade é sempre o
 * webhook + polling no backend, nunca este redirect). Só tentamos
 * fechar sozinho quando a janela foi de fato aberta via window.open
 * pelo nosso próprio checkout.
 */
if (window.opener) {
  setTimeout(() => window.close(), 1500);
}
