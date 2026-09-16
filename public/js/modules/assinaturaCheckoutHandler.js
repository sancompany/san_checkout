/**
 * public/js/modules/assinaturaCheckoutHandler.js
 *
 * Assinatura por CARTÃO — cria a sessão RECURRENT no backend
 * (`POST /api/checkout/assinatura/:contratanteId/:planoId`,
 * `asaasCheckoutController.criarCheckoutAssinatura`, API.md §7) e abre
 * a pop-up hospedada da Asaas, igual ao cartão avulso
 * (`cartaoHandler.js`). O pagador digita o cartão uma vez; os ciclos
 * seguintes a Asaas cobra sozinha, sem passar por aqui de novo.
 *
 * Exercitado ao vivo em 15-16/09/2026 contra o sandbox: criação de
 * sessão (`checkoutUrl`/`asaasCheckoutId` reais, plano QUARTERLY e
 * YEARLY do testemaster), polling de status, e o pagamento em si —
 * a metade que só um cartão de teste no pop-up completa — segue no
 * `docs/pendencias.md`, gated no dono.
 */

import { post, get } from '../utils/api.js';
import { ativarRetorno } from './retorno.js';

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

    // Bloqueador de pop-up (ou Safari, que exige o `window.open` no
    // MESMO tick do clique — o `await post` acima já quebrou isso) faz
    // `window.open` devolver `null`. Sem esta checagem, `iniciarPollingPopup`
    // roda pra sempre esperando um `CHECKOUT_PAID` que nunca vem — o
    // pagador nunca viu a tela — e `observarFechamentoPopup` sai sem
    // armar nada (`if (!popup) return`), então o botão travava em
    // "Abrindo pagamento…" sem erro e sem saída além de recarregar.
    if (!popup) {
      mostrarToast('Não conseguimos abrir a janela de pagamento. Libere pop-ups para este site e tente de novo.', 'erro');
      botao.disabled = false;
      botao.textContent = textoOriginal;
      return;
    }

    iniciarPollingPopup(asaasCheckoutId, {
      aoConfirmar: () => {
        botao.textContent = 'Assinatura Ativa ✓';
        botao.classList.add('btn-success');
        mostrarToast('Assinatura criada com sucesso!', 'sucesso');
        ativarRetorno();
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
