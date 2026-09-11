import { resolverContexto, obterPagadorPreenchido, obterPedidoResolvido, obterMetodosHabilitados, iniciarCronometroExpiracao } from './modules/pedidoHandler.js';
import { resolverAssinatura, obterIdsAssinaturaResolvidos, obterPagadorPreenchidoAssinatura, rotularCiclo, obterMetodosDoPlano } from './modules/assinaturaHandler.js';
import { gerarPix, copiarCodigoPix, pararPolling as pararPollingPix } from './modules/pixHandler.js';
import { continuarComCartao, pararPollingCartao } from './modules/cartaoHandler.js';
import { gerarBoleto, copiarCodigoBoleto, pararPollingBoleto } from './modules/boletoHandler.js';
import { assinarAgora } from './modules/assinaturaCheckoutHandler.js';
import { assinarComPix, pararPollingAssinaturaPix } from './modules/assinaturaPixHandler.js';
import { mascararDocumento, mascararTelefone, mascararCep } from './utils/masks.js';
import { validarDocumento, validarEmail, validarObrigatorio, validarTelefone, validarCep } from './utils/validators.js';
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

/** Copiar com fallback: alguns navegadores bloqueiam a área de
 *  transferência; selecionar o campo deixa a pessoa copiar na mão em
 *  vez de só falhar. */
async function copiarCampo(idCampo, rotulo) {
  const campo = document.getElementById(idCampo);
  try {
    await navigator.clipboard.writeText(campo.value);
    mostrarToast(`${rotulo} copiado.`, 'sucesso');
  } catch {
    campo.select();
    mostrarToast('Não consegui copiar: o texto está selecionado, use Ctrl+C.', 'erro');
  }
}

function formatarMoeda(valor) {
  return Number(valor ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function preencherCamposPagador(pagador) {
  if (pagador?.nome) document.getElementById('customer-name').value = pagador.nome;
  if (pagador?.email) document.getElementById('customer-email').value = pagador.email;
  if (pagador?.documento) document.getElementById('customer-cpf').value = mascararDocumento(pagador.documento);
  if (pagador?.telefone) document.getElementById('customer-phone').value = mascararTelefone(pagador.telefone);
}

function coletarDadosPagador() {
  return {
    nome: document.getElementById('customer-name').value.trim(),
    email: document.getElementById('customer-email').value.trim(),
    documento: document.getElementById('customer-cpf').value.replace(/\D/g, ''),
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
  if (!marcarErro('customer-cpf', validarDocumento(dados.documento) ? null : 'CPF/CNPJ inválido.')) valido = false;
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
    const mascara = { 'customer-cpf': mascararDocumento, 'customer-phone': mascararTelefone, 'address-cep': mascararCep }[evento.target.id];
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

    // Saída do cartão recusado: leva pra aba do Pix já aberta. Não gera
    // a cobrança sozinho de propósito — a pessoa confere o valor e
    // aperta, como em qualquer outro caminho.
    if (id === 'btn-tentar-pix') {
      evento.preventDefault();
      document.getElementById('saida-pix-cartao')?.classList.add('hidden');
      selecionarMetodo('pix');
      document.getElementById('btn-generate-pix')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    if (!ids) {
      mostrarToast('O pedido não foi carregado — recarregue a página antes de pagar.', 'erro');
      return;
    }

    if (id === 'btn-generate-pix') {
      evento.preventDefault();
      if (!termosAceitos()) return;
      if (!validarDadosPagador()) return;
      mostrarLinkPermanente(ids, 'pix');
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
        mostrarToast,
        aoNaoConcluir: oferecerPixAposFalhaNoCartao
      });
    }

    if (id === 'btn-gerar-boleto') {
      evento.preventDefault();
      if (!termosAceitos()) return;
      if (!validarDadosPagador()) return;
      mostrarLinkPermanente(ids, 'boleto');
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

  aplicarMetodosHabilitados();

  // Contagem regressiva quando o pedido tem prazo de verdade. Ao zerar,
  // desabilita os botões que cobram — o backend já recusaria
  // (resolverPedido checa expiraEm), mas deixar o botão clicável só pra
  // devolver erro é pior que dizer na hora o que aconteceu.
  iniciarCronometroExpiracao(() => {
    document.querySelectorAll('#btn-generate-pix, #btn-continuar-cartao, #btn-gerar-boleto')
      .forEach((botao) => { botao.disabled = true; });
    mostrarToast('Esta reserva expirou. Recarregue a página ou volte à loja para gerar um novo pedido.', 'erro');
  });
}

/**
 * Cartão não concluído: oferece o Pix ali mesmo, em vez de deixar a
 * pessoa sem caminho nenhum depois da pop-up fechar.
 *
 * Só aparece se o contratante tiver Pix habilitado — oferecer um método
 * que o backend vai recusar com 403 seria pior que não oferecer nada.
 */
function oferecerPixAposFalhaNoCartao() {
  const metodos = obterMetodosHabilitados();
  if (metodos && !metodos.includes('pix')) return;

  const bloco = document.getElementById('saida-pix-cartao');
  if (!bloco) return;
  bloco.classList.remove('hidden');
}

/**
 * Mostra o link permanente de status junto do Pix/boleto gerado.
 *
 * Sem isso a página de status não existe na prática: ninguém recebe a
 * URL. É o único caminho pra pessoa que fechou a aba voltar ao QR sem
 * ligar pra loja.
 */
function mostrarLinkPermanente(ids, metodo) {
  const url = `${window.location.origin}/status.html?c=${encodeURIComponent(ids.contratanteId)}&pedido=${encodeURIComponent(ids.pedidoId)}`;
  const bloco = document.getElementById(`link-permanente-${metodo}`);
  const link = document.getElementById(`link-status-${metodo}`);
  if (!bloco || !link) return;

  link.href = url;
  bloco.classList.remove('hidden');
}

/**
 * Esconde da tela os métodos que o contratante não tem habilitados
 * (tipos de cobrança, ver admin.html) — o backend já bloqueia a
 * cobrança de verdade (pedidoService.js), isso aqui só evita mostrar
 * uma opção que ia dar 403 na hora de pagar.
 */
function aplicarMetodosHabilitados() {
  const metodos = obterMetodosHabilitados();
  if (!metodos) return; // sem restrição — não mexe em nada

  let algumAtivoSobrou = false;
  document.querySelectorAll('.payment-method').forEach((item) => {
    const habilitado = metodos.includes(item.dataset.method);
    item.classList.toggle('hidden', !habilitado);
    if (habilitado && item.classList.contains('active')) algumAtivoSobrou = true;
  });

  if (algumAtivoSobrou) return;

  const primeiroDisponivel = document.querySelector('.payment-method:not(.hidden)');
  if (primeiroDisponivel) selecionarMetodo(primeiroDisponivel.dataset.method);
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

  // Pix Automático é alternativa ao cartão neste mesmo modo. Aparece só
  // se o contratante tiver o método habilitado — ele depende de a Asaas
  // ter liberado Pix Automático na conta, então nunca é presumido.
  const metodosDoPlano = obterMetodosDoPlano();
  const temPixAutomatico = !metodosDoPlano || metodosDoPlano.includes('assinatura_pix');
  if (!falhou && temPixAutomatico) {
    document.getElementById('assinatura-pix-bloco')?.classList.remove('hidden');
  }

  form.addEventListener('click', (evento) => {
    const idBotao = evento.target.closest('button')?.id;

    if (idBotao === 'btn-copy-assinatura-pix') {
      evento.preventDefault();
      return copiarCampo('assinatura-pix-codigo', 'Código Pix');
    }

    // Pix Automático não pede endereço: aquilo era antifraude do cartão.
    if (idBotao === 'btn-assinar-pix') {
      evento.preventDefault();
      if (falhou) {
        mostrarToast('O plano não foi carregado — recarregue a página antes de assinar.', 'erro');
        return;
      }
      if (!termosAceitos()) return;
      if (!validarDadosPagador()) return;

      const ids = obterIdsAssinaturaResolvidos() ?? resultado.ids;
      return assinarComPix({
        contratanteId: ids.contratanteId,
        planoId: ids.planoId,
        dadosPagador: coletarDadosPagador(),
        mostrarToast
      });
    }

    if (idBotao !== 'btn-assinar') return;
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
      // `&renovar=1` na URL = troca de cartão de uma assinatura que já
      // existe. O backend cancela a antiga só depois que esta confirmar.
      dadosPagador: {
        ...coletarDadosPagador(),
        ...coletarEndereco(),
        renovar: new URLSearchParams(window.location.search).get('renovar') === '1'
      },
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

/**
 * Sem `c` E sem `pedido`/`assinatura` na URL não é um link de loja
 * parceira mal configurado (esse caso já cai no erro normal de "pedido
 * não encontrado" dentro de resolverContexto/resolverAssinatura) — é
 * alguém batendo direto no domínio nu. Nesse caso a página nem chama a
 * API: troca o conteúdo por uma mensagem genérica, sem dar pista
 * nenhuma de que isso é um checkout de pagamento. ponytail: só troca
 * o HTML, não esconde nada com CSS — visitante nenhum vê o formulário
 * nem por um instante.
 */
function mostrarIndisponivel() {
  document.getElementById('checkout-root').innerHTML = `
    <div style="padding:48px 24px;text-align:center;max-width:360px;margin:0 auto">
      <h1 style="font-size:1.125rem;margin:0 0 8px">Acesso não autorizado</h1>
      <p style="margin:0;color:var(--text-secondary,#666);font-size:0.9rem">
        Esta página não está disponível para acesso direto.
      </p>
    </div>
  `;
}

async function iniciar() {
  const parametros = new URLSearchParams(window.location.search);
  const temPedido = parametros.has('c') && parametros.has('pedido');
  const temAssinatura = parametros.has('c') && parametros.has('assinatura');
  if (!temPedido && !temAssinatura) return mostrarIndisponivel();

  if (temAssinatura) return iniciarModoAssinatura();
  return iniciarModoPedido();
}

iniciar();
