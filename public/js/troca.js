/**
 * public/js/troca.js
 * A tela de aprovação de troca de plano — `troca.html#t=<token>`.
 *
 * `docs/specs/2026-09-20-troca-de-plano-redireciona-pagador.md`:
 *
 *   - o token vem no FRAGMENTO da URL (nunca query string — fragmento
 *     não viaja para o servidor em log de acesso, proxy nem `Referer`),
 *     é lido UMA VEZ e a barra de endereço é limpa na hora
 *     (`history.replaceState`);
 *   - o token fica só EM MEMÓRIA (uma variável de módulo) — nunca em
 *     `sessionStorage`/`localStorage`. Este domínio carrega o Web
 *     Analytics da Cloudflare, terceiro não auditado quanto a acesso a
 *     storage (`.ia/INTEGRATIONS.md`), e mesmo sem ele a persistência
 *     entre abas/sessão não tem benefício aqui — recarregar a página
 *     perde o token por desenho, e a tela mostra estado neutro;
 *   - a tela NUNCA deixa escolher plano — só aprova o valor exato que o
 *     contratante já calculou.
 */

import { post } from './utils/api.js';

const $ = (id) => document.getElementById(id);

/** Só em memória — nunca storage. Perdido no reload, de propósito. */
let token = null;

function mostrarToast(mensagem, tipo = 'info') {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = mensagem;
  if (tipo === 'erro') toast.style.borderColor = 'var(--status-error)';
  if (tipo === 'sucesso') toast.style.borderColor = 'var(--status-success)';
  $('toast-container').appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}

/* Mesma regra das outras telas do checkout (`status.js`, `app.js`):
   valor que não dá para formatar vira travessão, NUNCA "R$ 0,00" —
   "não sei" não pode virar "zero" numa tela de dinheiro. */
function formatarMoeda(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return null;
  return numero.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function reais(valor) {
  const formatado = formatarMoeda(valor);
  return formatado === null ? 'R$ —' : `R$ ${formatado}`;
}

const BLOCOS = ['bloco-esqueleto', 'bloco-erro', 'bloco-concluido', 'bloco-pendente', 'bloco-processando'];
function mostrarBloco(id) {
  for (const bloco of BLOCOS) $(bloco).classList.toggle('hidden', bloco !== id);
}

function mostrarErro(titulo, texto, selo = 'Não disponível') {
  $('erro-selo').textContent = selo;
  $('erro-titulo').textContent = titulo;
  $('erro-texto').textContent = texto;
  mostrarBloco('bloco-erro');
}

/** As quatro respostas negativas de `/troca/contexto` e `/troca/aprovar`
 *  (`trocaAprovacaoController.js`) — o texto é escrito pra quem nunca
 *  viu "STALE" nem "CAS" na vida. */
function mostrarErroPorCodigo(erro) {
  const codigo = erro?.corpo?.code;
  if (codigo === 'PLAN_CHANGE_EXPIRED' || erro?.status === 410) {
    mostrarErro('Link expirado', 'Este link de aprovação venceu. Peça um novo à loja onde você assina.', 'Expirado');
    return;
  }
  if (codigo === 'PLAN_CHANGE_STALE' || erro?.status === 409) {
    mostrarErro('Link desatualizado', 'Algo mudou na sua assinatura desde que este link foi criado. Peça um novo à loja.', 'Desatualizado');
    return;
  }
  if (codigo === 'PLAN_CHANGE_DECLINED' || erro?.status === 402) {
    mostrarErro('Pagamento não aprovado', 'O cartão salvo recusou a cobrança do acerto. Sua assinatura continua no plano atual — fale com a loja para tentar de novo.', 'Recusado');
    return;
  }
  if (erro?.status === 404) {
    mostrarErro('Link inválido', 'Confira se o link está completo. Se ele veio de um e-mail ou mensagem, peça um novo à loja.', 'Não encontrado');
    return;
  }
  mostrarErro('Não foi possível carregar', 'Tente recarregar a página em alguns instantes.', 'Erro');
}

function mostrarPendente(dados) {
  const credito = Number(dados.credito) || 0;
  const debito = Number(dados.debito) || 0;

  $('texto-pendente').textContent =
    `Você está trocando de "${dados.planoNome}" para "${dados.planoNovoNome}". ` +
    `Isto NÃO altera seu método de pagamento nem escolhe outro plano — só aprova o valor abaixo.`;
  $('resumo-credito').textContent = `− ${reais(credito)}`;
  $('resumo-debito').textContent = `${dados.diasRestantes} dia(s) · ${dados.cicloNovo}`;
  $('resumo-total').textContent = reais(dados.valorAcerto);
  $('btn-aprovar').textContent = `Aprovar cobrança de ${reais(dados.valorAcerto)}`;
  $('btn-aprovar').disabled = false;

  if (dados.expiresAt) {
    const minutos = Math.max(0, Math.round((new Date(dados.expiresAt).getTime() - Date.now()) / 60000));
    $('aviso-expira').textContent = minutos > 0
      ? `Este link expira em cerca de ${minutos} minuto(s).`
      : 'Este link está prestes a expirar.';
  }

  mostrarBloco('bloco-pendente');
}

function mostrarConcluido(dados) {
  $('texto-concluido').textContent = dados?.planoNovoNome
    ? `Você agora está no plano "${dados.planoNovoNome}".`
    : 'A troca de plano foi confirmada.';
  mostrarBloco('bloco-concluido');
}

/** Poll enquanto o veredito não fecha (`PROCESSING_PAYMENT`/
 *  `PAYMENT_UNKNOWN`/`RECONCILIATION_REQUIRED` — tudo que
 *  `/troca/aprovar` devolve como `202`). Curto (3s): a cobrança em si é
 *  síncrona na maioria dos casos, isto só cobre o raro caso ambíguo. */
const INTERVALO_POLL_MS = 3000;

async function aprovar() {
  $('btn-aprovar').disabled = true;
  mostrarBloco('bloco-processando');

  try {
    const dados = await post('/api/checkout/troca/aprovar', { token });
    if (dados.status === 'COMPLETED') {
      mostrarConcluido(dados);
      mostrarToast('Troca de plano confirmada!', 'sucesso');
      return;
    }
    // 202: ainda processando — poll.
    setTimeout(aprovar, INTERVALO_POLL_MS);
  } catch (erro) {
    mostrarErroPorCodigo(erro);
  }
}

function lerTokenDoFragmento() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const lido = params.get('t');

  // Limpa a barra de endereço IMEDIATAMENTE — o token não pode
  // sobreviver no histórico do navegador, em favoritos, nem ser
  // reenviado se esta página algum dia carregar outro recurso que leia
  // a URL inteira.
  if (lido) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return lido;
}

async function iniciar() {
  token = lerTokenDoFragmento();

  if (!token) {
    mostrarErro('Link incompleto', 'Este link não traz o que identifica a troca. Abra o link completo que a loja enviou.', 'Não encontrado');
    return;
  }

  $('btn-aprovar').addEventListener('click', aprovar);

  try {
    const dados = await post('/api/checkout/troca/contexto', { token });
    if (dados.status === 'PENDING_APPROVAL') mostrarPendente(dados);
    else if (dados.status === 'COMPLETED') mostrarConcluido(dados);
    else mostrarBloco('bloco-processando'); // 202: já em processamento (aberto de novo enquanto ambíguo)
  } catch (erro) {
    mostrarErroPorCodigo(erro);
  }
}

iniciar();
