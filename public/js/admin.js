/**
 * public/js/admin.js
 * Painel administrativo — arquivo externo (e não <script> inline)
 * porque a CSP em public/_headers usa script-src 'self' sem
 * 'unsafe-inline'.
 *
 * Nada de credencial fica em código aqui, e — desde 12/09/2026 — nada
 * de SENHA fica em lugar nenhum do navegador. A senha é digitada uma
 * vez, trocada por um token de sessão em POST /api/admin/sessao, e
 * esquecida: o que fica no sessionStorage desta aba é só o token.
 *
 * Duas coisas melhoraram de uma vez, e a segunda é a que importa mais:
 *
 * 1. Velocidade. Antes, TODA requisição levava a senha e o servidor
 *    rodava scrypt (~830 ms) para conferi-la — três listas na abertura
 *    do painel eram ~2,5 s só de derivação. Agora o custo é pago uma
 *    vez, no login; conferir o token custa ~25 µs.
 * 2. Superfície. Senha guardada na aba vazava em qualquer XSS, em
 *    qualquer extensão que leia storage, e ia no cabeçalho de cada
 *    chamada. Token vaza no máximo o que resta das 8 horas, e some
 *    sozinho quando a senha do admin é trocada (a chave que o assina é
 *    derivada do hash da senha).
 *
 * Quem valida continua sendo sempre o backend (verificarAdminKey em
 * adminController.js) — esta tela não decide acesso nenhum sozinha.
 */

import { chamarApi } from './utils/api.js';
import { mascararDocumento, mascararTelefone, mascararCep, apenasDigitos } from './utils/masks.js';
import { buscarEnderecoPorCep } from './utils/cep.js';

const CHAVE_SESSAO = 'san-checkout-admin-login';

const METODOS = ['pix', 'boleto', 'cartao', 'assinatura', 'assinatura_pix'];

/**
 * O que vem marcado num contratante NOVO. Espelha o `default` da coluna
 * `metodos_habilitados` no banco, e a diferença para `METODOS` é uma só
 * e proposital: **`assinatura_pix` nasce DESMARCADA.**
 *
 * O Pix Automático não está liberado nesta conta Asaas
 * (`CONSTRAINTS.md` §2.4). Habilitar o método para um contratante antes
 * da liberação cria um caminho de pagamento que falha na hora de cobrar
 * — o comprador escolhe, e a cobrança não sai.
 *
 * Isto existia como `checked` no HTML e era desfeito pelo JS, que caía
 * em `METODOS` quando não havia contratante para copiar. Duas fontes
 * para o mesmo padrão, e a que valia era a errada.
 */
const METODOS_PADRAO = METODOS.filter((m) => m !== 'assinatura_pix');
const NOME_METODO = { pix: 'Pix', boleto: 'Boleto', cartao: 'Cartão', assinatura: 'Assinatura', assinatura_pix: 'Assinatura por Pix' };

/** Estado da tela — a lista crua que o backend devolveu, pra abrir o
 *  modal de edição já preenchido sem ter que buscar de novo. */
let contratantes = [];
let subcontas = [];
let subcontaDoLink = null;

/** O que está arquivado vive na tela "Arquivados", não misturado nas
 *  listas de trabalho. Guardado aqui para a tela conseguir desenhar sem
 *  buscar de novo. */
let arquivados = { contratantes: [], subcontas: [] };

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------
   Sessão e chamadas
------------------------------------------------------------------ */
function sessaoSalva() {
  try {
    const s = JSON.parse(sessionStorage.getItem(CHAVE_SESSAO));
    return s?.token ? s : null;
  } catch { return null; }
}

function salvarSessao(sessao) {
  try { sessionStorage.setItem(CHAVE_SESSAO, JSON.stringify(sessao)); } catch { /* navegador bloqueou — segue sem persistir */ }
}

function limparSessao() {
  try { sessionStorage.removeItem(CHAVE_SESSAO); } catch { /* idem */ }
}

/** Vencido pelo relógio DESTA máquina. Não é a checagem que protege
 *  nada — quem decide é o servidor, que confere o `exp` assinado — é só
 *  para não mandar uma rodada de requisições fadadas ao 401 e devolver
 *  a tela de login na hora certa. */
function sessaoVencida(sessao) {
  const limite = Date.parse(sessao?.expiraEm ?? '');
  return Number.isFinite(limite) && limite <= Date.now();
}

function headersAuth() {
  return { 'X-Admin-Token': sessaoSalva()?.token ?? '' };
}

/**
 * Chamada autenticada do painel. O envelope existe por causa do 401 no
 * MEIO da sessão: antes, o login guardado continuava lá, cada tela
 * mostrava um toast de erro diferente e o operador ficava num painel
 * que não respondia mais, sem entender por quê.
 *
 * Agora o token vencido (ou invalidado por troca de senha do admin)
 * derruba para a tela de login uma vez, com a razão escrita. O erro
 * continua subindo para quem chamou, que segue tratando o resto como
 * antes.
 */
async function chamarAdmin(caminho, opcoes) {
  try {
    return await chamarApi(`/api/admin${caminho}`, { ...opcoes, headers: headersAuth() });
  } catch (erro) {
    if (erro.status === 401 && erro.corpo?.sessaoExpirada) encerrarSessao(erro.message);
    throw erro;
  }
}

const admin = {
  get: (caminho) => chamarAdmin(caminho, { method: 'GET' }),
  post: (caminho, dados) => chamarAdmin(caminho, { method: 'POST', body: JSON.stringify(dados) }),
  patch: (caminho, dados) => chamarAdmin(caminho, { method: 'PATCH', body: JSON.stringify(dados) })
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
 *  padrão, pra não vazar em print, gravação de tela ou ombro alheio.
 *
 *  `rotacionarId` acrescenta o terceiro ícone, o de trocar. Ele é opcional
 *  porque só a chave de CONTRATANTE se troca por aqui: a da subconta é
 *  emitida pela Asaas e quem a rotaciona é o painel deles, então mostrar
 *  o ícone ali prometeria o que esta tela não faz. */
function blocoSegredo(valor, rotulo, { rotacionarId } = {}) {
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
      ${rotacionarId ? `
      <button class="segredo-btn segredo-btn--trocar" type="button" data-rotacionar="${escapar(rotacionarId)}"
              title="Trocar ${escapar(rotulo)} — a atual para de valer na hora"
              aria-label="Trocar ${escapar(rotulo)} de ${escapar(rotacionarId)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11A8 8 0 0 0 6.3 6.3L3 9"/><path d="M3 4v5h5"/><path d="M4 13a8 8 0 0 0 13.7 4.7L21 15"/><path d="M21 20v-5h-5"/></svg>
      </button>` : ''}
    </span>
  `;
}

/** Delegação única pros botões de revelar/copiar de qualquer segredo na
 *  tela — em vez de religar listener a cada redesenho de tabela. */
document.addEventListener('click', (evento) => {
  const botao = evento.target.closest('[data-revelar], [data-copiar], [data-rotacionar]');
  if (!botao) return;

  // Antes de ler o valor: trocar a chave não depende dela estar revelada
  // nem de existir na tela — o segredo novo vem do servidor.
  if (botao.hasAttribute('data-rotacionar')) return rotacionarChaveContratante(botao.dataset.rotacionar);

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
   Arquivar — contratante e subconta

   Não existe excluir. `cobrancas.contratante_id` é `on delete set null`:
   apagar um contratante deixaria o histórico financeiro dele sem dono.
   Arquivar tira da lista, para a cobrança e guarda tudo. Ver
   CONSTRAINTS.md §1.10.
------------------------------------------------------------------ */

/**
 * Confirmação em `<dialog>` nativo, resolvida por promessa. Um lugar só
 * para os dois tipos, senão a mensagem diverge no primeiro dia em que
 * alguém mexer num dos dois — elemento repetido nasce dessincronizado
 * (Lei 5).
 *
 * `<dialog>` e não `confirm()`: o `confirm` do navegador trava o
 * processo e não aceita texto formatado, e é justamente aqui que o
 * texto precisa explicar o que arquivar FAZ, não só perguntar "tem
 * certeza?".
 */
function confirmar({ titulo, corpo, rotuloAcao, perigo = false }) {
  return new Promise((resolver) => {
    $('confirmar-titulo').textContent = titulo;
    $('confirmar-corpo').innerHTML = corpo;
    const botao = $('btn-confirmar-acao');
    botao.textContent = rotuloAcao;
    botao.className = `btn btn-mini ${perigo ? 'btn-perigo' : 'btn-primario'}`;

    const dialogo = $('modal-confirmar');
    const aoFechar = () => {
      dialogo.removeEventListener('close', aoFechar);
      resolver(dialogo.returnValue === 'confirmar');
    };
    dialogo.addEventListener('close', aoFechar);
    dialogo.returnValue = '';
    dialogo.showModal();
  });
}

/**
 * Troca a api_key do contratante. Imediata: a antiga morre no ato.
 *
 * O aviso não é formalidade — é a informação que decide o clique. Quem
 * troca a chave de um contratante em produção derruba a integração dele
 * até alguém do outro lado colar a nova, e o texto diz isso com o nome
 * do contratante na frente. Confirmação sem consequência escrita é só
 * um obstáculo a mais para clicar no automático.
 */
async function rotacionarChaveContratante(id) {
  const alvo = contratantes.find((c) => c.id === id);
  const nome = alvo?.nome ?? id;

  const ok = await confirmar({
    titulo: `Trocar a chave de ${escapar(nome)}?`,
    corpo: `
      <p>A chave atual <strong>para de valer na hora</strong>. Enquanto
      o outro lado não colar a nova, este contratante não resolve pedido
      nem autentica estorno.</p>
      <p>Faça na ordem: trocar aqui, copiar a chave nova, atualizar no
      sistema do contratante.</p>
      <p class="confirmar-nota">Não dá para desfazer — a chave antiga não
      volta. Trocar de novo gera outra.</p>`,
    rotuloAcao: 'Trocar chave',
    perigo: true
  });
  if (!ok) return;

  try {
    const atualizado = await admin.post(`/contratantes/${id}/rotacionar-chave`, {});
    // A resposta traz a chave nova: atualiza a linha em memória em vez
    // de recarregar a lista, que custaria outra derivação de senha.
    if (alvo) alvo.api_key = atualizado.api_key;
    desenharContratantes();
    mostrarToast(`Chave de ${nome} trocada. Copie a nova e atualize o contratante.`);
  } catch (erro) {
    mostrarToast(erro.message, 'erro');
  }
}

async function alternarArquivoContratante(id, arquivar) {
  const alvo = contratantes.find((c) => c.id === id);
  const nome = alvo?.nome ?? id;

  if (arquivar) {
    const ok = await confirmar({
      titulo: `Arquivar ${escapar(nome)}?`,
      corpo: `
        <p>O cadastro e todo o histórico de cobranças <strong>continuam
        guardados</strong> — nada é apagado.</p>
        <p>O que muda: ele sai desta lista e <strong>para de cobrar</strong>.
        Link antigo deste contratante passa a responder "contratante não
        encontrado", e a api_key dele deixa de valer para estorno.</p>
        <p class="confirmar-nota">Dá para desfazer a qualquer momento em
        "mostrar arquivados".</p>`,
      rotuloAcao: 'Arquivar',
      perigo: true
    });
    if (!ok) return;
  }

  try {
    await admin.patch(`/contratantes/${id}/arquivar`, { arquivar });
    mostrarToast(arquivar ? `${nome} arquivado.` : `${nome} de volta à lista.`);
    // Só a tela que está aberta é redesenhada. Cada `admin.get` custa uma
    // derivação de senha (~3s), então recarregar as duas listas a cada
    // clique dobraria a espera sem ninguém ver a diferença.
    await (arquivar ? carregarContratantes() : carregarArquivados());
  } catch (erro) {
    mostrarToast(erro.message, 'erro');
  }
}

async function alternarArquivoSubconta(id, arquivar) {
  const alvo = subcontas.find((s) => s.id === id);
  const nome = alvo?.nome ?? id;

  if (arquivar) {
    const ok = await confirmar({
      titulo: `Arquivar ${escapar(nome)}?`,
      corpo: `
        <p>A conta <strong>continua existindo na Asaas</strong> e continua
        recebendo split. Arquivar aqui só tira da lista deste painel.</p>
        <p>Não é possível excluir uma subconta pela API da Asaas sem
        entrar na conta dela — por isso esta tela não oferece excluir,
        em vez de fingir que exclui.</p>
        <p class="confirmar-nota">Dá para desfazer em "mostrar
        arquivados".</p>`,
      rotuloAcao: 'Arquivar',
      perigo: true
    });
    if (!ok) return;
  }

  try {
    const resultado = await admin.patch(`/subcontas/${id}/arquivar`, { arquivar });
    const usando = resultado?.contratantesUsando ?? [];
    if (arquivar && usando.length > 0) {
      // Aviso e não bloqueio: quem decide é o operador, mas não às cegas.
      mostrarToast(
        `${nome} arquivada — mas o wallet_id dela ainda está em ${usando.map((c) => c.nome).join(', ')}.`,
        'erro'
      );
    } else {
      mostrarToast(arquivar ? `${nome} arquivada.` : `${nome} de volta à lista.`);
    }
    await (arquivar ? carregarSubcontas() : carregarArquivados());
  } catch (erro) {
    mostrarToast(erro.message, 'erro');
  }
}

/**
 * A tela dos arquivados. Busca com `incluirArquivados=1` e fica só com o
 * que tem carimbo — as duas listas de trabalho continuam pedindo apenas
 * os ativos, então nada aqui muda o que elas mostram.
 *
 * Duas requisições de admin, e cada uma custa ~3s por causa da derivação
 * de senha (ver a pendência de arquitetura de acesso no CLAUDE.md). Por
 * isso esta tela só busca quando alguém abre ela, nunca no login.
 */
async function carregarArquivados() {
  try {
    /* Em paralelo desde 13/09/2026, pelo mesmo motivo de `carregarTudo`:
       a proibição antiga existia por causa dos ~128 MiB por derivação de
       senha, e o token de sessão acabou com ela. */
    const [listaContratantes, listaSubcontas] = await Promise.all([
      admin.get('/contratantes?incluirArquivados=1'),
      admin.get('/subcontas?incluirArquivados=1')
    ]);

    arquivados = {
      contratantes: listaContratantes.filter((c) => c.arquivado_em),
      subcontas: listaSubcontas.filter((s) => s.arquivado_em)
    };

    const total = arquivados.contratantes.length + arquivados.subcontas.length;
    $('contador-arquivados').textContent = String(total);
    $('vazio-arquivados').hidden = total > 0;

    $('tabela-contratantes-arquivados').innerHTML = arquivados.contratantes.map((c) => `
      <tr class="linha-arquivada">
        <td><span class="badge-id">${escapar(c.id)}</span></td>
        <td class="celula-principal">${escapar(c.nome)}</td>
        <td class="celula-url" title="${escapar(c.api_base_url)}">${escapar(c.api_base_url)}</td>
        <td>${formatarQuando(c.arquivado_em)}</td>
        <td>
          <div class="acoes-linha">
            <button class="btn btn-primario btn-mini" type="button" data-desarquivar-contratante="${escapar(c.id)}">Restaurar</button>
          </div>
        </td>
      </tr>
    `).join('');

    $('lista-subcontas-arquivadas').innerHTML = arquivados.subcontas.map((s) => `
      <article class="subconta-card linha-arquivada">
        <div class="subconta-topo">
          <div>
            <h3 class="subconta-nome">${escapar(s.nome)}</h3>
            <p class="subconta-doc">${escapar(mascararDocumento(s.documento))}</p>
          </div>
          <span class="subconta-status">
            <span class="pill pill-pendente" title="Só fora da lista — a conta segue ativa na Asaas">arquivada em ${formatarQuando(s.arquivado_em)}</span>
          </span>
        </div>
        <div class="subconta-rodape">
          <p class="rodape-nota">A conta continua existindo na Asaas e continua recebendo split.</p>
          <button class="btn btn-primario btn-mini" type="button" data-desarquivar-subconta="${escapar(s.id)}">Restaurar</button>
        </div>
      </article>
    `).join('');

    document.querySelectorAll('[data-desarquivar-contratante]').forEach((botao) => {
      botao.addEventListener('click', () => alternarArquivoContratante(botao.dataset.desarquivarContratante, false));
    });
    document.querySelectorAll('[data-desarquivar-subconta]').forEach((botao) => {
      botao.addEventListener('click', () => alternarArquivoSubconta(botao.dataset.desarquivarSubconta, false));
    });
  } catch (erro) {
    mostrarToast(erro.message, 'erro');
  }
}

/* ------------------------------------------------------------------
   Navegação entre seções
------------------------------------------------------------------ */
const SECOES = ['contratantes', 'subcontas', 'arquivados', 'metricas', 'webhook'];

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((outro) => outro.classList.toggle('ativo', outro === item));
    SECOES.forEach((secao) => { $(`secao-${secao}`).hidden = item.dataset.secao !== secao; });
    // Métricas só é buscada quando alguém olha — é a consulta mais cara
    // do painel e não faz sentido rodar em todo login.
    if (item.dataset.secao === 'metricas') carregarMetricas();
    if (item.dataset.secao === 'webhook') carregarWebhook();
    if (item.dataset.secao === 'arquivados') carregarArquivados();
  });
});

/* ------------------------------------------------------------------
   Contratantes
------------------------------------------------------------------ */
async function carregarContratantes() {
  contratantes = await admin.get('/contratantes');
  desenharContratantes();
}

/**
 * Redesenha a tabela a partir do que JÁ está em `contratantes`, sem ir ao
 * servidor. Separado de `carregarContratantes` porque salvar um
 * contratante devolve a linha inteira na resposta — buscar a lista de
 * novo depois disso é uma segunda volta ao banco para saber o que o
 * servidor acabou de contar.
 */
function desenharContratantes() {
  $('contador-contratantes').textContent = String(contratantes.length);
  $('vazio-contratantes').hidden = contratantes.length > 0;

  $('tabela-contratantes').innerHTML = contratantes.map((c) => {
    const metodos = Array.isArray(c.metodos_habilitados) ? c.metodos_habilitados : METODOS_PADRAO;
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
        <td>${blocoSegredo(c.api_key, 'api_key', { rotacionarId: c.id })}</td>
        <td>
          <div class="acoes-linha">
            <button class="btn btn-secundario btn-mini" type="button" data-editar-contratante="${escapar(c.id)}">Editar</button>
            <button class="btn btn-secundario btn-mini" type="button" data-arquivar-contratante="${escapar(c.id)}">Arquivar</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  document.querySelectorAll('[data-editar-contratante]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalContratante(botao.dataset.editarContratante));
  });
  document.querySelectorAll('[data-arquivar-contratante]').forEach((botao) => {
    botao.addEventListener('click', () => alternarArquivoContratante(botao.dataset.arquivarContratante, true));
  });
  document.querySelectorAll('[data-desarquivar-contratante]').forEach((botao) => {
    botao.addEventListener('click', () => alternarArquivoContratante(botao.dataset.desarquivarContratante, false));
  });
}

/** Sem `id` = criar; com `id` = editar. A chave se troca pelo ícone ao
 *  lado dela, na linha (`rotacionarChaveContratante`). */
function abrirModalContratante(id = null) {
  const alvo = id ? contratantes.find((c) => c.id === id) : null;

  $('modal-contratante-titulo').textContent = alvo ? `Editar ${alvo.nome}` : 'Novo contratante';
  $('modal-contratante-descricao').textContent = alvo
    ? 'Para trocar a api_key, use o ícone de setas em círculo ao lado dela, na linha do contratante — ele avisa o que a troca derruba antes de confirmar. O id não muda.'
    : 'A api_key é gerada automaticamente no cadastro.';
  $('btn-salvar-contratante').textContent = alvo ? 'Salvar alterações' : 'Cadastrar';
  $('btn-salvar-contratante').dataset.editando = alvo ? alvo.id : '';
  $('campo-contratante-id').hidden = Boolean(alvo);

  $('f-id').value = alvo?.id ?? '';
  $('f-nome').value = alvo?.nome ?? '';
  $('f-api-base-url').value = alvo?.api_base_url ?? '';
  $('f-webhook-url').value = alvo?.webhook_url ?? '';
  $('f-wallet-id').value = alvo?.wallet_id ?? '';
  // Uma origem por linha — é o formato que o operador consegue conferir
  // de bate-pronto, e o backend normaliza cada uma para `URL.origin`.
  $('f-retorno-dominios').value = Array.isArray(alvo?.retorno_dominios)
    ? alvo.retorno_dominios.join('\n')
    : '';

  // Contratante existente: espelha o que está salvo. Novo: o padrão, que
  // NÃO inclui assinatura_pix — ver METODOS_PADRAO acima.
  const metodos = Array.isArray(alvo?.metodos_habilitados) ? alvo.metodos_habilitados : METODOS_PADRAO;
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
    metodosHabilitados,
    retornoDominios: $('f-retorno-dominios').value
      .split('\n')
      .map((linha) => linha.trim())
      .filter(Boolean)
  };

  limparErro('msg-contratante');
  botao.disabled = true;
  try {
    /* As duas rotas devolvem a linha inteira, com os mesmos campos que a
       listagem usa — então a tela se atualiza com a resposta que já veio,
       em vez de perguntar de novo. Uma ida ao servidor em vez de duas. */
    if (editandoId) {
      const atualizado = await admin.patch(`/contratantes/${editandoId}`, corpo);
      const i = contratantes.findIndex((c) => c.id === editandoId);
      if (i === -1) contratantes.unshift(atualizado); else contratantes[i] = atualizado;
      mostrarToast('Contratante atualizado.');
    } else {
      const criado = await admin.post('/contratantes', { id: $('f-id').value.trim(), ...corpo });
      contratantes.unshift(criado);   // a lista é ordenada por criado_em desc
      mostrarToast('Contratante cadastrado.');
    }
    fecharModal('modal-contratante');
    desenharContratantes();
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
  desenharSubcontas();
}

/** Mesmo motivo de `desenharContratantes`: a resposta da criação já traz
 *  a subconta inteira. */
function desenharSubcontas() {
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
          <button class="btn btn-secundario btn-mini" type="button" data-arquivar-subconta="${escapar(s.id)}">Arquivar</button>
        </div>
      </article>
    `;
  }).join('');

  document.querySelectorAll('[data-link-subconta]').forEach((botao) => {
    botao.addEventListener('click', () => abrirModalLink(botao.dataset.linkSubconta));
  });
  document.querySelectorAll('[data-arquivar-subconta]').forEach((botao) => {
    botao.addEventListener('click', () => alternarArquivoSubconta(botao.dataset.arquivarSubconta, true));
  });
  document.querySelectorAll('[data-desarquivar-subconta]').forEach((botao) => {
    botao.addEventListener('click', () => alternarArquivoSubconta(botao.dataset.desarquivarSubconta, false));
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
    const criada = await admin.post('/subcontas', corpo);
    subcontas.unshift(criada);        // idem: a resposta já traz a subconta inteira
    fecharModal('modal-subconta');
    mostrarToast('Subconta criada — cole o link de ativação quando o e-mail chegar.');
    Object.values(CAMPOS_SUBCONTA).forEach((id) => { $(id).value = ''; });
    desenharSubcontas();
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
  /* EM PARALELO, e isto mudou em 13/09/2026. Enquanto cada rota de
     `/api/admin` conferia a senha com scrypt, duas chamadas simultâneas
     pediam ~256 MiB e derrubavam a instância — por isso eram uma de cada
     vez. Com o token de sessão a conferência custa ~25 µs e não aloca
     nada, então a fila deixou de proteger o servidor e só somava espera:
     medido do navegador do operador, cada ida ao Supabase custa 60-90 ms
     (com picos de ~270 ms), e em série isso dobrava na cara de quem
     entra. */
  await Promise.all([carregarContratantes(), carregarSubcontas()]);

  /* O resumo do webhook é disparado SEM `await` porque ele não faz
     parte da tela que o operador veio ver: é um contador de alerta, e
     esperar por ele atrasaria contratantes e subcontas sem motivo.

     Ele continua sendo buscado no login, e não só ao abrir a aba,
     porque alerta que depende de alguém ir olhar não é alerta: o
     contador de eventos não tratados aparece sozinho, um instante
     depois da tela.

     Aqui morava a razão real deste `sem await`: cada rota de
     `/api/admin` conferia a senha com scrypt e custava ~830 ms, então
     três chamadas em fila somavam segundos e três em paralelo pediriam
     ~384 MiB de RAM. Com o token de sessão isso acabou (~25 µs por
     requisição), e o `sem await` sobrevive só pelo motivo do primeiro
     parágrafo. */
  carregarResumoWebhook().catch(() => { /* a aba Webhook mostra o erro quando for aberta */ });
}

/** Abre o painel com uma sessão que já existe. Não confere nada: quem
 *  confere é o servidor, na primeira requisição que `carregarTudo`
 *  fizer — e se ela voltar 401, `chamarAdmin` derruba de volta. */
async function abrirPainel(usuario) {
  limparErro('msg-login');
  $('rotulo-usuario').textContent = usuario ?? 'operador';
  $('tela-login').hidden = true;
  $('tela-painel').hidden = false;
  await carregarTudo();
}

async function tentarEntrar() {
  const usuario = $('admin-user').value.trim();
  const senha = $('admin-pass').value;
  if (!usuario || !senha) return;

  const botao = $('btn-entrar');
  const rotulo = botao.textContent;
  botao.disabled = true;
  /* O login é o ÚNICO lugar caro que sobrou — scrypt a N=2^17, de
     propósito, porque é a única barreira da API e segurança aqui vale
     mais que meio segundo. O que não pode é parecer travado: um botão
     desabilitado sem texto novo lê como bug, e o operador clica de novo. */
  botao.textContent = 'Entrando...';
  try {
    /* O único lugar do painel inteiro em que a senha trafega. Vai no
       corpo, não em cabeçalho: cabeçalho aparece em log de proxy com
       muito mais facilidade do que corpo de POST. */
    const sessao = await chamarApi('/api/admin/sessao', {
      method: 'POST',
      body: JSON.stringify({ usuario, senha })
    });

    // A senha morre aqui. Nem o storage nem o campo da tela ficam com ela.
    $('admin-pass').value = '';
    salvarSessao({ token: sessao.token, expiraEm: sessao.expiraEm, usuario });

    await abrirPainel(usuario);
  } catch (erro) {
    limparSessao();
    mostrarErro('msg-login', erro.message);
  } finally {
    botao.disabled = false;
    botao.textContent = rotulo;
  }
}

/** Volta para a tela de login e apaga a sessão. `motivo` aparece na
 *  tela quando a saída não foi escolhida pelo operador (token vencido,
 *  senha do admin trocada) — sem isso, a tela de login reaparecendo do
 *  nada parece bug. */
function encerrarSessao(motivo) {
  limparSessao();
  $('admin-pass').value = '';
  $('tela-painel').hidden = true;
  $('tela-login').hidden = false;
  if (motivo) mostrarErro('msg-login', motivo);
  else limparErro('msg-login');
}

function sair() {
  encerrarSessao();
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

/* Já tem token guardado nesta aba (sessionStorage) — pula direto pro
   painel, sem pedir senha de novo. Vencido pelo relógio local nem
   chega a tentar: apaga e mostra o login com a razão. */
const sessaoAberta = sessaoSalva();
if (sessaoAberta) {
  if (sessaoVencida(sessaoAberta)) encerrarSessao('Sessão expirada. Entre novamente.');
  else abrirPainel(sessaoAberta.usuario).catch(() => { /* o 401 já derrubou pro login em chamarAdmin */ });
}
