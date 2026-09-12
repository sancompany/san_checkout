/**
 * O backend mora num domínio nosso, e não no domínio da hospedagem, de
 * propósito: trocar de host passa a ser trocar um CNAME, sem mexer aqui,
 * sem republicar o front e — o que importa de verdade — sem reconfigurar
 * o webhook no painel da Asaas, onde errar significa 15 falhas seguidas
 * e a fila pausada.
 *
 * Foi o que permitiu sair do Render (Oregon) para o Northflank (São
 * Paulo) em 12/09/2026 sem tocar na Asaas. Este endereço não muda de
 * novo; muda para onde o DNS aponta.
 */
const URL_BASE = window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1')
  ? 'http://localhost:3001'
  : 'https://api.sancocore.com.br';

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
