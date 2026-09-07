const URL_BASE = window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1')
  ? 'http://localhost:3001'
  : '';

export async function chamarApi(caminho, opcoes = {}) {
  const { headers, ...resto } = opcoes;
  const resposta = await fetch(`${URL_BASE}${caminho}`, {
    ...resto,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) }
  });

  const corpo = await resposta.json().catch(() => ({}));

  if (!resposta.ok) {
    const erro = new Error(corpo.erro || `O servidor respondeu ${resposta.status}.`);
    erro.status = resposta.status;
    erro.corpo = corpo;
    throw erro;
  }

  return corpo;
}

export const post = (caminho, dados) => chamarApi(caminho, { method: 'POST', body: JSON.stringify(dados) });
export const get = (caminho) => chamarApi(caminho, { method: 'GET' });
