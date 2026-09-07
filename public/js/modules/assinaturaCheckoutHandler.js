/**
 * public/js/modules/assinaturaCheckoutHandler.js
 *
 * ⚠️ CHAMA UM ENDPOINT QUE AINDA NÃO EXISTE NO BACKEND
 * (`POST /api/checkout/assinatura/:contratanteId/:planoId`). Pronto
 * pro dia em que existir — até lá, 404 esperado.
 *
 * O backend, quando construído, cria a sessão com
 * `chargeTypes: ["RECURRENT"]` (ver VISAO_COMPLETA.md seção 4.4) e
 * devolve a URL certa pro ambiente (produção vs sandbox têm domínios
 * de exibição DIFERENTES — `asaas.com` vs `sandbox.asaas.com` — não é
 * só trocar a API base).
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
 * @param {{ contratanteId, planoId, dadosPagador, mostrarToast }} contexto
 */
export async function assinarAgora({ contratanteId, planoId, dadosPagador, mostrarToast }) {
  const botao = document.getElementById('btn-assinar');
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Abrindo pagamento…';

  try {
    const { checkoutUrl, asaasCheckoutId } = await post(
      `/api/checkout/assinatura/${contratanteId}/${planoId}`,
      dadosPagador
    );

    const popup = window.open(checkoutUrl, '_blank', 'width=480,height=760');

    iniciarPollingPopup(asaasCheckoutId, {
      aoConfirmar: () => {
        botao.textContent = 'Assinatura Ativa ✓';
        botao.classList.add('btn-success');
        mostrarToast('Assinatura criada com sucesso!', 'sucesso');
      },
      aoFalhar: (status) => {
        mostrarToast(`Não foi possível concluir a assinatura (${status}).`, 'erro');
        botao.disabled = false;
        botao.textContent = textoOriginal;
      }
    });

    observarFechamentoPopup(popup, () => {
      if (botao.textContent !== 'Abrindo pagamento…') return; // já confirmou/falhou por outro caminho
      // Mesma folga do cartaoHandler.js: o webhook CHECKOUT_PAID pode
      // chegar alguns segundos DEPOIS de fechar a pop-up — só assume
      // "fechou sem pagar" se continuar sem resposta depois dela.
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
    mostrarToast(erro.message || 'Não foi possível iniciar a assinatura agora.', 'erro');
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}

export { pararPolling as pararPollingAssinatura };
