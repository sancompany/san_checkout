import { resolverContexto, obterPagadorPreenchido, obterPedidoResolvido } from './modules/pedidoHandler.js';
import { resolverAssinatura, obterIdsAssinaturaResolvidos, obterPagadorPreenchidoAssinatura, rotularCiclo } from './modules/assinaturaHandler.js';
import { gerarPix, copiarCodigoPix, pararPolling as pararPollingPix } from './modules/pixHandler.js';
import { continuarComCartao, pararPollingCartao } from './modules/cartaoHandler.js';
import { gerarBoleto, copiarCodigoBoleto, pararPollingBoleto } from './modules/boletoHandler.js';
import { assinarAgora } from './modules/assinaturaCheckoutHandler.js';
import { mascararCpf, mascararTelefone, mascararCep } from './utils/masks.js';
import { validarCpf, validarEmail, validarObrigatorio, validarTelefone, validarCep } from './utils/validators.js';
import { buscarEnderecoPorCep } from './utils/cep.js';

function mostrarToast(mensagem, tipo = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = mensagem;
  if (tipo === 'erro') toast.style.borderColor = 'var(--status-error)';
  if (tipo === 'sucesso') toast.style.borderColor = 'var(--status-success)';
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

function formatarMoeda(valor) {
  return Number(valor ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Atalho escondido pra tela de admin (`admin.html`) — digitar o e-mail
 * admin@sancocore.com.br no campo de e-mail do checkout público
 * redireciona direto pra lá, sem link nenhum visível na página. Só
 * esconde o CAMINHO — a tela em si ainda exige a CHECKOUT_ADMIN_KEY
 * pra fazer qualquer coisa (ver `adminController.js`).
 */
function ligarAtalhoAdmin() {
  const EMAIL_ADMIN = 'admin@sancocore.com.br';
  const campo = document.getElementById('customer-email');
  if (!campo) return;
  campo.addEventListener('input', () => {
    if (campo.value.trim().toLowerCase() === EMAIL_ADMIN) window.location.href = 'admin.html';
  });
}

function preencherCamposPagador(pagador) {
  if (pagador?.nome) document.getElementById('customer-name').value = pagador.nome;
  if (pagador?.email) document.getElementById('customer-email').value = pagador.email;
  if (pagador?.cpf) document.getElementById('customer-cpf').value = mascararCpf(pagador.cpf);
  if (pagador?.telefone) document.getElementById('customer-phone').value = mascararTelefone(pagador.telefone);
}

function coletarDadosPagador() {
  return {
    nome: document.getElementById('customer-name').value.trim(),
    email: document.getElementById('customer-email').value.trim(),
    cpf: document.getElementById('customer-cpf').value.replace(/\D/g, ''),
    telefone: document.getElementById('customer-phone').value.replace(/\D/g, '')
  };
}

/**
 * Endereço de cobrança — só existe/é exigido pra Cartão e Assinatura
 * (antifraude da Asaas, confirmado em sandbox). `cidadeIbge` é o
 * código IBGE numérico devolvido pelo ViaCEP a partir do CEP — é o
 * que o campo `city` da Asaas realmente espera (ver utils/cep.js).
 */
function coletarEndereco() {
  return {
    endereco: document.getElementById('address-street').value.trim(),
    enderecoNumero: document.getElementById('address-number').value.trim(),
    complemento: document.getElementById('address-complement').value.trim(),
    bairro: document.getElementById('address-province').value.trim(),
    cep: document.getElementById('address-cep').value.replace(/\D/g, ''),
    cidade: document.getElementById('address-city').value.trim(),
    uf: document.getElementById('address-uf').value.trim(),
    cidadeIbge: document.getElementById('address-ibge').value.trim()
  };
}

function marcarErro(idCampo, mensagem) {
  const campo = document.getElementById(idCampo);
  const erro = document.getElementById(`error-${idCampo}`);
  if (!campo) return true;
  if (mensagem) {
    campo.classList.add('input-error');
    if (erro) { erro.textContent = mensagem; erro.classList.add('active'); }
    return false;
  }
  campo.classList.remove('input-error');
  if (erro) { erro.textContent = ''; erro.classList.remove('active'); }
  return true;
}

function validarDadosPagador() {
  const dados = coletarDadosPagador();
  let valido = true;

  if (!marcarErro('customer-name', validarObrigatorio(dados.nome) ? null : 'Informe seu nome completo.')) valido = false;
  if (!marcarErro('customer-email', validarEmail(dados.email) ? null : 'Informe um e-mail válido.')) valido = false;
  if (!marcarErro('customer-cpf', validarCpf(dados.cpf) ? null : 'CPF inválido.')) valido = false;
  if (!marcarErro('customer-phone', validarTelefone(dados.telefone) ? null : 'Informe um telefone válido, com DDD.')) valido = false;

  return valido;
}

/** Só chamada pra Cartão/Assinatura — o campo `#endereco-fieldset`
 *  fica escondido (e portanto não validado/enviado) nos outros métodos. */
function validarEndereco() {
  const dados = coletarEndereco();
  let valido = true;

  if (!marcarErro('address-cep', validarCep(dados.cep)
    ? (dados.cidadeIbge ? null : 'CEP não encontrado — verifique e tente novamente.')
    : 'CEP inválido.')) valido = false;
  if (!marcarErro('address-street', validarObrigatorio(dados.endereco) ? null : 'Informe o endereço.')) valido = false;
  if (!marcarErro('address-number', validarObrigatorio(dados.enderecoNumero) ? null : 'Informe o número.')) valido = false;
  if (!marcarErro('address-province', validarObrigatorio(dados.bairro) ? null : 'Informe o bairro.')) valido = false;

  return valido;
}

/** Autocompleta rua/bairro/cidade/UF/IBGE a partir do CEP (ViaCEP) —
 *  ver utils/cep.js pra por que isso não é só conveniência de UX. */
function ligarBuscaCep() {
  const campoCep = document.getElementById('address-cep');
  if (!campoCep) return;

  campoCep.addEventListener('blur', async () => {
    if (!validarCep(campoCep.value)) return;

    const endereco = await buscarEnderecoPorCep(campoCep.value);
    if (!endereco) {
      document.getElementById('address-ibge').value = '';
      marcarErro('address-cep', 'CEP não encontrado — verifique e tente novamente.');
      return;
    }

    document.getElementById('address-street').value = endereco.logradouro;
    document.getElementById('address-province').value = endereco.bairro;
    document.getElementById('address-city').value = endereco.cidade;
    document.getElementById('address-uf').value = endereco.uf;
    document.getElementById('address-ibge').value = endereco.ibge;
    marcarErro('address-cep', null);
    if (!endereco.logradouro) document.getElementById('address-street').focus();
    else document.getElementById('address-number').focus();
  });
}

function termosAceitos() {
  const aceito = document.getElementById('accept-terms-checkbox').checked;
  if (!aceito) mostrarToast('É preciso aceitar os Termos de Uso e a Política de Privacidade.', 'erro');
  return aceito;
}

function ligarMascaras(form) {
  form.addEventListener('input', (evento) => {
    const mascara = { 'customer-cpf': mascararCpf, 'customer-phone': mascararTelefone, 'address-cep': mascararCep }[evento.target.id];
    if (!mascara) return;
    const cursorNoFim = evento.target.selectionEnd === evento.target.value.length;
    evento.target.value = mascara(evento.target.value);
    if (cursorNoFim) evento.target.setSelectionRange(evento.target.value.length, evento.target.value.length);
  });
}

/* ------------------------------------------------------------------
   MODO PEDIDO — Pix, Cartão, Boleto (compra avulsa)
------------------------------------------------------------------ */
function selecionarMetodo(idMetodo) {
  document.querySelectorAll('.payment-method').forEach((item) => {
    const botao = item.querySelector('.method-row');
    const conteudo = item.querySelector('.method-content');
    const ativo = item.dataset.method === idMetodo;

    item.classList.toggle('active', ativo);
    conteudo.classList.toggle('hidden', !ativo);
    botao.setAttribute('aria-expanded', String(ativo));
  });

  // Endereço só é exigido pela Asaas pra Cartão (antifraude) — Pix e
  // Boleto (cobrança direta) não precisam disso.
  document.getElementById('endereco-fieldset')?.classList.toggle('hidden', idMetodo !== 'cartao');

  if (idMetodo !== 'pix') pararPollingPix();
  if (idMetodo !== 'cartao') pararPollingCartao();
  if (idMetodo !== 'boleto') pararPollingBoleto();
}

async function iniciarModoPedido() {
  const listaMetodos = document.getElementById('payment-methods');
  listaMetodos.classList.add('carregando');
  const ids = await resolverContexto();
  listaMetodos.classList.remove('carregando');

  const form = document.getElementById('checkout-form');
  ligarMascaras(form);
  ligarBuscaCep();

  // O listener é sempre registrado — troca de método é 100% front-end
  // (sem rede) e precisa funcionar mesmo que o pedido não tenha
  // resolvido. Só as ações que cobram de verdade checam `ids` dentro.
  form.addEventListener('click', (evento) => {
    const linhaDeMetodo = evento.target.closest('.method-row');
    if (linhaDeMetodo) {
      const idMetodo = linhaDeMetodo.closest('.payment-method').dataset.method;
      return selecionarMetodo(idMetodo);
    }

    const id = evento.target.closest('button')?.id;
    if (!id) return;

    if (id === 'btn-copy-pix') return copiarCodigoPix();
    if (id === 'btn-copy-boleto') return copiarCodigoBoleto();

    if (!ids) {
      mostrarToast('O pedido não foi carregado — recarregue a página antes de pagar.', 'erro');
      return;
    }

    if (id === 'btn-generate-pix') {
      evento.preventDefault();
      if (!termosAceitos()) return;
      if (!validarDadosPagador()) return;
      return gerarPix({ contratanteId: ids.contratanteId, pedidoId: ids.pedidoId, dadosPagador: coletarDadosPagador(), mostrarToast });
    }

    if (id === 'btn-continuar-cartao') {
      evento.preventDefault();
      if (!termosAceitos()) return;
      if (!validarDadosPagador()) return;
      if (!validarEndereco()) return;
      const parcelas = document.getElementById('cartao-parcelas').value;
      return continuarComCartao({
        contratanteId: ids.contratanteId,
        pedidoId: ids.pedidoId,
        parcelas,
        dadosPagador: { ...coletarDadosPagador(), ...coletarEndereco() },
        mostrarToast
      });
    }

    if (id === 'btn-gerar-boleto') {
      evento.preventDefault();
      if (!termosAceitos()) return;
      if (!validarDadosPagador()) return;
      return gerarBoleto({ contratanteId: ids.contratanteId, pedidoId: ids.pedidoId, dadosPagador: coletarDadosPagador(), mostrarToast });
    }
  });

  if (!ids) {
    mostrarToast('Link de checkout inválido ou não foi possível carregar o pedido.', 'erro');
    return;
  }

  preencherCamposPagador(obterPagadorPreenchido());

  // Boleto só aparece quando o pedido NÃO tem expiraEm (ver
  // INTEGRACAO.md seção 4.3 / VISAO_COMPLETA.md seção 4.3).
  const pedido = obterPedidoResolvido();
  if (pedido && !pedido.expiraEm) {
    document.getElementById('metodo-boleto-wrapper').classList.remove('hidden');
  }
}

/* ------------------------------------------------------------------
   MODO ASSINATURA — plano recorrente, sem lista de métodos (só
   cartão, via Asaas Checkout RECURRENT — ver INTEGRACAO.md 6.1)
------------------------------------------------------------------ */
async function iniciarModoAssinatura() {
  document.getElementById('payment-methods').classList.add('hidden');
  document.getElementById('subscription-action').classList.remove('hidden');

  const resultado = await resolverAssinatura();
  const falhou = !resultado || resultado.erro;

  const form = document.getElementById('checkout-form');
  ligarMascaras(form);
  ligarBuscaCep();

  // Assinatura é sempre cartão (ver INTEGRACAO.md 6.1) — endereço fica
  // visível direto, sem depender de seleção de método.
  document.getElementById('endereco-fieldset')?.classList.remove('hidden');

  form.addEventListener('click', (evento) => {
    if (evento.target.closest('button')?.id !== 'btn-assinar') return;
    evento.preventDefault();

    if (falhou) {
      mostrarToast('O plano não foi carregado — recarregue a página antes de assinar.', 'erro');
      return;
    }

    if (!termosAceitos()) return;
    if (!validarDadosPagador()) return;
    if (!validarEndereco()) return;

    const idsResolvidos = obterIdsAssinaturaResolvidos() ?? resultado.ids;
    return assinarAgora({
      contratanteId: idsResolvidos.contratanteId,
      planoId: idsResolvidos.planoId,
      dadosPagador: { ...coletarDadosPagador(), ...coletarEndereco() },
      mostrarToast
    });
  });

  if (falhou) {
    document.getElementById('order-title').textContent = resultado?.erro ?? 'Link de assinatura inválido.';
    mostrarToast(resultado?.erro ?? 'Link de assinatura inválido ou incompleto.', 'erro');
    return;
  }

  const { plano } = resultado;

  document.getElementById('order-category').textContent = 'Assinatura';
  document.getElementById('order-title').textContent = plano.nome ?? 'Plano';
  document.getElementById('order-subtotal').textContent = `R$ ${formatarMoeda(plano.valor)}`;
  document.getElementById('order-amount').textContent = formatarMoeda(plano.valor);
  document.getElementById('order-desconto').textContent = 'R$ 0,00';
  document.getElementById('order-taxa').textContent = 'R$ 0,00';

  if (plano.descricao || plano.ciclo) {
    const elDescricao = document.getElementById('order-description');
    const cicloTexto = plano.ciclo ? ` — cobrança ${rotularCiclo(plano.ciclo)}` : '';
    elDescricao.textContent = `${plano.descricao ?? ''}${cicloTexto}`.trim();
    elDescricao.classList.remove('hidden');
  }

  if (plano.contratanteLogoUrl) {
    const logo = document.getElementById('contratante-logo');
    logo.src = plano.contratanteLogoUrl;
    logo.classList.remove('hidden');
    document.getElementById('brand-logos-row').classList.add('brand-logos-row--dual');
  }

  if (plano.bannerUrl) {
    document.getElementById('ad-banner-image').src = plano.bannerUrl;
    document.getElementById('ad-banner-wrapper').classList.remove('hidden');
  }

  preencherCamposPagador(obterPagadorPreenchidoAssinatura());
}

async function iniciar() {
  const parametros = new URLSearchParams(window.location.search);
  if (parametros.has('assinatura')) return iniciarModoAssinatura();
  return iniciarModoPedido();
}

ligarAtalhoAdmin();
iniciar();
