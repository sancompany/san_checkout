/**
 * public/js/modules/cartaoHandler.js
 *
 * Cartão avulso — cria a sessão DETACHED/INSTALLMENT no backend
 * (`POST /api/checkout/cartao/:contratanteId/:pedidoId`,
 * `asaasCheckoutController.criarCheckoutCartao`, API.md §6) e abre a
 * pop-up hospedada da Asaas.
 *
 * Fluxo: escolhe parcelas (tela nossa, sem dado de cartão) → backend
 * cria a sessão Asaas Checkout com o valor já calculado pra aquela
 * parcela → abrimos a pop-up → ficamos de olho no resultado fazendo
 * polling no NOSSO backend (que vai saber via webhook CHECKOUT_PAID/
 * CHECKOUT_CANCELED/CHECKOUT_EXPIRED), sem depender de postMessage
 * entre as janelas.
 */

import { post, get } from '../utils/api.js';
import { ativarRetorno } from './retorno.js';

const INTERVALO_POLLING_MS = 3000;
const INTERVALO_VERIFICA_POPUP_MS = 500;
const ESPERA_POS_FECHAMENTO_MS = 15000;
/** Quanto a tela acompanha um pagamento em processamento antes de parar
 *  e dizer que a confirmação chega depois (o contratante é avisado pelo
 *  webhook, não por esta tela). */
const TETO_ACOMPANHAMENTO_MS = 10 * 60 * 1000;
const TEXTO_PROCESSANDO = 'Pagamento em processamento…';
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

/**
 * `CHECKOUT_PAID` só chega aqui quando o DINHEIRO foi confirmado
 * (`statusDaSessaoParaTela`, no servidor). Sessão concluída sem
 * confirmação é `PROCESSANDO`: a pop-up já não serve para nada, mas a
 * tela NÃO diz "aprovado" — até 25/09/2026 dizia, e o primeiro pagamento
 * real de assinatura mostrou "Assinatura Ativa ✓" sem o cartão debitado.
 */
function iniciarPollingPopup(asaasCheckoutId, { aoConfirmar, aoFalhar, aoProcessar }) {
  pararPolling();
  const inicio = Date.now();
  let avisouProcessando = false;
  idIntervaloAtivo = setInterval(async () => {
    try {
      const { status } = await get(`/api/checkout/asaas-checkout/status/${encodeURIComponent(asaasCheckoutId)}`);
      if (status === 'CHECKOUT_PAID') { pararPolling(); aoConfirmar(); return; }
      if (status === 'CHECKOUT_CANCELED' || status === 'CHECKOUT_EXPIRED' || status === 'PAGAMENTO_RECUSADO') { pararPolling(); aoFalhar(status); return; }
      if (status === 'PROCESSANDO') {
        if (!avisouProcessando) { avisouProcessando = true; aoProcessar?.({ esgotou: false }); }
        if (Date.now() - inicio > TETO_ACOMPANHAMENTO_MS) { pararPolling(); aoProcessar?.({ esgotou: true }); }
      }
    } catch {
      // falha pontual de rede não derruba o polling
    }
  }, INTERVALO_POLLING_MS);
}

/** O estado "processando", igual para quem acabou de fechar a pop-up e
 *  para quem voltou à página depois de já ter concluído. */
function mostrarProcessando(botao, popup, mostrarToast, { esgotou }) {
  if (popup && !popup.closed) popup.close();
  botao.disabled = true;
  botao.textContent = TEXTO_PROCESSANDO;
  if (esgotou) {
    mostrarToast('Seu pagamento foi enviado e ainda está em processamento. A confirmação chega assim que a operadora aprovar — não é preciso pagar de novo.', 'info');
  } else {
    mostrarToast('Recebemos seu pagamento e estamos aguardando a confirmação da operadora. Não é preciso pagar de novo.', 'info');
  }
}

/**
 * @param {{ contratanteId, pedidoId, parcelas, dadosPagador, mostrarToast }} contexto
 */
export async function continuarComCartao({ contratanteId, pedidoId, parcelas, dadosPagador, mostrarToast, aoNaoConcluir }) {
  const botao = document.getElementById('btn-continuar-cartao');
  const textoOriginal = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Abrindo pagamento…';

  /* Acompanha a sessão — a que acabou de abrir, ou a que o pagador já
     concluiu antes (409 `pagamento_em_processamento`). */
  function acompanhar(asaasCheckoutId, popup) {
    iniciarPollingPopup(asaasCheckoutId, {
      aoConfirmar: () => {
        // A pop-up é da Asaas, não nossa — fechar ela é o que dá pro
        // comprador VER o "Pagamento Aprovado" e a contagem de volta
        // pra loja (`ativarRetorno`, na janela principal) em vez de
        // ficarem escondidos atrás de uma janela que não faz mais
        // nada. Mesma checagem de `observarFechamentoPopup`: a pop-up
        // pode já estar fechada (o pagador fechou sozinho) quando o
        // polling confirma.
        if (popup && !popup.closed) popup.close();
        botao.textContent = 'Pagamento Aprovado ✓';
        botao.classList.add('btn-success');
        mostrarToast('Pagamento aprovado!', 'sucesso');
        ativarRetorno();
      },
      aoFalhar: (status) => {
        mostrarToast(`O pagamento não foi concluído (${status}).`, 'erro');
        botao.disabled = false;
        botao.textContent = textoOriginal;
        // Recusa/cancelamento sem caminho alternativo é venda perdida —
        // quem orquestra (app.js) oferece o Pix aqui.
        if (typeof aoNaoConcluir === 'function') aoNaoConcluir(status);
      },
      aoProcessar: (estado) => mostrarProcessando(botao, popup, mostrarToast, estado)
    });
  }

  try {
    const { checkoutUrl, asaasCheckoutId } = await post(
      `/api/checkout/cartao/${encodeURIComponent(contratanteId)}/${encodeURIComponent(pedidoId)}`,
      { ...dadosPagador, parcelas: Number(parcelas) }
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

    acompanhar(asaasCheckoutId, popup);

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
    // Já concluído antes (voltou à página, clicou de novo): acompanha a
    // sessão que existe em vez de abrir uma segunda cobrança.
    if (erro.corpo?.codigo === 'pagamento_em_processamento' && erro.corpo.asaasCheckoutId) {
      mostrarProcessando(botao, null, mostrarToast, { esgotou: false });
      acompanhar(erro.corpo.asaasCheckoutId, null);
      return;
    }
    if (!erro.tratadoPelaTela) mostrarToast(erro.message || 'Não foi possível iniciar o pagamento por cartão.', 'erro');
    botao.disabled = false;
    botao.textContent = textoOriginal;
  }
}

export { pararPolling as pararPollingCartao };
