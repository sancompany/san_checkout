/**
 * public/js/admin.js
 * Painel administrativo — arquivo externo (e não <script> inline)
 * porque a CSP em public/_headers usa script-src 'self' sem
 * 'unsafe-inline'.
 *
 * Nada de credencial fica em código aqui: usuário e senha do admin são
 * digitados na tela, guardados só no sessionStorage desta aba e
 * enviados em todo request (X-Admin-User / X-Admin-Pass). Quem valida é
 * sempre o backend (verificarAdminKey em adminController.js) — esta
 * tela não decide acesso nenhum sozinha.
 */

import { chamarApi } from './utils/api.js';
import { mascararDocumento, mascararTelefone, mascararCep, apenasDigitos } from './utils/masks.js';
import { buscarEnderecoPorCep } from './utils/cep.js';

const CHAVE_SESSAO = 'san-checkout-admin-login';

const METODOS = ['pix', 'boleto', 'cartao', 'assinatura', 'assinatura_pix'];
const NOME_METODO = { pix: 'Pix', boleto: 'Boleto', cartao: 'Cartão', assinatura: 'Assinatura', assinatura_pix: 'Assinatura por Pix' };

/** Estado da tela — a lista crua que o backend devolveu, pra abrir o
 *  modal de edição já preenchido sem ter que buscar de novo. */
let contratantes = [];
let subcontas = [];
let subcontaDoLink = null;

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------
   Sessão e chamadas
------------------------------------------------------------------ */
function loginSalvo() {
  try { return JSON.parse(sessionStorage.getItem(CHAVE_SESSAO)); } catch { return null; }
}

function salvarLogin(usuario, senha) {
  try { sessionStorage.setItem(CHAVE_SESSAO, JSON.stringify({ usuario, senha })); } catch { /* navegador bloqueou — segue sem persistir */ }
}

function limparLogin() {
  try { sessionStorage.removeItem(CHAVE_SESSAO); } catch { /* idem */ }
}

function headersAuth() {
  const login = loginSalvo();
  return { 'X-Admin-User': login?.usuario ?? '', 'X-Admin-Pass': login?.senha ?? '' };
}

const admin = {
  get: (caminho) => chamarApi(`/api/admin${caminho}`, { method: 'GET', headers: headersAuth() }),
  post: (caminho, dados) => chamarApi(`/api/admin${caminho}`, { method: 'POST', body: JSON.stringify(dados), headers: headersAuth() }),
  patch: (caminho, dados) => chamarApi(`/api/admin${caminho}`, { method: 'PATCH', body: JSON.stringify(dados), headers: headersAuth() })
};

/* ------------------------------------------------------------------
   Utilidades de tela
------------------------------------------------------------------ */
function escapar(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

function mostrarToast(mensagem, tipo = 'ok') {
  const toast = document.createElement('div');
  toast.className = `toast ${tipo}`;
  toast.textContent = mensagem;
  $('toasts').appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function mostrarErro(idElemento, mensagem) {
  const alvo = $(idElemento);
  alvo.textContent = mensagem;
  alvo.hidden = false;
}

function limparErro(idElemento) {
  $(idElemento).hidden = true;
}

async function copiar(texto, rotulo) {
  try {
    await navigator.clipboard.writeText(texto);
    mostrarToast(`${rotulo} copiado.`);
  } catch {
    mostrarToast('O navegador bloqueou a cópia — selecione e copie na mão.', 'erro');
  }
}

/** Segredo mascarado até alguém clicar no olho — padrão de console de
 *  pagamento (Stripe/Asaas): chave nenhuma fica impressa na tela por
 *  padrão, pra não vazar em print, gravação de tela ou ombro alheio. */
function blocoSegredo(valor, rotulo) {
  if (!valor) return '<span class="celula-fraca">—</span>';
  return `
    <span class="segredo">
      <span class="segredo-valor" data-segredo="${escapar(valor)}">${'•'.repeat(18)}</span>
      <button class="segredo-btn" type="button" data-revelar title="Revelar ${escapar(rotulo)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
      <button class="segredo-btn" type="button" data-copiar="${escapar(rotulo)}" title="Copiar ${escapar(rotulo)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
      </button>
    </span>
  `;
}

/** Delegação única pros botões de revelar/copiar de qualquer segredo na
 *  tela — em vez de religar listener a cada redesenho de tabela. */
document.addEventListener('click', (evento) => {
  const botao = evento.target.closest('[data-revelar], [data-copiar]');
  if (!botao) return;

  const campo = botao.closest('.segredo')?.querySelector('.segredo-valor');
  const valor = campo?.dataset.segredo;
  if (!valor) return;

  if (botao.hasAttribute('data-copiar')) return copiar(valor, botao.dataset.copiar);

  const revelado = campo.classList.toggle('revelado');
  campo.textContent = revelado ? valor : '•'.repeat(18);
});

/* ------------------------------------------------------------------
   Modais — <dialog> nativo
------------------------------------------------------------------ */
function abrirModal(id) {
  $(id).showModal();
}

function fecharModal(id) {
  $(id).close();
}

document.addEventListener('click', (evento) => {
  const fechar = evento.target.closest('[data-fechar-modal]');
  if (fechar) fechar.closest('dialog').close();
});

/* ------------------------------------------------------------------
   Navegação entre seções
------------------------------------------------------------------ */
const SECOES = ['contratantes', 'subcontas', 'metricas', 'webhook'];

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((outro) => outro.classList.toggle('ativo', outro === item));
    SECOES.forEach((secao) => { $(`secao-${secao}`).hidden = item.dataset.secao !== secao; });
    // Métricas só é buscada quando alguém olha — é a consulta mais cara
    // do painel e não faz sentido rodar em todo login.
    if (item.dataset.secao === 'metricas') carregarMetricas();
    if (item.dataset.secao === 'webhook') carregarWebhook();
  });
});

/* ------------------------------------------------------------------
   Contratantes
------------------------------------------------------------------ */
async function carregarContratantes() {
  contratantes = await admin.get('/contratantes');
  $('contador-contratantes').textContent = String(contratantes.length);
  $('vazio-contratantes').hidden = contratantes.length > 0;

  $('tabela-contratantes').innerHTML = contratantes.map((c) => {
    const metodos = Array.isArray(c.metodos_habilitados) ? c.metodos_habilitados : METODOS;
    return `
      <tr>
        <td><span class="badge-id">${escapar(c.id)}</span></td>
        <td class="celula-principal">
          ${escapar(c.nome)}
          ${c.wallet_id ? '<span class="pill pill-ok" title="Tem wallet_id — cobrança sai com split">split</span>' : ''}
        </td>
        <td class="celula-url" title="${escapar(c.api_base_url)}">${escapar(c.api_base_url)}</td>
        <td>
          <span class="pill-linha">
            ${metodos.map((m) => `<span class="pill pill-metodo">${escapar(NOME_METODO[m] ?? m)}</span>`).join('')}
          </span>
        </td>
        <td>${blocoSegredo(c.api_key, 'api_key')}</td>
        <td>
          <div class="acoes-linha">
            <button class="btn btn-secundario btn-mini" type="button" data-editar-contratante="${escapar(c.id)}">Editar</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  document.querySelectorAll('[data-editar-contratante]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalContratante(botao.dataset.editarContratante));
  });
}

/** Sem `id` = criar; com `id` = editar (id e api_key nunca mudam). */
function abrirModalContratante(id = null) {
  const alvo = id ? contratantes.find((c) => c.id === id) : null;

  $('modal-contratante-titulo').textContent = alvo ? `Editar ${alvo.nome}` : 'Novo contratante';
  $('modal-contratante-descricao').textContent = alvo
    ? 'O id e a api_key não mudam — trocar a chave quebraria a integração já em uso.'
    : 'A api_key é gerada automaticamente no cadastro.';
  $('btn-salvar-contratante').textContent = alvo ? 'Salvar alterações' : 'Cadastrar';
  $('btn-salvar-contratante').dataset.editando = alvo ? alvo.id : '';
  $('campo-contratante-id').hidden = Boolean(alvo);

  $('f-id').value = alvo?.id ?? '';
  $('f-nome').value = alvo?.nome ?? '';
  $('f-api-base-url').value = alvo?.api_base_url ?? '';
  $('f-webhook-url').value = alvo?.webhook_url ?? '';
  $('f-wallet-id').value = alvo?.wallet_id ?? '';

  const metodos = Array.isArray(alvo?.metodos_habilitados) ? alvo.metodos_habilitados : METODOS;
  METODOS.forEach((m) => { $(`f-metodo-${m}`).checked = metodos.includes(m); });

  limparErro('msg-contratante');
  abrirModal('modal-contratante');
}

async function salvarContratante() {
  const botao = $('btn-salvar-contratante');
  const editandoId = botao.dataset.editando;

  const metodosHabilitados = METODOS.filter((m) => $(`f-metodo-${m}`).checked);
  if (metodosHabilitados.length === 0) {
    return mostrarErro('msg-contratante', 'Marque pelo menos um tipo de cobrança.');
  }

  const corpo = {
    nome: $('f-nome').value.trim(),
    apiBaseUrl: $('f-api-base-url').value.trim(),
    webhookUrl: $('f-webhook-url').value.trim(),
    walletId: $('f-wallet-id').value.trim(),
    metodosHabilitados
  };

  limparErro('msg-contratante');
  botao.disabled = true;
  try {
    if (editandoId) {
      await admin.patch(`/contratantes/${editandoId}`, corpo);
      mostrarToast('Contratante atualizado.');
    } else {
      await admin.post('/contratantes', { id: $('f-id').value.trim(), ...corpo });
      mostrarToast('Contratante cadastrado.');
    }
    fecharModal('modal-contratante');
    await carregarContratantes();
  } catch (erro) {
    mostrarErro('msg-contratante', erro.message);
  } finally {
    botao.disabled = false;
  }
}

/* ------------------------------------------------------------------
   Subcontas
------------------------------------------------------------------ */
/**
 * Situação cadastral da subconta na Asaas, vinda dos webhooks
 * ACCOUNT_STATUS_* — antes isso era conferido na mão no painel da
 * Asaas. Sem webhook recebido ainda, não inventa selo nenhum.
 */
const SELO_SITUACAO = {
  APPROVED: { texto: 'Aprovada na Asaas', classe: 'pill-ok' },
  AWAITING_APPROVAL: { texto: 'Em análise na Asaas', classe: 'pill-pendente' },
  PENDING: { texto: 'Pendente na Asaas', classe: 'pill-pendente' },
  REJECTED: { texto: 'Recusada na Asaas', classe: 'pill-erro' }
};

function seloSituacao(situacao) {
  const selo = SELO_SITUACAO[situacao];
  if (!selo) return '';
  return `<span class="pill ${selo.classe}">${selo.texto}</span>`;
}

function linhaDado(rotulo, valor) {
  if (!valor) return '';
  return `<div><p class="dado-rotulo">${escapar(rotulo)}</p><p class="dado-valor">${escapar(valor)}</p></div>`;
}

function enderecoCompleto(s) {
  const partes = [s.endereco, s.endereco_numero, s.complemento].filter(Boolean).join(', ');
  const fim = [s.bairro, s.cep ? mascararCep(s.cep) : ''].filter(Boolean).join(' — ');
  return [partes, fim].filter(Boolean).join(' · ');
}

async function carregarSubcontas() {
  subcontas = await admin.get('/subcontas');
  $('contador-subcontas').textContent = String(subcontas.length);
  $('vazio-subcontas').hidden = subcontas.length > 0;

  $('lista-subcontas').innerHTML = subcontas.map((s) => {
    const temLink = Boolean(s.link_ativacao);
    return `
      <article class="subconta-card">
        <div class="subconta-topo">
          <div>
            <h3 class="subconta-nome">${escapar(s.nome)}</h3>
            <p class="subconta-doc">${escapar(mascararDocumento(s.documento))}</p>
          </div>
          <span class="subconta-status">
            ${seloSituacao(s.situacao_geral)}
            <span class="pill ${temLink ? 'pill-ok' : 'pill-pendente'}">${temLink ? 'Acesso salvo' : 'Aguardando link'}</span>
          </span>
        </div>

        <div class="subconta-dados">
          ${linhaDado('e-mail', s.email)}
          ${linhaDado('celular', s.celular ? mascararTelefone(s.celular) : '')}
          ${linhaDado('telefone', s.telefone ? mascararTelefone(s.telefone) : '')}
          ${linhaDado('endereço', enderecoCompleto(s))}
          ${linhaDado('faturamento', s.faturamento ? `R$ ${Number(s.faturamento).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '')}
          ${linhaDado('tipo de empresa', s.tipo_empresa)}
          ${linhaDado('nascimento', s.data_nascimento)}
          ${linhaDado('id na Asaas', s.asaas_account_id)}
          ${linhaDado('documentos', SELO_SITUACAO[s.situacao_documentos]?.texto?.replace(' na Asaas', ''))}
          ${linhaDado('dados comerciais', SELO_SITUACAO[s.situacao_comercial]?.texto?.replace(' na Asaas', ''))}
          ${linhaDado('conta bancária', SELO_SITUACAO[s.situacao_bancaria]?.texto?.replace(' na Asaas', ''))}
        </div>

        <div class="subconta-credenciais">
          <div>
            <p class="dado-rotulo">wallet_id</p>
            ${s.wallet_id ? blocoSegredo(s.wallet_id, 'wallet_id') : '<span class="celula-fraca">—</span>'}
          </div>
          <div>
            <p class="dado-rotulo">api_key da subconta</p>
            ${blocoSegredo(s.api_key, 'api_key da subconta')}
          </div>
        </div>

        <div class="subconta-rodape">
          <p class="rodape-nota">
            ${temLink
              ? 'Abre o link de ativação salvo. Se ele já foi usado, entre pelo painel da Asaas com este e-mail.'
              : 'Cole o link que a Asaas mandou por e-mail pra guardar o acesso aqui.'}
          </p>
          ${temLink
            ? `<a class="btn btn-marca btn-mini" href="${escapar(s.link_ativacao)}" target="_blank" rel="noopener noreferrer">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/></svg>
                 Entrar na subconta
               </a>
               <button class="btn btn-secundario btn-mini" type="button" data-link-subconta="${escapar(s.id)}">Trocar link</button>`
            : `<button class="btn btn-primario btn-mini" type="button" data-link-subconta="${escapar(s.id)}">Colar link de ativação</button>`}
        </div>
      </article>
    `;
  }).join('');

  document.querySelectorAll('[data-link-subconta]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalLink(botao.dataset.linkSubconta));
  });
}

function abrirModalLink(id) {
  subcontaDoLink = subcontas.find((s) => s.id === id) ?? null;
  $('modal-link-descricao').textContent = subcontaDoLink
    ? `Subconta: ${subcontaDoLink.nome}`
    : 'Cole o link que a Asaas enviou por e-mail.';
  $('f-link-ativacao').value = subcontaDoLink?.link_ativacao ?? '';
  limparErro('msg-link');
  abrirModal('modal-link');
}

async function salvarLinkAtivacao() {
  const link = $('f-link-ativacao').value.trim();
  if (!link) return mostrarErro('msg-link', 'Cole o link antes de salvar.');
  if (!/^https:\/\//i.test(link)) return mostrarErro('msg-link', 'O link precisa começar com https://.');

  const botao = $('btn-salvar-link');
  limparErro('msg-link');
  botao.disabled = true;
  try {
    await admin.patch(`/subcontas/${subcontaDoLink.id}`, { linkAtivacao: link });
    fecharModal('modal-link');
    mostrarToast('Link salvo.');
    await carregarSubcontas();
  } catch (erro) {
    mostrarErro('msg-link', erro.message);
  } finally {
    botao.disabled = false;
  }
}

const CAMPOS_SUBCONTA = {
  nome: 's-nome',
  email: 's-email',
  documento: 's-documento',
  telefone: 's-telefone',
  celular: 's-celular',
  endereco: 's-endereco',
  enderecoNumero: 's-endereco-numero',
  complemento: 's-complemento',
  bairro: 's-bairro',
  cep: 's-cep',
  faturamento: 's-faturamento',
  tipoEmpresa: 's-tipo-empresa',
  dataNascimento: 's-data-nascimento'
};

async function criarSubconta() {
  const corpo = Object.fromEntries(
    Object.entries(CAMPOS_SUBCONTA).map(([chave, id]) => [chave, $(id).value.trim()])
  );

  // A Asaas exige UM dos dois conforme o documento — mandar o errado
  // junto só gera recusa do outro lado.
  const ehCpf = apenasDigitos(corpo.documento).length === 11;
  if (ehCpf) corpo.tipoEmpresa = '';
  else corpo.dataNascimento = '';

  const botao = $('btn-criar-subconta');
  limparErro('msg-subconta');
  botao.disabled = true;
  botao.textContent = 'Criando...';
  try {
    await admin.post('/subcontas', corpo);
    fecharModal('modal-subconta');
    mostrarToast('Subconta criada — cole o link de ativação quando o e-mail chegar.');
    Object.values(CAMPOS_SUBCONTA).forEach((id) => { $(id).value = ''; });
    await carregarSubcontas();
  } catch (erro) {
    mostrarErro('msg-subconta', erro.message);
  } finally {
    botao.disabled = false;
    botao.textContent = 'Criar subconta';
  }
}

/* ------------------------------------------------------------------
   Máscaras e autopreenchimento do formulário de subconta
------------------------------------------------------------------ */
function ligarMascarasSubconta() {
  const mascaras = {
    's-documento': mascararDocumento,
    's-telefone': mascararTelefone,
    's-celular': mascararTelefone,
    's-cep': mascararCep
  };

  Object.entries(mascaras).forEach(([id, mascara]) => {
    $(id).addEventListener('input', (evento) => {
      evento.target.value = mascara(evento.target.value);
      if (id === 's-documento') alternarCamposPorDocumento();
    });
  });

  // Endereço vem do CEP (mesma função que o checkout já usa) — menos
  // digitação e menos chance de recusa por endereço errado na Asaas.
  $('s-cep').addEventListener('blur', async (evento) => {
    const endereco = await buscarEnderecoPorCep(evento.target.value);
    if (!endereco) return;
    if (!$('s-endereco').value) $('s-endereco').value = endereco.logradouro;
    if (!$('s-bairro').value) $('s-bairro').value = endereco.bairro;
  });
}

function alternarCamposPorDocumento() {
  const digitos = apenasDigitos($('s-documento').value);
  const ehCnpj = digitos.length > 11;
  $('campo-tipo-empresa').hidden = !ehCnpj;
  $('campo-data-nascimento').hidden = digitos.length === 0 || ehCnpj;
}

/* ------------------------------------------------------------------
   Métricas
------------------------------------------------------------------ */
function formatarReais(valor) {
  return Number(valor ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Taxa nula = nada se resolveu ainda no período; mostrar "0%" seria
 *  mentira, então mostra travessão. */
function celulaTaxa(taxa) {
  if (taxa === null || taxa === undefined) return '<span class="celula-fraca">—</span>';
  return `
    <span class="barra-taxa">
      <span class="barra-taxa-trilho"><span class="barra-taxa-preenchida" style="width:${taxa}%"></span></span>
      <span class="barra-taxa-numero">${taxa}%</span>
    </span>
  `;
}

function linhasMetrica(mapa, rotulos = {}) {
  const entradas = Object.entries(mapa).sort((a, b) => b[1].geradas - a[1].geradas);
  if (entradas.length === 0) return '';
  return entradas.map(([chave, n]) => `
    <tr>
      <td class="celula-principal">${escapar(rotulos[chave] ?? chave)}</td>
      <td>${n.geradas}</td>
      <td>${n.pagas}</td>
      <td>${n.emAberto || '<span class="celula-fraca">0</span>'}</td>
      <td>${n.perdidas || '<span class="celula-fraca">0</span>'}</td>
      <td>${celulaTaxa(n.taxaPagamento)}</td>
      <td>R$ ${formatarReais(n.valorPago)}</td>
    </tr>
  `).join('');
}

async function carregarMetricas() {
  const dias = $('metricas-periodo').value;
  try {
    const m = await admin.get(`/metricas?dias=${dias}`);
    const vazio = m.total.geradas === 0;

    $('vazio-metricas').hidden = !vazio;
    $('metricas-resumo').innerHTML = vazio ? '' : `
      <div class="cartao-metrica cartao-metrica--destaque">
        <p class="cartao-metrica-rotulo">Taxa de pagamento</p>
        <p class="cartao-metrica-valor">${m.total.taxaPagamento ?? '—'}${m.total.taxaPagamento === null ? '' : '%'}</p>
        <p class="cartao-metrica-nota">das cobranças já resolvidas</p>
      </div>
      <div class="cartao-metrica">
        <p class="cartao-metrica-rotulo">Cobranças geradas</p>
        <p class="cartao-metrica-valor">${m.total.geradas}</p>
        <p class="cartao-metrica-nota">${m.total.emAberto} ainda em aberto</p>
      </div>
      <div class="cartao-metrica">
        <p class="cartao-metrica-rotulo">Pagas</p>
        <p class="cartao-metrica-valor">${m.total.pagas}</p>
        <p class="cartao-metrica-nota">${m.total.perdidas} não pagas</p>
      </div>
      <div class="cartao-metrica">
        <p class="cartao-metrica-rotulo">Valor recebido</p>
        <p class="cartao-metrica-valor">R$ ${formatarReais(m.total.valorPago)}</p>
        <p class="cartao-metrica-nota">no período</p>
      </div>
    `;

    $('tabela-metricas-metodo').innerHTML = linhasMetrica(m.porMetodo, {
      pix: 'Pix', boleto: 'Boleto', cartao_credito: 'Cartão de crédito', assinatura: 'Assinatura'
    });
    $('tabela-metricas-contratante').innerHTML = linhasMetrica(m.porContratante);
  } catch (erro) {
    mostrarToast(erro.message, 'erro');
  }
}


/* ------------------------------------------------------------------
   Webhook — log de auditoria

   O contador do menu é buscado no login, não só quando a aba é aberta:
   o ponto do log é avisar que algo não tratado chegou, e aviso que só
   aparece para quem já foi olhar não avisa nada.
------------------------------------------------------------------ */
function formatarQuando(iso) {
  if (!iso) return '—';
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '—';
  return data.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Há quanto tempo, em palavras. Serve para a leitura mais importante
 *  desta tela: a Asaas PAUSA a fila depois de 15 falhas seguidas, e
 *  fila pausada não manda evento nenhum — o que se vê é ausência. */
function haQuantoTempo(iso) {
  if (!iso) return null;
  const minutos = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutos) || minutos < 0) return null;
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 48) return `há ${horas}h`;
  return `há ${Math.floor(horas / 24)} dias`;
}

/* Reaproveita a `.pill` que o painel já usa em toda tabela, em vez de
   um selo novo só para esta aba — Lei 5: elemento visual nasce em um
   lugar só. "Não mapeado" fica em amarelo e não em vermelho de
   propósito: é aviso de que algo novo chegou, não falha. */
const PILL_RESULTADO = {
  tratado: { classe: 'pill-ok', rotulo: 'tratado' },
  nao_mapeado: { classe: 'pill-pendente', rotulo: 'não mapeado' },
  erro: { classe: 'pill-erro', rotulo: 'erro' }
};

function celulaResultado(evento) {
  const marca = PILL_RESULTADO[evento.resultado] ?? { classe: '', rotulo: evento.resultado };
  const titulo = evento.detalhe ? ` title="${escapar(evento.detalhe)}"` : '';
  return `<span class="pill ${marca.classe}"${titulo}>${escapar(marca.rotulo)}</span>`;
}

/** Os campos redigidos, compactos: primeiro os valores que a lista
 *  branca deixou passar, depois quantos caminhos de chave sobraram. O
 *  mapa inteiro vai no `title`, que é onde se responde "onde vem o
 *  payment.id deste CHECKOUT_PAID". */
function celulaCampos(campos) {
  if (!campos) return '<span class="celula-fraca">—</span>';
  // `escapar` nos DOIS lados, e isto não é zelo: tanto o nome da chave
  // quanto o valor vêm do payload da Asaas. A lista branca da redação
  // decide QUAIS campos passam, não o que tem dentro deles — um
  // `status` com `<img src=x onerror=...>` chegaria inteiro aqui e
  // executaria no painel do admin.
  const valores = Object.entries(campos.valores ?? {})
    .filter(([chave]) => chave !== 'event')
    .map(([chave, valor]) => `${escapar(chave.split('.').pop())}=${escapar(String(valor))}`);
  const caminhos = campos.caminhos ?? [];
  const resumo = valores.slice(0, 2).join(' · ') || '<span class="celula-fraca">sem valor legível</span>';
  return `<span class="campos-redigidos" title="${escapar(caminhos.join('\n'))}">${resumo}<span class="celula-fraca"> (${caminhos.length} campos)</span></span>`;
}

function linhaWebhook(evento) {
  const cobranca = evento.cobranca;
  const pedido = cobranca
    ? `${escapar(cobranca.pedido_id ?? '—')}<span class="celula-fraca"> · ${escapar(cobranca.contratante_id ?? 'sem contratante')}</span>`
    : '<span class="celula-fraca">—</span>';

  return `
    <tr>
      <td class="celula-principal">${formatarQuando(evento.recebido_em)}</td>
      <td><code class="badge-id">${escapar(evento.evento ?? '—')}</code></td>
      <td>${celulaResultado(evento)}</td>
      <td>${evento.referencia_id ? `<code class="badge-id">${escapar(evento.referencia_id)}</code>` : '<span class="celula-fraca">—</span>'}</td>
      <td>${pedido}</td>
      <td>${celulaCampos(evento.campos)}</td>
    </tr>
  `;
}

/** Instrução que vem junto do evento em vez de numa conversa de meses
 *  atrás. Hoje só o Pix Automático tem uma — ver INSTRUCOES_POR_EVENTO
 *  no adminController.js. */
function cartaoInstrucao(instrucao) {
  return `
    <div class="painel cartao-instrucao">
      <p class="cartao-instrucao-titulo">${escapar(instrucao.titulo)}</p>
      <ol class="cartao-instrucao-passos">
        ${instrucao.passos.map((passo) => `<li>${escapar(passo)}</li>`).join('')}
      </ol>
    </div>
  `;
}

async function carregarResumoWebhook() {
  const resumo = await admin.get('/webhook/resumo');

  const contador = $('contador-webhook');
  contador.textContent = String(resumo.naoTratados);
  contador.hidden = resumo.naoTratados === 0;
  contador.classList.toggle('nav-contador--alerta', resumo.naoTratados > 0);

  const desde = haQuantoTempo(resumo.ultimoEvento?.recebido_em);
  $('webhook-resumo').innerHTML = `
    <div class="cartao-metrica ${resumo.naoTratados > 0 ? 'cartao-metrica--destaque' : ''}">
      <p class="cartao-metrica-rotulo">Eventos não tratados</p>
      <p class="cartao-metrica-valor">${resumo.naoTratados}</p>
      <p class="cartao-metrica-nota">nos últimos ${resumo.periodoDias} dias</p>
    </div>
    <div class="cartao-metrica">
      <p class="cartao-metrica-rotulo">Último evento recebido</p>
      <p class="cartao-metrica-valor">${desde ?? '—'}</p>
      <p class="cartao-metrica-nota">${escapar(resumo.ultimoEvento?.evento ?? 'nenhum até agora')}</p>
    </div>
  `;

  const rejeicoes = resumo.rejeicoes ?? { total: 0, ultimaHora: 0, amostras: [] };
  $('faixa-rejeicoes').hidden = rejeicoes.total === 0;
  $('rejeicoes-total').textContent = String(rejeicoes.total);
  $('rejeicoes-hora').textContent = String(rejeicoes.ultimaHora);
  $('rejeicoes-desde').textContent = rejeicoes.desde ? `desde ${formatarQuando(rejeicoes.desde)}` : '';
  $('tabela-rejeicoes').innerHTML = (rejeicoes.amostras ?? []).map((a) => `
    <tr>
      <td class="celula-principal">${formatarQuando(a.em)}</td>
      <td><code class="badge-id">${escapar(a.ip ?? '—')}</code></td>
      <td>${a.tinhaToken ? 'sim, errado' : '<span class="celula-fraca">não mandou</span>'}</td>
      <td>${escapar(a.motivo ?? '—')}</td>
    </tr>
  `).join('');
}

async function carregarWebhook() {
  try {
    await carregarResumoWebhook();

    const filtro = $('webhook-filtro').value;
    const eventos = await admin.get(`/webhook/eventos?limite=100${filtro ? `&resultado=${filtro}` : ''}`);

    $('vazio-webhook').hidden = eventos.length > 0;
    $('tabela-webhook').innerHTML = eventos.map(linhaWebhook).join('');

    // Uma instrução por tipo de evento, não uma por linha.
    const vistas = new Set();
    $('webhook-instrucoes').innerHTML = eventos
      .filter((e) => e.instrucao && !vistas.has(e.evento) && vistas.add(e.evento))
      .map((e) => cartaoInstrucao(e.instrucao))
      .join('');
  } catch (erro) {
    mostrarToast(erro.message, 'erro');
  }
}

/* ------------------------------------------------------------------
   Login / logout
------------------------------------------------------------------ */
async function carregarTudo() {
  await carregarContratantes();
  await carregarSubcontas();
  // O resumo do webhook entra no login, e não só ao abrir a aba:
  // alerta que depende de alguém ir olhar não é alerta. Falha dele não
  // pode derrubar o login — o painel serve para outras coisas.
  try { await carregarResumoWebhook(); } catch { /* a aba mostra o erro quando for aberta */ }
}

async function tentarEntrar(usuarioForcado, senhaForcada) {
  const usuario = usuarioForcado ?? $('admin-user').value.trim();
  const senha = senhaForcada ?? $('admin-pass').value;
  if (!usuario || !senha) return;

  salvarLogin(usuario, senha);
  const botao = $('btn-entrar');
  botao.disabled = true;
  try {
    await carregarTudo();
    limparErro('msg-login');
    $('rotulo-usuario').textContent = usuario;
    $('tela-login').hidden = true;
    $('tela-painel').hidden = false;
  } catch (erro) {
    limparLogin();
    mostrarErro('msg-login', erro.message);
  } finally {
    botao.disabled = false;
  }
}

function sair() {
  limparLogin();
  $('admin-pass').value = '';
  $('tela-painel').hidden = true;
  $('tela-login').hidden = false;
}

/* ------------------------------------------------------------------
   Ligações
------------------------------------------------------------------ */
$('btn-entrar').addEventListener('click', () => tentarEntrar());
$('admin-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') tentarEntrar(); });
$('btn-sair').addEventListener('click', sair);

$('btn-abrir-novo-contratante').addEventListener('click', () => abrirModalContratante());
$('btn-salvar-contratante').addEventListener('click', salvarContratante);

$('btn-abrir-nova-subconta').addEventListener('click', () => { limparErro('msg-subconta'); alternarCamposPorDocumento(); abrirModal('modal-subconta'); });
$('btn-criar-subconta').addEventListener('click', criarSubconta);
$('btn-salvar-link').addEventListener('click', salvarLinkAtivacao);
$('metricas-periodo').addEventListener('change', carregarMetricas);
$('webhook-filtro').addEventListener('change', carregarWebhook);
$('btn-recarregar-webhook').addEventListener('click', carregarWebhook);
$('btn-expandir-rejeicoes').addEventListener('click', () => {
  const detalhe = $('rejeicoes-detalhe');
  detalhe.hidden = !detalhe.hidden;
  $('btn-expandir-rejeicoes').setAttribute('aria-expanded', String(!detalhe.hidden));
});

ligarMascarasSubconta();

// já tem login guardado nesta aba (sessionStorage) — pula direto pro painel
const login = loginSalvo();
if (login) tentarEntrar(login.usuario, login.senha);
