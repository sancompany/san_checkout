/**
 * public/js/admin.js
 * Extraído do <script type="module"> inline de admin.html — precisa
 * ser arquivo externo pra script-src 'self' da CSP (public/_headers)
 * funcionar sem 'unsafe-inline'.
 */
import { chamarApi } from './utils/api.js';

const CHAVE_SESSAO = 'san-checkout-admin-login';

function loginSalvo() {
  try { return JSON.parse(sessionStorage.getItem(CHAVE_SESSAO)); } catch { return null; }
}

function salvarLogin(usuario, senha) {
  try { sessionStorage.setItem(CHAVE_SESSAO, JSON.stringify({ usuario, senha })); } catch { /* navegador bloqueou — segue sem persistir */ }
}

function headersAuth() {
  const login = loginSalvo();
  return { 'X-Admin-User': login?.usuario ?? '', 'X-Admin-Pass': login?.senha ?? '' };
}

const admin = {
  get: (caminho) => chamarApi(`/api/admin${caminho}`, { method: 'GET', headers: headersAuth() }),
  post: (caminho, dados) => chamarApi(`/api/admin${caminho}`, { method: 'POST', body: JSON.stringify(dados), headers: headersAuth() })
};

function escapar(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

async function carregarLista() {
  const contratantes = await admin.get('/contratantes');
  document.getElementById('tabela-contratantes').innerHTML = contratantes.map((c) => `
    <tr>
      <td>${escapar(c.id)}</td>
      <td>${escapar(c.nome)}</td>
      <td>${escapar(c.api_base_url)}</td>
      <td>${escapar(c.webhook_url ?? '—')}</td>
      <td>${escapar(c.wallet_id ?? '—')}</td>
      <td><code>${escapar(c.api_key)}</code></td>
    </tr>
  `).join('');
}

async function tentarEntrar(usuarioForcado, senhaForcada) {
  const usuario = usuarioForcado ?? document.getElementById('admin-user').value.trim();
  const senha = senhaForcada ?? document.getElementById('admin-pass').value;
  if (!usuario || !senha) return;
  salvarLogin(usuario, senha);
  const msgLogin = document.getElementById('msg-login');
  try {
    await carregarLista();
    msgLogin.hidden = true;
    document.getElementById('painel-login').hidden = true;
    document.getElementById('painel-app').hidden = false;
  } catch (erro) {
    msgLogin.textContent = erro.message;
    msgLogin.hidden = false;
  }
}

async function cadastrar() {
  const corpo = {
    id: document.getElementById('f-id').value.trim(),
    nome: document.getElementById('f-nome').value.trim(),
    apiBaseUrl: document.getElementById('f-api-base-url').value.trim(),
    webhookUrl: document.getElementById('f-webhook-url').value.trim(),
    walletId: document.getElementById('f-wallet-id').value.trim()
  };
  const msg = document.getElementById('msg-cadastro');
  try {
    await admin.post('/contratantes', corpo);
    msg.className = 'msg ok';
    msg.textContent = 'Contratante cadastrado.';
    msg.hidden = false;
    ['f-id', 'f-nome', 'f-api-base-url', 'f-webhook-url', 'f-wallet-id'].forEach((id) => { document.getElementById(id).value = ''; });
    await carregarLista();
  } catch (erro) {
    msg.className = 'msg erro';
    msg.textContent = erro.message;
    msg.hidden = false;
  }
}

document.getElementById('btn-entrar').addEventListener('click', () => tentarEntrar());
document.getElementById('admin-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') tentarEntrar(); });
document.getElementById('btn-cadastrar').addEventListener('click', cadastrar);

// já tem login guardado nesta aba (sessionStorage) — pula direto pro painel
const login = loginSalvo();
if (login) tentarEntrar(login.usuario, login.senha);
