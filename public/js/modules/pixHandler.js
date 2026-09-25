import { post, get } from '../utils/api.js';
import { ativarRetorno } from './retorno.js';

const INTERVALO_POLLING_MS = 3000;
const STATUS_CONFIRMADOS = ['CONFIRMED', 'RECEIVED'];
const STATUS_FALHOS = ['OVERDUE', 'REFUNDED', 'CANCELLED'];

export function avaliarStatusPix(status) {
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
      const { status } = await get(`/api/checkout/pix/status/${encodeURIComponent(chargeId)}`);
      const resultado = avaliarStatusPix(status);
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
export async function gerarPix({ contratanteId, pedidoId, dadosPagador, mostrarToast }) {
  const btnGerar = document.getElementById('btn-generate-pix');
  const estadoAcao = document.getElementById('pix-action-state');
  const estadoResultado = document.getElementById('pix-result-state');
  const imagemQr = document.getElementById('pix-qr-image');
  const loaderQr = document.getElementById('pix-loader');
  const campoCopiaECola = document.getElementById('pix-copy-code');
  const mensagemStatus = document.getElementById('pix-status-message');

  btnGerar.disabled = true;

  try {
    const { qrCodeBase64, copiaECola, chargeId } = await post(
      `/api/checkout/pix/${encodeURIComponent(contratanteId)}/${encodeURIComponent(pedidoId)}`,
      dadosPagador
    );

    estadoAcao.classList.add('hidden');
    estadoResultado.classList.remove('hidden');

    loaderQr.style.display = 'block';
    imagemQr.src = `data:image/png;base64,${qrCodeBase64}`;
    imagemQr.onload = () => { loaderQr.style.display = 'none'; };

    campoCopiaECola.value = copiaECola;

    iniciarPolling(chargeId, {
      aoConfirmar: () => {
        mensagemStatus.textContent = 'Pagamento confirmado! Obrigado.';
        mensagemStatus.closest('.pix-status-tracker')?.querySelector('.status-pulse')
          ?.style.setProperty('background-color', 'var(--status-success)');
        mostrarToast('Pagamento confirmado com sucesso.', 'sucesso');
        ativarRetorno();
      },
      aoFalhar: (status) => {
        mensagemStatus.textContent = 'Este Pix não foi mais processado — gere um novo código.';
        mostrarToast(`O pagamento não foi concluído (${status}).`, 'erro');
      }
    });
  } catch (erro) {
    if (!erro.tratadoPelaTela) mostrarToast(erro.message || 'Não foi possível gerar o Pix agora.', 'erro');
    /* O Pix JÁ EXISTE (`qr_indisponivel`) ou uma tentativa anterior está
       sendo conferida (`cobranca_em_confirmacao`): clicar de novo busca
       o MESMO Pix — o botão diz isso em vez de parecer um erro sem saída
       (primeiro Pix real, 25/09/2026). */
    if (['qr_indisponivel', 'cobranca_em_confirmacao'].includes(erro.corpo?.codigo)) btnGerar.textContent = 'Tentar de novo';
    btnGerar.disabled = false;
  }
}

export async function copiarCodigoPix() {
  const campo = document.getElementById('pix-copy-code');
  const botao = document.getElementById('btn-copy-pix');
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
