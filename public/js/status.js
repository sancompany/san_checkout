/**
 * public/js/status.js
 * Página de status do pagamento — `status.html?c=CONTRATANTE&pedido=ID`.
 *
 * Resolve o problema mais barato e mais comum do suporte: Pix e boleto
 * são assíncronos, a pessoa fecha a aba e o QR some. Antes disso existir,
 * o único caminho era ela ligar pro contratante, que ligava pro
 * operador. Agora ela reabre o próprio link.
 *
 * Não cria cobrança nenhuma — só lê a que já existe
 * (`GET /api/checkout/status/...`). Se a cobrança já foi paga ou
 * encerrou, mostra isso e não oferece pagamento.
 */

import { get } from './utils/api.js';

const $ = (id) => document.getElementById(id);

function mostrarToast(mensagem, tipo = 'info') {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = mensagem;
  if (tipo === 'erro') toast.style.borderColor = 'var(--status-error)';
  if (tipo === 'sucesso') toast.style.borderColor = 'var(--status-success)';
  $('toast-container').appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

function formatarMoeda(valor) {
  return Number(valor ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const NOME_METODO = {
  pix: 'Pix',
  boleto: 'Boleto',
  cartao_credito: 'Cartão de crédito',
  assinatura: 'Assinatura'
};

/**
 * Como cada status se apresenta pro comprador. O texto é escrito pra
 * alguém que não sabe o que é "estorno solicitado" nem "em análise" —
 * diz o que aconteceu e o que ele deve fazer, nessa ordem.
 */
const APRESENTACAO = {
  pendente: {
    selo: 'Aguardando pagamento', classe: 'aguardando',
    titulo: 'Seu pagamento está aguardando',
    texto: 'Assim que o pagamento for identificado, esta página atualiza sozinha.'
  },
  em_analise: {
    selo: 'Em análise', classe: 'aguardando',
    titulo: 'Pagamento em análise',
    texto: 'Recebemos seu pagamento e ele está passando por uma verificação de segurança. Isso costuma levar poucos minutos.'
  },
  confirmado: {
    selo: 'Pago', classe: 'pago',
    titulo: 'Pagamento confirmado',
    texto: 'Recebemos seu pagamento. A loja já foi avisada.'
  },
  recusado: {
    selo: 'Recusado', classe: 'encerrado',
    titulo: 'Pagamento recusado',
    texto: 'O pagamento não foi aprovado. Volte à loja para tentar novamente, se quiser.'
  },
  vencido: {
    selo: 'Vencido', classe: 'encerrado',
    titulo: 'Esta cobrança venceu',
    texto: 'O prazo de pagamento passou. Volte à loja para gerar uma nova cobrança.'
  },
  cancelado: {
    selo: 'Cancelado', classe: 'encerrado',
    titulo: 'Cobrança cancelada',
    texto: 'Esta cobrança foi cancelada.'
  },
  expirado: {
    selo: 'Expirado', classe: 'encerrado',
    titulo: 'Esta cobrança expirou',
    texto: 'Volte à loja para gerar uma nova.'
  },
  estornado: {
    selo: 'Estornado', classe: 'encerrado',
    titulo: 'Pagamento estornado',
    texto: 'O valor foi devolvido. Dependendo do banco, pode levar alguns dias para aparecer.'
  },
  estorno_solicitado: {
    selo: 'Estorno em andamento', classe: 'aguardando',
    titulo: 'Estorno em andamento',
    texto: 'A devolução foi iniciada e ainda está sendo processada.'
  },
  estorno_negado: {
    selo: 'Estorno negado', classe: 'encerrado',
    titulo: 'O estorno não foi aprovado',
    texto: 'O pagamento continua válido. Fale com a loja se precisar de ajuda.'
  },
  chargeback: {
    selo: 'Em contestação', classe: 'encerrado',
    titulo: 'Pagamento em contestação',
    texto: 'Existe uma contestação aberta no banco emissor para esta compra.'
  }
};

/** Status desconhecido não pode quebrar a tela — mesma regra que
 *  pedimos ao contratante no API.md §10 (compatibilidade). */
function apresentar(status) {
  return APRESENTACAO[status] ?? {
    selo: 'Em processamento', classe: 'neutro',
    titulo: 'Pagamento em processamento',
    texto: 'Esta página atualiza sozinha assim que houver novidade.'
  };
}

function lerParametros() {
  const p = new URLSearchParams(window.location.search);
  const contratanteId = p.get('c');
  const pedidoId = p.get('pedido');
  if (!contratanteId || !pedidoId) return null;
  return { contratanteId, pedidoId };
}

function mostrarErro(titulo, texto) {
  $('bloco-carregando').classList.add('hidden');
  $('bloco-resultado').classList.add('hidden');
  $('erro-titulo').textContent = titulo;
  $('erro-texto').textContent = texto;
  $('bloco-erro').classList.remove('hidden');
}

function ligarCopiar(idBotao, idCampo, rotulo) {
  $(idBotao).addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($(idCampo).value);
      mostrarToast(`${rotulo} copiado.`, 'sucesso');
    } catch {
      // Alguns navegadores bloqueiam a área de transferência — selecionar
      // o campo deixa a pessoa copiar na mão, em vez de só falhar.
      $(idCampo).select();
      mostrarToast('Não consegui copiar: o texto está selecionado, use Ctrl+C.', 'erro');
    }
  });
}

function renderizar(dados) {
  const visual = apresentar(dados.status);

  $('selo-status').textContent = visual.selo;
  $('selo-status').className = `status-selo status-selo--${visual.classe}`;
  $('titulo-status').textContent = visual.titulo;
  $('texto-status').textContent = visual.texto;

  $('resumo-valor').textContent = `R$ ${formatarMoeda(dados.valorCobrado)}`;
  $('resumo-metodo').textContent = NOME_METODO[dados.metodoPagamento] ?? dados.metodoPagamento ?? '—';

  const pagamento = dados.pagamento;

  if (pagamento?.copiaECola) {
    $('pix-qr-image').src = `data:image/png;base64,${pagamento.qrCodeBase64}`;
    $('pix-copy-code').value = pagamento.copiaECola;
    $('pagamento-pix').classList.remove('hidden');
  }

  if (pagamento?.linhaDigitavel || pagamento?.boletoUrl) {
    if (pagamento.linhaDigitavel) $('boleto-copy-code').value = pagamento.linhaDigitavel;
    if (pagamento.boletoUrl) $('boleto-abrir').href = pagamento.boletoUrl;
    if (pagamento.vencimento) {
      const [ano, mes, dia] = String(pagamento.vencimento).split('-');
      $('boleto-vencimento').textContent = `Vence em ${dia}/${mes}/${ano}`;
      $('boleto-vencimento').classList.remove('hidden');
    }
    $('pagamento-boleto').classList.remove('hidden');
  }

  $('status-rodape').textContent = pagamento
    ? 'Guarde este link: ele mostra o pagamento atualizado e permite pagar de novo enquanto a cobrança estiver válida.'
    : 'Guarde este link para consultar o pagamento quando quiser.';

  $('bloco-carregando').classList.add('hidden');
  $('bloco-erro').classList.add('hidden');
  $('bloco-resultado').classList.remove('hidden');
}

/** Enquanto estiver aguardando, reconsulta sozinho — a pessoa paga o
 *  Pix no app do banco e vê a tela virar "Pago" sem recarregar nada. */
const INTERVALO_ATUALIZACAO_MS = 10000;
const AGUARDANDO = ['pendente', 'em_analise'];
let temporizador = null;

async function consultar(ids, { primeiraVez = false } = {}) {
  try {
    const dados = await get(`/api/checkout/status/${ids.contratanteId}/${ids.pedidoId}`);
    renderizar(dados);

    if (AGUARDANDO.includes(dados.status)) {
      if (!temporizador) temporizador = setInterval(() => consultar(ids), INTERVALO_ATUALIZACAO_MS);
    } else if (temporizador) {
      clearInterval(temporizador);
      temporizador = null;
      if (dados.status === 'confirmado') mostrarToast('Pagamento confirmado!', 'sucesso');
    }
  } catch (erro) {
    // Falha numa reconsulta em segundo plano não pode apagar a tela que
    // já está boa — só a primeira carga vira mensagem de erro.
    if (!primeiraVez) return;
    if (erro.status === 404) {
      mostrarErro('Pagamento não encontrado', 'Nenhuma cobrança foi gerada para este pedido ainda. Se você acabou de pagar, aguarde alguns instantes e recarregue.');
      return;
    }
    mostrarErro('Não foi possível consultar', 'Tente recarregar a página em alguns instantes.');
  }
}

function iniciar() {
  const ids = lerParametros();
  if (!ids) {
    mostrarErro('Link incompleto', 'Este link não identifica um pedido. Abra o link completo que a loja enviou.');
    return;
  }

  ligarCopiar('btn-copy-pix', 'pix-copy-code', 'Código Pix');
  ligarCopiar('btn-copy-boleto', 'boleto-copy-code', 'Linha digitável');

  consultar(ids, { primeiraVez: true });
}

iniciar();
