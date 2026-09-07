/**
 * SAN CHECKOUT v2 — src/config/asaas.js
 * Único arquivo que sabe URL base e formato de autenticação da Asaas.
 */

const API_SANDBOX = 'https://api-sandbox.asaas.com';
const API_PRODUCAO = 'https://api.asaas.com';

// Domínio de EXIBIÇÃO da pop-up (Asaas Checkout) — é DIFERENTE do
// domínio da API. Confirmado nesta conversa: produção usa asaas.com,
// sandbox usa sandbox.asaas.com (não é só trocar api. por sandbox.).
const CHECKOUT_SANDBOX = 'https://sandbox.asaas.com';
const CHECKOUT_PRODUCAO = 'https://asaas.com';

function obterAmbiente() {
  return process.env.ASAAS_AMBIENTE === 'producao' ? 'producao' : 'sandbox';
}

export function getConfigAsaas() {
  const chave = process.env.ASAAS_API_KEY;
  if (!chave) {
    throw new Error('ASAAS_API_KEY não configurada no .env.');
  }

  const ambiente = obterAmbiente();

  return {
    baseUrl: ambiente === 'producao' ? API_PRODUCAO : API_SANDBOX,
    headers: {
      'Content-Type': 'application/json',
      access_token: chave
    }
  };
}

/** Monta a URL da pop-up a partir do id retornado por POST /v3/checkouts. */
export function montarUrlCheckoutSession(asaasCheckoutId) {
  const dominio = obterAmbiente() === 'producao' ? CHECKOUT_PRODUCAO : CHECKOUT_SANDBOX;
  return `${dominio}/checkoutSession/show?id=${asaasCheckoutId}`;
}

/**
 * `callback` é OBRIGATÓRIO no POST /v3/checkouts (confirmado em
 * sandbox — sem ele a Asaas recusa com "O campo callback deve ser
 * informado"), mesmo no nosso fluxo de pop-up + polling, que nunca
 * depende de redirecionamento de verdade. As três URLs apontam pra uma
 * página estática só de "pode fechar essa janela" — quem manda de
 * verdade no resultado é sempre o webhook + polling no NOSSO backend,
 * nunca esse redirect.
 */
export function montarCallbackPadrao() {
  const origemFrontend = process.env.ORIGEM_FRONTEND || 'http://127.0.0.1:5500';
  const urlFechamento = `${origemFrontend}/public/pagamento-popup-fechar.html`;
  return {
    successUrl: urlFechamento,
    cancelUrl: urlFechamento,
    expiredUrl: urlFechamento
  };
}
