/**
 * public/js/modules/assinaturaPixHandler.js
 *
 * Assinatura por PIX AUTOMÁTICO — recorrência sem cartão.
 *
 * Diferente da assinatura por cartão, aqui não existe pop-up: a gente
 * mostra um QR Code e o pagador lê no app do banco. Esse único ato paga
 * a primeira cobrança E autoriza os débitos seguintes (a "Jornada 3" da
 * Asaas). Por isso também não pede endereço — aquilo era exigência
 * antifraude do cartão.
 *
 * Enquanto a autorização não vira ACTIVE, nada foi cobrado. O polling
 * abaixo pergunta pro nosso backend, que sabe pelo webhook
 * PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED.
 *
 * ⚠️ NUNCA TESTADO AO VIVO — depende de a Asaas ter habilitado Pix
 * Automático na conta.
 */

import { post, get } from '../utils/api.js';
import { ativarRetorno } from './retorno.js';

const INTERVALO_POLLING_MS = 4000;
let idIntervalo = null;

export function pararPollingAssinaturaPix() {
  if (idIntervalo) {
    clearInterval(idIntervalo);
    idIntervalo = null;
  }
}

/**
 * @param {{ contratanteId, planoId, dadosPagador, mostrarToast }} contexto
 */
export async function assinarComPix({ contratanteId, planoId, dadosPagador, mostrarToast }) {
  const botao = document.getElementById('btn-assinar-pix');
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Gerando QR Code…';

  try {
    const { autorizacaoId, qrCodeBase64, copiaECola } = await post(
      `/api/checkout/assinatura-pix/${contratanteId}/${planoId}`,
      dadosPagador
    );

    if (!copiaECola) {
      throw new Error('A Asaas não devolveu o código Pix desta autorização.');
    }

    document.getElementById('assinatura-pix-qr').src = `data:image/png;base64,${qrCodeBase64}`;
    document.getElementById('assinatura-pix-codigo').value = copiaECola;
    document.getElementById('assinatura-pix-resultado').classList.remove('hidden');
    botao.classList.add('hidden'); // já gerou; o QR é a tela agora

    pararPollingAssinaturaPix();
    idIntervalo = setInterval(async () => {
      try {
        const { status } = await get(`/api/checkout/asaas-checkout/status/${autorizacaoId}`);
        if (status === 'CHECKOUT_PAID') {
          pararPollingAssinaturaPix();
          mostrarToast('Assinatura autorizada! A primeira cobrança foi paga.', 'sucesso');
          document.querySelector('#assinatura-pix-resultado .status-text').textContent =
            'Assinatura ativa — os próximos pagamentos serão automáticos.';
          ativarRetorno();
        }
      } catch {
        // falha pontual de rede não derruba o polling
      }
    }, INTERVALO_POLLING_MS);
  } catch (erro) {
    mostrarToast(erro.message || 'Não foi possível gerar a assinatura por Pix.', 'erro');
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}
