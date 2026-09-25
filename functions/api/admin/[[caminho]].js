/**
 * functions/api/admin/[[caminho]].js — Cloudflare Pages Function.
 *
 * O caminho do painel até a API administrativa, ATRÁS do Cloudflare Access
 * (SEC-015, 25/09/2026). O painel (`/admin`, no domínio do checkout) chama
 * `/api/admin/*` no PRÓPRIO domínio; o Access protege esse caminho e põe
 * na requisição o JWT de quem entrou (`Cf-Access-Jwt-Assertion`); esta
 * função repassa a chamada à API (`api.sancocore.com.br`), que confere o
 * JWT de novo na origem (`src/middlewares/exigirAccess.js`) — porque a
 * origem é alcançável por fora, e só ela pode ter a última palavra.
 *
 * Repassa SÓ o que a API do admin lê. O cookie do Access
 * (`CF_Authorization`) e qualquer outro cabeçalho do navegador ficam aqui.
 * Nenhum redirecionamento é seguido.
 */

const API = 'https://api.sancocore.com.br';
const CABECALHOS_QUE_PASSAM = ['content-type', 'accept', 'x-admin-token', 'cf-access-jwt-assertion'];
const CABECALHOS_QUE_VOLTAM = ['content-type'];
/* Acima do pior caso da API (a chamada à Asaas tem teto de 20 s), e com
   teto — `fetch` sem `signal` espera para sempre. */
const TIMEOUT_API_MS = 30_000;

const json = (status, corpo) => new Response(JSON.stringify(corpo), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export async function onRequest({ request }) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/admin/')) return json(404, { erro: 'Rota não encontrada.' });

  /* Sem o JWT, o Access não está na frente deste caminho (mal configurado,
     ou uma prévia fora da política): não repassa nada. A origem recusaria
     de qualquer jeito — recusar aqui é não gastar a ida. */
  if (!request.headers.get('cf-access-jwt-assertion')) {
    return json(403, { erro: 'O painel administrativo só abre pelo endereço protegido.', acessoRestrito: true });
  }

  const cabecalhos = new Headers();
  for (const nome of CABECALHOS_QUE_PASSAM) {
    const valor = request.headers.get(nome);
    if (valor !== null) cabecalhos.set(nome, valor);
  }

  const semCorpo = request.method === 'GET' || request.method === 'HEAD';
  const controlador = new AbortController();
  const teto = setTimeout(() => controlador.abort(), TIMEOUT_API_MS);
  let resposta;
  try {
    resposta = await fetch(`${API}${url.pathname}${url.search}`, {
      method: request.method,
      headers: cabecalhos,
      body: semCorpo ? undefined : await request.arrayBuffer(),
      redirect: 'manual',
      signal: controlador.signal
    });
  } catch {
    return json(502, { erro: 'A API administrativa não respondeu. Tente de novo em instantes.' });
  } finally {
    clearTimeout(teto);
  }

  const volta = new Headers({ 'cache-control': 'no-store' });
  for (const nome of CABECALHOS_QUE_VOLTAM) {
    const valor = resposta.headers.get(nome);
    if (valor !== null) volta.set(nome, valor);
  }
  if (resposta.status >= 300 && resposta.status < 400) return json(502, { erro: 'A API respondeu com um redirecionamento, que não é seguido.' });
  return new Response(resposta.body, { status: resposta.status, headers: volta });
}
