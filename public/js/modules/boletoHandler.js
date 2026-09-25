/**
 * public/js/modules/boletoHandler.js
 *
 * Cobrança direta (sem pop-up) — mesmo padrão do pixHandler.js. O
 * Boleto passou a usar `POST /api/checkout/boleto/...` (cobrança
 * direta na Asaas) em vez do Asaas Checkout: confirmado em sandbox
 * que o Asaas Checkout só aceita CREDIT_CARD/PIX, não BOLETO.
 */

import { post, get } from '../utils/api.js';
import { ativarRetorno } from './retorno.js';

const INTERVALO_POLLING_MS = 3000;
const STATUS_CONFIRMADOS = ['CONFIRMED', 'RECEIVED'];
const STATUS_FALHOS = ['OVERDUE', 'REFUNDED', 'CANCELLED'];

function avaliarStatusBoleto(status) {
  if (STATUS_CONFIRMADOS.includes(status)) return 'sucesso';
  if (STATUS_FALHOS.includes(status)) return 'falha';
  return 'continuar';
}

let idIntervaloAtivo = null;

export function pararPolling() {
  if (idIntervaloAtivo) {
    clearInterval(idIntervaloAtivo);
    idIntervaloAtivo = null;
  }
}

function iniciarPolling(chargeId, { aoConfirmar, aoFalhar }) {
  pararPolling();
  idIntervaloAtivo = setInterval(async () => {
    try {
      const { status } = await get(`/api/checkout/boleto/status/${encodeURIComponent(chargeId)}`);
      const resultado = avaliarStatusBoleto(status);
      if (resultado === 'sucesso') { pararPolling(); aoConfirmar(); }
      else if (resultado === 'falha') { pararPolling(); aoFalhar(status); }
    } catch {
      // falha pontual de rede não derruba o polling
    }
  }, INTERVALO_POLLING_MS);
}

/**
 * @param {{ contratanteId, pedidoId, dadosPagador, mostrarToast }} contexto
 */
export async function gerarBoleto({ contratanteId, pedidoId, dadosPagador, mostrarToast }) {
  const botao = document.getElementById('btn-gerar-boleto');
  const estadoAcao = document.getElementById('boleto-action-state');
  const estadoResultado = document.getElementById('boleto-result-state');
  const linkBoleto = document.getElementById('boleto-link');
  const campoLinhaDigitavel = document.getElementById('boleto-copy-code');
  const grupoLinhaDigitavel = document.getElementById('boleto-linha-digitavel-group');
  const mensagemStatus = document.getElementById('boleto-status-message');

  botao.disabled = true;

  try {
    const { chargeId, boletoUrl, linhaDigitavel } = await post(
      `/api/checkout/boleto/${encodeURIComponent(contratanteId)}/${encodeURIComponent(pedidoId)}`,
      dadosPagador
    );

    estadoAcao.classList.add('hidden');
    estadoResultado.classList.remove('hidden');

    if (boletoUrl) {
      linkBoleto.href = boletoUrl;
    } else {
      linkBoleto.classList.add('hidden');
    }

    if (linhaDigitavel) {
      campoLinhaDigitavel.value = linhaDigitavel;
    } else {
      grupoLinhaDigitavel.classList.add('hidden');
    }

    iniciarPolling(chargeId, {
      aoConfirmar: () => {
        mensagemStatus.textContent = 'Pagamento confirmado! Obrigado.';
        mensagemStatus.closest('.pix-status-tracker')?.querySelector('.status-pulse')
          ?.style.setProperty('background-color', 'var(--status-success)');
        mostrarToast('Pagamento confirmado com sucesso.', 'sucesso');
        ativarRetorno();
      },
      aoFalhar: (status) => {
        mensagemStatus.textContent = 'Este boleto não foi mais processado — gere um novo.';
        mostrarToast(`O pagamento não foi concluído (${status}).`, 'erro');
      }
    });
  } catch (erro) {
    if (!erro.tratadoPelaTela) mostrarToast(erro.message || 'Não foi possível gerar o boleto agora.', 'erro');
    botao.disabled = false;
  }
}

export async function copiarCodigoBoleto() {
  const campo = document.getElementById('boleto-copy-code');
  const botao = document.getElementById('btn-copy-boleto');
  if (!campo?.value) return;

  try {
    await navigator.clipboard.writeText(campo.value);
  } catch {
    campo.select();
    document.execCommand('copy');
  }

  const textoOriginal = botao.textContent;
  botao.textContent = 'Copiado!';
  botao.disabled = true;
  setTimeout(() => {
    botao.textContent = textoOriginal;
    botao.disabled = false;
  }, 1800);
}

export { pararPolling as pararPollingBoleto };
