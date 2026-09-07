/**
 * public/js/modules/cartaoHandler.js
 *
 * ⚠️ CHAMA UM ENDPOINT QUE AINDA NÃO EXISTE NO BACKEND
 * (`POST /api/checkout/cartao/:contratanteId/:pedidoId`). Este módulo
 * está pronto pro dia em que esse endpoint for construído — até lá,
 * clicar em "Continuar" vai dar erro 404, esperado.
 *
 * Fluxo: escolhe parcelas (tela nossa, sem dado de cartão) → backend
 * cria a sessão Asaas Checkout com o valor já calculado pra aquela
 * parcela → abrimos a pop-up → ficamos de olho no resultado fazendo
 * polling no NOSSO backend (que vai saber via webhook CHECKOUT_PAID/
 * CHECKOUT_CANCELED/CHECKOUT_EXPIRED), sem depender de postMessage
 * entre as janelas.
 */

import { post, get } from '../utils/api.js';

const INTERVALO_POLLING_MS = 3000;
const INTERVALO_VERIFICA_POPUP_MS = 500;
const ESPERA_POS_FECHAMENTO_MS = 15000;
let idIntervaloAtivo = null;
let idVerificaPopup = null;

function pararPolling() {
  if (idIntervaloAtivo) {
    clearInterval(idIntervaloAtivo);
    idIntervaloAtivo = null;
  }
  if (idVerificaPopup) {
    clearInterval(idVerificaPopup);
    idVerificaPopup = null;
  }
}

/** Se o pagador fecha a pop-up sem concluir, a Asaas só nos avisa
 *  (CHECKOUT_CANCELED/EXPIRED) depois de um tempo — sem isso o botão
 *  ficava preso em "Abrindo pagamento…" até lá. Detecta o fechamento
 *  direto pelo `window.open` e libera o botão na hora. */
function observarFechamentoPopup(popup, aoFechar) {
  if (!popup) return;
  idVerificaPopup = setInterval(() => {
    if (popup.closed) {
      clearInterval(idVerificaPopup);
      idVerificaPopup = null;
      aoFechar();
    }
  }, INTERVALO_VERIFICA_POPUP_MS);
}

function iniciarPollingPopup(asaasCheckoutId, { aoConfirmar, aoFalhar }) {
  pararPolling();
  idIntervaloAtivo = setInterval(async () => {
    try {
      const { status } = await get(`/api/checkout/asaas-checkout/status/${asaasCheckoutId}`);
      if (status === 'CHECKOUT_PAID') { pararPolling(); aoConfirmar(); }
      else if (status === 'CHECKOUT_CANCELED' || status === 'CHECKOUT_EXPIRED') { pararPolling(); aoFalhar(status); }
    } catch {
      // falha pontual de rede não derruba o polling
    }
  }, INTERVALO_POLLING_MS);
}

/**
 * @param {{ contratanteId, pedidoId, parcelas, dadosPagador, mostrarToast }} contexto
 */
export async function continuarComCartao({ contratanteId, pedidoId, parcelas, dadosPagador, mostrarToast }) {
  const botao = document.getElementById('btn-continuar-cartao');
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Abrindo pagamento…';

  try {
    const { checkoutUrl, asaasCheckoutId } = await post(
      `/api/checkout/cartao/${contratanteId}/${pedidoId}`,
      { ...dadosPagador, parcelas: Number(parcelas) }
    );

    const popup = window.open(checkoutUrl, '_blank', 'width=480,height=760');

    iniciarPollingPopup(asaasCheckoutId, {
      aoConfirmar: () => {
        botao.textContent = 'Pagamento Aprovado ✓';
        botao.classList.add('btn-success');
        mostrarToast('Pagamento aprovado!', 'sucesso');
      },
      aoFalhar: (status) => {
        mostrarToast(`O pagamento não foi concluído (${status}).`, 'erro');
        botao.disabled = false;
        botao.textContent = textoOriginal;
      }
    });

    observarFechamentoPopup(popup, () => {
      if (botao.textContent !== 'Abrindo pagamento…') return; // já confirmou/falhou por outro caminho
      // Não desiste na hora — o webhook CHECKOUT_PAID pode chegar
      // alguns segundos DEPOIS de fechar a pop-up (a Asaas confirma o
      // pagamento antes de reagir ao fechamento). Só assume "fechou
      // sem pagar" se continuar sem resposta depois da folga — evita
      // dizer "pode tentar de novo" pra quem já pagou.
      botao.textContent = 'Confirmando pagamento…';
      setTimeout(() => {
        if (botao.textContent !== 'Confirmando pagamento…') return; // confirmou/falhou nesse meio tempo
        pararPolling();
        botao.disabled = false;
        botao.textContent = textoOriginal;
        mostrarToast('Não conseguimos confirmar o pagamento. Se você concluiu o pagamento, aguarde a confirmação chegar antes de tentar de novo.', 'erro');
      }, ESPERA_POS_FECHAMENTO_MS);
    });
  } catch (erro) {
    mostrarToast(erro.message || 'Não foi possível iniciar o pagamento por cartão.', 'erro');
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}

export { pararPolling as pararPollingCartao };
