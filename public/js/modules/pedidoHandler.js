/**
 * public/js/modules/pedidoHandler.js
 * Lê ?c=CONTRATANTE_ID&pedido=PEDIDO_ID da URL, chama nosso próprio
 * backend (que faz o pull na API do contratante — ver INTEGRACAO.md),
 * e preenche o resumo do pedido.
 */

import { get } from '../utils/api.js';

let contextoResolvido = null;

const ROTULOS_TIPO = {
  mensalidade: 'Mensalidade',
  assinatura: 'Assinatura',
  compra_unica: 'Compra Única'
};

function formatarMoeda(valor) {
  return Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** @returns {{ contratanteId, pedidoId } | null} */
function lerIdsDaUrl() {
  const parametros = new URLSearchParams(window.location.search);
  const contratanteId = parametros.get('c');
  const pedidoId = parametros.get('pedido');
  if (!contratanteId || !pedidoId) return null;
  return { contratanteId, pedidoId };
}

/**
 * Resolve o pedido e preenche a tela. Retorna os ids (precisam ser
 * reenviados na hora de pagar) ou null se a URL não tiver os parâmetros.
 */
export async function resolverContexto() {
  const ids = lerIdsDaUrl();
  if (!ids) return null;

  try {
    const resultado = await get(`/api/checkout/pedido/${ids.contratanteId}/${ids.pedidoId}`);
    contextoResolvido = { ...ids, ...resultado };
    aplicarNoResumo(resultado);
    return ids;
  } catch (erro) {
    document.getElementById('order-title').textContent = erro.message || 'Não foi possível carregar o pedido.';
    return null;
  }
}

function aplicarNoResumo({ contratanteNome, pedido, taxa }) {
  document.getElementById('order-category').textContent = ROTULOS_TIPO[pedido.tipo] ?? contratanteNome ?? 'Produto / Serviço';
  document.getElementById('order-title').textContent = pedido.descricao ?? 'Pedido';

  // Lista de itens — rolável, pra não quebrar o layout quando o
  // pedido tiver muitos produtos (um pedido de item único não mostra
  // essa lista, só o título já basta).
  if (Array.isArray(pedido.itens) && pedido.itens.length > 0) {
    const lista = document.getElementById('order-items-list');
    lista.innerHTML = '';
    pedido.itens.forEach((item) => {
      const linha = document.createElement('div');
      linha.className = 'order-item-row';

      const quantidade = Number(item.quantidade ?? 1);
      const valorItem = quantidade * Number(item.valorUnitario ?? 0);

      const label = document.createElement('span');
      label.className = 'order-item-label';
      const quantidadeEl = document.createElement('strong');
      quantidadeEl.textContent = `${quantidade}x `;
      label.appendChild(quantidadeEl);
      label.appendChild(document.createTextNode(item.nome ?? ''));

      const valor = document.createElement('span');
      valor.className = 'order-item-value';
      valor.textContent = `R$ ${formatarMoeda(valorItem)}`;

      linha.append(label, valor);
      lista.appendChild(linha);
    });
    lista.classList.remove('hidden');
  }

  const subtotal = Number(pedido.valorCheio ?? pedido.valorComDesconto ?? 0);
  const desconto = Number(pedido.desconto ?? 0);
  const taxasTotais = Number(taxa.taxasTotais ?? 0);
  const total = taxa.valorCobrado;

  document.getElementById('order-subtotal').textContent = `R$ ${formatarMoeda(subtotal)}`;
  document.getElementById('order-amount').textContent = formatarMoeda(total);

  // Desconto e Taxa ficam SEMPRE visíveis — mostram R$ 0,00 quando não
  // há valor, em vez de sumir da tela.
  const linhaDesconto = document.getElementById('breakdown-desconto-row');
  document.getElementById('order-desconto').textContent = desconto > 0
    ? `- R$ ${formatarMoeda(desconto)}`
    : 'R$ 0,00';
  linhaDesconto.classList.toggle('tem-valor', desconto > 0);

  // Taxa é sempre UMA linha só (taxasTotais) — nunca mostra separado o
  // quanto é da Asaas e o quanto é próprio do San Checkout.
  document.getElementById('order-taxa').textContent = taxasTotais > 0
    ? `+ R$ ${formatarMoeda(taxasTotais)}`
    : 'R$ 0,00';

  if (pedido.contratanteLogoUrl) {
    const logo = document.getElementById('contratante-logo');
    logo.src = pedido.contratanteLogoUrl;
    logo.alt = `Logo de ${contratanteNome ?? ''}`;
    logo.classList.remove('hidden');
    document.getElementById('brand-logos-row').classList.add('brand-logos-row--dual');
  }

  if (pedido.bannerUrl) {
    const bannerImg = document.getElementById('ad-banner-image');
    bannerImg.src = pedido.bannerUrl;
    bannerImg.alt = pedido.descricao ? `Anúncio: ${pedido.descricao}` : 'Anúncio';
    document.getElementById('ad-banner-wrapper').classList.remove('hidden');
  }
}

/** Dados do pagador, pré-preenchidos se o pedido já trouxe (opcional). */
export function obterPagadorPreenchido() {
  return contextoResolvido?.pedido?.pagador ?? null;
}

export function obterIdsResolvidos() {
  if (!contextoResolvido) return null;
  return { contratanteId: contextoResolvido.contratanteId, pedidoId: contextoResolvido.pedidoId };
}

/** O pedido cru, como veio do contratante — usado pra decidir, por
 *  exemplo, se o Boleto deve aparecer (só quando não tem expiraEm). */
export function obterPedidoResolvido() {
  return contextoResolvido?.pedido ?? null;
}

/** Lista de métodos que esse contratante pode cobrar — null = sem
 *  restrição (contratante antigo, cadastrado antes da migração v3). */
export function obterMetodosHabilitados() {
  return contextoResolvido?.metodosHabilitados ?? null;
}

/* ------------------------------------------------------------------
   Cronômetro de expiração
------------------------------------------------------------------ */

let intervaloTimer = null;

function formatarRestante(milissegundos) {
  const total = Math.max(0, Math.floor(milissegundos / 1000));
  const horas = Math.floor(total / 3600);
  const minutos = Math.floor((total % 3600) / 60);
  const segundos = total % 60;
  const dois = (n) => String(n).padStart(2, '0');
  return horas > 0
    ? `${dois(horas)}:${dois(minutos)}:${dois(segundos)}`
    : `${dois(minutos)}:${dois(segundos)}`;
}

/**
 * Mostra quanto falta pro pedido expirar. O prazo vem do `expiraEm` que
 * o contratante mandou — é uma reserva de verdade (ingresso segurado,
 * preço travado), não contador de escassez inventado. Se o pedido não
 * tiver `expiraEm`, nada aparece.
 *
 * O backend continua sendo quem decide de fato: `resolverPedido` já
 * recusa pedido expirado na hora de cobrar. Isto aqui é só o aviso
 * visual — por isso zerar o contador não "trava" nada sozinho, só
 * avisa e desabilita os botões de pagar.
 *
 * @param {Function} aoExpirar — chamado uma vez quando chega a zero
 */
export function iniciarCronometroExpiracao(aoExpirar) {
  const pedido = contextoResolvido?.pedido;
  const elemento = document.getElementById('order-timer');
  if (!elemento || !pedido?.expiraEm) return;

  const expiraEm = new Date(pedido.expiraEm).getTime();
  if (Number.isNaN(expiraEm)) return; // data inválida do contratante — não inventa contador

  const valor = document.getElementById('order-timer-valor');
  const texto = document.getElementById('order-timer-texto');
  elemento.classList.remove('hidden');

  const tique = () => {
    const restante = expiraEm - Date.now();

    if (restante <= 0) {
      clearInterval(intervaloTimer);
      intervaloTimer = null;
      elemento.classList.add('order-timer--urgente');
      texto.textContent = 'Esta reserva expirou.';
      if (typeof aoExpirar === 'function') aoExpirar();
      return;
    }

    valor.textContent = formatarRestante(restante);
    // Últimos 5 minutos viram alerta visual.
    elemento.classList.toggle('order-timer--urgente', restante <= 5 * 60 * 1000);
  };

  tique();
  intervaloTimer = setInterval(tique, 1000);
}
