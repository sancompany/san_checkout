/**
 * public/js/modules/pedidoHandler.js
 * Lê ?c=CONTRATANTE_ID&pedido=PEDIDO_ID da URL, chama nosso próprio
 * backend (que faz o pull na API do contratante — ver INTEGRACAO.md),
 * e preenche o resumo do pedido.
 */

import { get } from '../utils/api.js';
import { definirRetorno, montarRetornoNaQuery } from './retorno.js';

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
    /* `returnUrl` sobe CRU, como veio da barra de endereço, e quem
       decide é o backend: ele responde `retornoUrl` já aprovada, ou
       null. O front nunca recebe a lista de origens do contratante —
       validar aqui seria validar do lado que o atacante controla, e
       publicaria a lista de quebra (ver src/utils/retornoSeguro.js). */
    const resultado = await get(
      `/api/checkout/pedido/${ids.contratanteId}/${ids.pedidoId}${montarRetornoNaQuery()}`
    );
    contextoResolvido = { ...ids, ...resultado };
    definirRetorno(resultado.retornoUrl, resultado.contratanteNome);
    aplicarNoResumo(resultado);
    return ids;
  } catch (erro) {
    marcarPedidoIndisponivel(erro.message);
    return null;
  }
}

/**
 * Pedido que não carregou não vira tela de compra.
 *
 * Escrever o erro no título não bastava: o total ficava no placeholder
 * `0,00` do HTML e o painel de pagamento continuava inteiro na tela,
 * com o botão convidando a pagar. "R$ 0,00" com botão ativo é pior que
 * um erro visível — parece compra grátis, e o valor real não vem da
 * tela, vem do modelo pull no servidor. Gateway nenhum renderiza
 * checkout comprável sem total: a sessão falha.
 *
 * O pagamento já estava bloqueado por baixo (o `app.js` sai antes de
 * ligar os botões, e o clique cai no guarda `if (!ids)`), então isto
 * alinha o que a tela MOSTRA ao que o sistema FAZ.
 */
function marcarPedidoIndisponivel(mensagem) {
  const titulo = document.getElementById('order-title');
  if (titulo) titulo.textContent = mensagem || 'Não foi possível carregar o pedido.';

  // Travessão em vez de zero: valor desconhecido não é valor zero.
  const total = document.getElementById('order-amount');
  if (total) total.textContent = '—';
  for (const id of ['order-subtotal', 'order-desconto', 'order-taxa']) {
    const el = document.getElementById(id);
    if (el) el.textContent = '—';
  }

  document.querySelector('.checkout-panel--form')?.classList.add('hidden');
}

/* A LISTA DE PARCELAS É CORTADA PELO SERVIDOR.

   O provedor tem um piso de valor POR PARCELA, e o backend manda em
   `maxParcelas` quantas cabem neste pedido — o número do piso mora só lá
   (`utils/validadores.js`), e não é repetido aqui nem em comentário:
   número duplicado envelhece, e a suíte do piso recusa a duplicação de
   propósito.

   Sem cortar, o comprador de um pedido barato escolhe 12x nesta tela e a
   pop-up da Asaas abre oferecendo menos — duas telas discordando sobre a
   mesma compra, na hora de digitar o cartão.

   Só REMOVE opções, nunca acrescenta: o `<select>` do HTML é o teto (12,
   que é o limite da nossa própria regra), e o servidor só pode apertar.
   Se `maxParcelas` não vier — cliente antigo, resposta sem o campo — a
   lista fica como está e o comportamento é o de antes. */
function cortarParcelas(maxParcelas) {
  const seletor = document.getElementById('cartao-parcelas');
  const maximo = Number(maxParcelas);
  if (!seletor || !Number.isFinite(maximo) || maximo < 1) return;

  for (const opcao of [...seletor.options]) {
    if (Number(opcao.value) > maximo) opcao.remove();
  }
  // Se a seleção corrente foi removida, o navegador cai na primeira —
  // mas deixar explícito evita depender disso.
  if (!seletor.value) seletor.selectedIndex = 0;
}

function aplicarNoResumo({ contratanteNome, pedido, taxa, bloqueio, maxParcelas }) {
  /* BLOQUEIO DECIDIDO NO SERVIDOR.

     Quem sabe o piso da Asaas é o backend, e ele manda a frase pronta.
     Cair aqui derruba o carregamento inteiro pelo mesmo caminho do
     total indisponível: o `catch` de `resolverContexto` escreve a
     mensagem na tela, esconde o formulário e devolve `null`, e o
     `app.js` sai antes de ligar qualquer botão.

     A mensagem vem do servidor em vez de ser escrita aqui de propósito:
     duplicar o texto no front significa que um dia o piso muda num
     lugar só e a tela passa a mentir o número. */
  if (bloqueio?.mensagem) throw new Error(bloqueio.mensagem);

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

      /* Item sem preço mostra travessão, não "R$ 0,00".

         Este era o terceiro lugar da família dos dois bugs de total
         (`docs/pendencias.md`): `?? 0` transforma "não sei o preço" em
         "o preço é zero", e zero numa linha de item lê como brinde. O
         total continua sendo o do servidor — esta linha é só o detalhe
         —, então um item sem preço não derruba a tela; ele só para de
         afirmar um valor que ninguém informou. */
      const quantidade = Number(item.quantidade ?? 1);
      const unitario = Number(item.valorUnitario);
      const valorItem = Number.isFinite(unitario) ? quantidade * unitario : null;

      const label = document.createElement('span');
      label.className = 'order-item-label';
      const quantidadeEl = document.createElement('strong');
      quantidadeEl.textContent = `${quantidade}x `;
      label.appendChild(quantidadeEl);
      label.appendChild(document.createTextNode(item.nome ?? ''));

      const valor = document.createElement('span');
      valor.className = 'order-item-value';
      valor.textContent = valorItem === null ? '—' : `R$ ${formatarMoeda(valorItem)}`;

      linha.append(label, valor);
      lista.appendChild(linha);
    });
    lista.classList.remove('hidden');
  }

  const subtotal = Number(pedido.valorCheio ?? pedido.valorComDesconto ?? 0);
  const desconto = Number(pedido.desconto ?? 0);
  /* Nunca renderizar tela comprável sem total confiável.

     Se `valorCobrado` não vier utilizável, isto derruba o carregamento
     inteiro de propósito: o `catch` de `resolverContexto` escreve o erro
     na tela e devolve `null`, e com isso o `app.js` sai antes de ligar
     qualquer botão de pagamento. Quem clicar mesmo assim cai no guarda
     `if (!ids)` e recebe o aviso de recarregar.

     A alternativa preguiçosa seria `Number(… ?? 0)`, e ela é PIOR que o
     NaN que estava aqui: "R$ 0,00" parece compra grátis, o comprador
     confirma, e o servidor cobra outro valor — o valor real vem do
     modelo pull, nunca do que a tela mostrou. Exibir preço que não se
     sabe é o erro; NaN pelo menos era visivelmente quebrado. É por isso
     que gateway nenhum renderiza checkout com total indisponível: a
     sessão falha, não vira uma compra de valor desconhecido.

     `<= 0` entra junto porque o backend já recusa esse valor
     (`valorValido`: maior que zero e até 100.000) — total zerado ou
     negativo aqui significa resposta corrompida, não compra gratuita. */
  const total = Number(taxa?.valorCobrado);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('Não foi possível calcular o valor desta compra. Recarregue a página ou peça um link novo à loja.');
  }

  cortarParcelas(maxParcelas);

  const taxasTotais = Number(taxa.taxasTotais ?? 0);

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

/* ------------------------------------------------------------------
   A COTAÇÃO (C-02, 24/09/2026)

   O backend manda em `cotacao` o retrato do preço que ESTA tela vai
   mostrar — id, validade e os totais por método/parcelas — e o POST que
   cobra exige o id de volta. A tela nunca calcula preço: ela só escolhe,
   dentro dos totais que recebeu, qual mostrar para o método selecionado.
   Até aqui o total exibido era sempre o do Pix, e o cartão em 12x era
   cobrado com outra taxa — o pagador via um número e a pop-up cobrava
   outro.
------------------------------------------------------------------ */

let metodoExibido = 'pix';
let parcelasExibidas = 1;

/** O id que vai no POST. `null` quando a tela não tem cotação (pedido
 *  indisponível) — e aí o backend recusa, que é o comportamento certo. */
export function obterCotacaoId() {
  return contextoResolvido?.cotacao?.id ?? null;
}

/** Cotação nova vinda de um 409 `cotacao_alterada`: substitui a antiga e
 *  redesenha TUDO que depende do preço — subtotal, desconto, a lista de
 *  parcelas (o piso por parcela pode ter cortado opções) e o total do
 *  método que está na tela. Redesenhar só o total deixava o resumo
 *  contradizendo o número de baixo (achado na revisão de 24/09/2026). */
export function aplicarCotacao(cotacao) {
  if (!contextoResolvido || !cotacao?.id) return;
  contextoResolvido.cotacao = cotacao;
  if (cotacao.retrato && typeof cotacao.retrato === 'object') {
    contextoResolvido.pedido = { ...(contextoResolvido.pedido ?? {}), ...cotacao.retrato };
    const pedido = contextoResolvido.pedido;
    const subtotal = Number(pedido.valorCheio ?? pedido.valorComDesconto ?? 0);
    const desconto = Number(pedido.desconto ?? 0);
    const elSubtotal = document.getElementById('order-subtotal');
    if (elSubtotal) elSubtotal.textContent = `R$ ${formatarMoeda(subtotal)}`;
    const elDesconto = document.getElementById('order-desconto');
    if (elDesconto) elDesconto.textContent = desconto > 0 ? `- R$ ${formatarMoeda(desconto)}` : 'R$ 0,00';
    document.getElementById('breakdown-desconto-row')?.classList.toggle('tem-valor', desconto > 0);
  }
  cortarParcelas(cotacao.totais?.maxParcelas);
  const seletor = document.getElementById('cartao-parcelas');
  if (seletor && metodoExibido === 'cartao') parcelasExibidas = Number(seletor.value) || 1;
  atualizarTotalExibido(metodoExibido, parcelasExibidas);
}

/** Os botões que cobram. Sem total confiável na tela, nenhum deles
 *  pode ficar clicável — é a mesma regra do carregamento inicial
 *  (`aplicarNoResumo`), aplicada de novo depois de um 409. */
const BOTOES_QUE_COBRAM = ['btn-generate-pix', 'btn-continuar-cartao', 'btn-gerar-boleto'];
function travarBotoesQueCobram(travar) {
  for (const id of BOTOES_QUE_COBRAM) {
    const botao = document.getElementById(id);
    if (botao) botao.disabled = travar;
  }
}

/** Redesenha o total para o método (e parcelas) escolhidos, a partir dos
 *  totais da cotação. Sem total para a combinação → travessão, nunca zero. */
export function atualizarTotalExibido(metodo = metodoExibido, parcelas = parcelasExibidas) {
  metodoExibido = metodo;
  parcelasExibidas = Number(parcelas) || 1;
  const totais = contextoResolvido?.cotacao?.totais;
  if (!totais) return;

  const total = metodo === 'cartao'
    ? totais.cartao?.[parcelasExibidas] ?? null
    : totais[metodo] ?? null;

  const elTotal = document.getElementById('order-amount');
  const elTaxa = document.getElementById('order-taxa');
  const valor = Number(total?.valorCobrado);
  if (!Number.isFinite(valor) || valor <= 0) {
    if (elTotal) elTotal.textContent = '—';
    if (elTaxa) elTaxa.textContent = '—';
    travarBotoesQueCobram(true);
    return;
  }
  travarBotoesQueCobram(false);
  const taxas = Number(total.taxasTotais ?? 0);
  if (elTotal) elTotal.textContent = formatarMoeda(valor);
  if (elTaxa) elTaxa.textContent = taxas > 0 ? `+ R$ ${formatarMoeda(taxas)}` : 'R$ 0,00';

  const parcela = document.getElementById('order-parcela');
  if (parcela) {
    parcela.textContent = metodo === 'cartao' && parcelasExibidas > 1
      ? `${parcelasExibidas}x de R$ ${formatarMoeda(Number(total.valorParcela ?? valor / parcelasExibidas))}`
      : '';
  }
}

/** Dados do pagador, pré-preenchidos se o pedido já trouxe (opcional). */
export function obterPagadorPreenchido() {
  return contextoResolvido?.pedido?.pagador ?? null;
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
