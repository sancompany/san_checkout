#!/usr/bin/env node
/**
 * tests/admin-so-pelo-access.js
 *
 * CLASSE CR-09 da remediação da Estação 6 (SEC-015): a API administrativa
 * fora do Cloudflare Access.
 *
 * O furo: `checkout.sancocore.com.br/admin` passava pelo Access, mas a API
 * que o painel chamava (`api.sancocore.com.br/api/admin/*`, e a origem da
 * Northflank) não — quem a protegia era só o login próprio. A lei do
 * projeto exige as duas camadas e manda fechar a origem.
 *
 * Aqui: a pilha HTTP de verdade (o `server.js` montado) com um Access de
 * mentira (`tests/access-de-teste.js`) — sem o JWT, NADA do admin
 * responde, nem a rota de login; com um JWT que não é do painel (outra
 * chave, outro aplicativo, vencido, `meta`), também não. E a função do
 * Pages que leva o painel até a API: não repassa sem JWT, não repassa
 * cookie, não segue redirecionamento.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let checagens = 0;
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };
const igual = (a, b, m) => { assert.deepEqual(a, b, m); checagens += 1; };

const { gerarHashSenha } = await import('../src/utils/senhaAdmin.js');
const USUARIO = 'operador-deste-teste';
const SENHA = 'senha-so-deste-processo';
process.env.CHECKOUT_SEM_LISTEN = '1';
process.env.CHECKOUT_ADMIN_USER = USUARIO;
process.env.CHECKOUT_ADMIN_PASS_HASH = await gerarHashSenha(SENHA);
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? 'teste';

const { subirAccessDeTeste } = await import('./access-de-teste.js');
const access = await subirAccessDeTeste();
const { app } = await import('../src/server.js');
const { criarExigirAccess } = await import('../src/middlewares/exigirAccess.js');

const servidor = app.listen(0);
await once(servidor, 'listening');
const base = `http://127.0.0.1:${servidor.address().port}`;
let ip = 0;
async function chamar(caminho, { metodo = 'GET', corpo, cabecalhos = {}, doIp = null } = {}) {
  ip += 1;
  const r = await fetch(base + caminho, {
    method: metodo,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': doIp ?? `198.51.100.${ip % 250}`, ...cabecalhos },
    body: corpo === undefined ? undefined : JSON.stringify(corpo)
  });
  let json = null;
  try { json = JSON.parse(await r.text()); } catch { json = null; }
  return { http: r.status, corpo: json };
}
const comJwt = (token) => ({ 'cf-access-jwt-assertion': token });

try {
  /* ---- controle positivo: pelo Access, a senha certa entra ---- */
  const login = await chamar('/api/admin/sessao', { metodo: 'POST', corpo: { usuario: USUARIO, senha: SENHA }, cabecalhos: comJwt(access.jwt()) });
  igual(login.http, 200, `controle: com o JWT do Access e a senha certa, o login funciona (${JSON.stringify(login.corpo)})`);
  const token = login.corpo?.token;
  ok(typeof token === 'string' && token.length > 20, 'e devolve o token de sessão');
  const lista = await chamar('/api/admin/contratantes', { cabecalhos: { ...comJwt(access.jwt()), 'X-Admin-Token': token } });
  ok(lista.http !== 401 && lista.http !== 403, `controle: com as duas camadas, o painel passa das guardas (${lista.http})`);

  /* ---- sem o JWT: nada do admin responde, nem o login ---- */
  const semAccessLogin = await chamar('/api/admin/sessao', { metodo: 'POST', corpo: { usuario: USUARIO, senha: SENHA } });
  igual([semAccessLogin.http, semAccessLogin.corpo?.acessoRestrito], [401, true], 'SEC-015: sem o JWT do Access, nem a SENHA CERTA entra — pelo domínio da API ou pela origem');
  const semAccessToken = await chamar('/api/admin/contratantes', { cabecalhos: { 'X-Admin-Token': token } });
  igual([semAccessToken.http, semAccessToken.corpo?.acessoRestrito], [401, true], 'SEC-015: nem um token de sessão válido serve sem o JWT');

  /* ---- JWTs que não são do painel ---- */
  const falsos = [
    ['assinado por outra chave', access.assinar({ aud: ['68d3d6ba08788001e497f765a0872491087dcf981c911665f3d77ac77558f4d0'], iss: 'https://fancy-dawn-740a.cloudflareaccess.com', type: 'app', email: 'x@y.z', exp: Math.floor(Date.now() / 1000) + 600 }, { chave: access.outraChave })],
    ['aud de outro aplicativo da equipe (o do MostrAí)', access.jwt({ aud: ['7120cda61ce638992a2af382565cf88867f5b95e7987155cf1f439b90c4ea1e3'] })],
    ['vencido', access.jwt({ exp: Math.floor(Date.now() / 1000) - 3600 })],
    ['type meta (o que o Access dá a qualquer visitante)', access.jwt({ type: 'meta' })],
    ['iss de outra equipe', access.jwt({ iss: 'https://atacante.cloudflareaccess.com' })],
    /* `alg: none` com assinatura NÃO vazia: o vazio a checagem de formato
       já barrava, e a de `alg` nunca era exercitada (sabotagem H9). */
    ['alg none com assinatura qualquer', (() => { const [, carga] = access.jwt().split('.'); return `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'kid-do-access-de-teste' })).toString('base64url')}.${carga}.AAAA`; })()],
    ['lixo', 'isto.nao.e-um-jwt']
  ];
  for (const [nome, jwt] of falsos) {
    const r = await chamar('/api/admin/sessao', { metodo: 'POST', corpo: { usuario: USUARIO, senha: SENHA }, cabecalhos: comJwt(jwt) });
    igual(r.http, 401, `SEC-015: JWT ${nome} é recusado`);
  }

  /* ---- TODAS as rotas do admin, não uma (lição nº 23) ---- */
  const rotas = [...readFileSync(join(RAIZ, 'src/routes/adminRoutes.js'), 'utf8').matchAll(/router\.(get|post|patch|put|delete)\('([^']+)'/g)];
  ok(rotas.length >= 14, `a varredura achou as rotas do admin (${rotas.length})`);
  for (const [, metodo, caminho] of rotas) {
    const r = await chamar(`/api/admin${caminho.replace(/:[^/]+/g, 'x')}`, { metodo: metodo.toUpperCase(), corpo: metodo === 'get' ? undefined : {}, cabecalhos: { 'X-Admin-Token': token } });
    igual([r.http, r.corpo?.acessoRestrito], [401, true], `SEC-015: ${metodo.toUpperCase()} /api/admin${caminho} sem Access é recusada — mesmo com token de sessão`);
  }
  const fonteRotas = readFileSync(join(RAIZ, 'src/routes/adminRoutes.js'), 'utf8');
  /* `indexOf` de uma linha que sumiu é -1, e -1 é menor que tudo: a
     primeira versão desta checagem passava com a guarda APAGADA
     (sabotagem H1, 25/09/2026). A posição só vale se a linha existe. */
  const posGuardaAccess = fonteRotas.indexOf('router.use(exigirAccess)');
  ok(posGuardaAccess >= 0 && posGuardaAccess < fonteRotas.indexOf("router.post('/sessao'"), 'a guarda do Access existe no roteador e vem ANTES de toda rota, inclusive a de login');

  /* ---- quem não tem o Access não gasta o teto de quem tem ----
     As chamadas do operador chegam do IP de saída da Cloudflare, o mesmo
     de qualquer Worker alheio no mesmo datacenter. Se o limitador de login
     (5/min) contasse as tentativas SEM Access, um Worker de outra conta
     trancaria o operador fora do painel. */
  const IP_DE_SAIDA_DA_CLOUDFLARE = '203.0.113.77';
  for (let i = 0; i < 8; i += 1) {
    const r = await chamar('/api/admin/sessao', { metodo: 'POST', corpo: { usuario: USUARIO, senha: 'chute' }, doIp: IP_DE_SAIDA_DA_CLOUDFLARE });
    igual(r.http, 401, `tentativa ${i + 1} sem Access, do IP compartilhado: 401 (não 429 — não chegou ao limitador)`);
  }
  const doOperador = await chamar('/api/admin/sessao', { metodo: 'POST', corpo: { usuario: USUARIO, senha: SENHA }, cabecalhos: comJwt(access.jwt()), doIp: IP_DE_SAIDA_DA_CLOUDFLARE });
  igual(doOperador.http, 200, `SEC-015: depois de 8 tentativas sem Access do MESMO IP, o operador ainda entra (${doOperador.http})`);
  /* controle positivo do limitador: ele continua existindo para quem PASSOU pelo Access */
  const ipDoControle = '203.0.113.78';
  const respostas = [];
  for (let i = 0; i < 6; i += 1) {
    respostas.push((await chamar('/api/admin/sessao', { metodo: 'POST', corpo: { usuario: USUARIO, senha: 'errada' }, cabecalhos: comJwt(access.jwt()), doIp: ipDoControle })).http);
  }
  igual(respostas.at(-1), 429, `controle: com o Access, a 6ª tentativa errada no minuto é barrada pelo limitador (${respostas.join(',')})`);
  const fonteServidor = readFileSync(join(RAIZ, 'src/server.js'), 'utf8');
  ok(fonteServidor.indexOf("app.use('/api/admin', exigirAccess)") > 0 &&
     fonteServidor.indexOf("app.use('/api/admin', exigirAccess)") < fonteServidor.indexOf("app.use('/api/admin/sessao', rateLimit("),
     'no server.js, a guarda do Access vem ANTES dos limitadores do admin');

  /* ---- o que não é admin não passa a exigir Access ---- */
  const saude = await chamar('/api/saude');
  ok(!saude.corpo?.acessoRestrito, 'a saúde continua pública');
  const webhook = await chamar('/api/webhooks/asaas', { metodo: 'POST', corpo: {} });
  ok(!webhook.corpo?.acessoRestrito && [401, 503].includes(webhook.http), 'o webhook da Asaas continua na guarda dele (token da Asaas), não na do Access');
} finally {
  servidor.close();
}

/* ---- o ROTEADOR do admin se protege sozinho ----
   O `server.js` também põe a guarda na frente (antes dos limitadores). O
   roteador não pode depender disso: montado em outro lugar, ou com a
   linha do `server.js` removida, ele continua recusando. Aqui ele sobe
   num app vazio, sem nada do `server.js`. */
{
  const express = (await import('express')).default;
  const { default: rotasAdmin } = await import('../src/routes/adminRoutes.js');
  const soOAdmin = express();
  soOAdmin.use(express.json());
  soOAdmin.use('/api/admin', rotasAdmin);
  const s2 = soOAdmin.listen(0);
  await once(s2, 'listening');
  const base2 = `http://127.0.0.1:${s2.address().port}`;
  try {
    for (const [metodo, caminho] of [['POST', '/api/admin/sessao'], ['GET', '/api/admin/contratantes'], ['GET', '/api/admin/erros']]) {
      const r = await fetch(base2 + caminho, { method: metodo, headers: { 'content-type': 'application/json' }, body: metodo === 'POST' ? JSON.stringify({ usuario: USUARIO, senha: SENHA }) : undefined });
      const corpo = await r.json().catch(() => null);
      igual([r.status, corpo?.acessoRestrito], [401, true], `o roteador SOZINHO recusa ${metodo} ${caminho} sem o Access (não depende do server.js)`);
    }
    const comAccess = await fetch(base2 + '/api/admin/sessao', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': access.jwt() }, body: JSON.stringify({ usuario: USUARIO, senha: SENHA }) });
    igual(comAccess.status, 200, 'controle: com o Access, o mesmo roteador sozinho abre a sessão');
  } finally {
    s2.close();
  }
}

/* ---- chaves indisponíveis: 503, nunca "passa" ---- */
{
  const exigir = criarExigirAccess({ buscarChaves: async () => { throw new Error('certs fora do ar'); } });
  const res = { _s: null, _j: null, status(c) { this._s = c; return this; }, json(o) { this._j = o; return this; } };
  let passou = false;
  const erroOriginal = console.error; console.error = () => {};
  try {
    await exigir({ get: () => access.jwt(), method: 'GET', path: '/x' }, res, () => { passou = true; });
  } finally { console.error = erroOriginal; }
  igual([res._s, passou], [503, false], 'sem as chaves do Access, 503 — "não consegui conferir" nunca vira acesso');
}

/* ---- a URL das chaves não troca para fora do loopback ----
   Com `CF_ACCESS_CERTS_URL` num https qualquer, quem controlasse aquele
   servidor assinaria os próprios JWTs. Só o servidor local das suítes. */
{
  const original = process.env.CF_ACCESS_CERTS_URL;
  const erroOriginal = console.error;
  let logado = [];
  console.error = (...partes) => { logado.push(partes.join(' ')); };
  try {
    for (const alvo of ['https://chaves.atacante.exemplo/cdn-cgi/access/certs', 'http://10.0.0.5/certs', 'https://127.0.0.1.nip.io/certs']) {
      process.env.CF_ACCESS_CERTS_URL = alvo;
      logado = [];
      /* Nenhuma ida à rede: um `fetch` que chegasse a sair provaria que a
         URL foi USADA — que é a sabotagem H11, cujo 503 vinha da falha de
         rede e passava por este mesmo teste. */
      const fetchOriginal = globalThis.fetch;
      let foiARede = false;
      globalThis.fetch = async () => { foiARede = true; throw new Error('rede'); };
      const exigir = criarExigirAccess();
      const res = { _s: null, status(c) { this._s = c; return this; }, json() { return this; } };
      let passou = false;
      try {
        await exigir({ get: () => access.jwt(), method: 'GET', path: '/x', baseUrl: '/api/admin' }, res, () => { passou = true; });
      } finally {
        globalThis.fetch = fetchOriginal;
      }
      igual([res._s, passou, foiARede], [503, false, false], `CF_ACCESS_CERTS_URL=${alvo} é recusado (503) SEM ser buscado`);
      ok(logado.some((l) => l.includes('só aceita o servidor local')), `e o log diz por quê (${logado.join(' | ').slice(0, 120)})`);
    }
    process.env.CF_ACCESS_CERTS_URL = original;
    const exigir = criarExigirAccess();
    let passou = false;
    await exigir({ get: () => access.jwt(), method: 'GET', path: '/x', baseUrl: '/api/admin' }, { status() { return this; }, json() { return this; } }, () => { passou = true; });
    ok(passou, 'controle: com o servidor local das suítes, a mesma instância nova passa');
  } finally {
    console.error = erroOriginal;
    process.env.CF_ACCESS_CERTS_URL = original;
  }
}

/* ---- a função do Pages que leva o painel até a API ---- */
{
  const { onRequest } = await import('../functions/api/admin/[[caminho]].js');
  const chamadas = [];
  const fetchOriginal = globalThis.fetch;
  let resposta = () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'intruso=1' } });
  globalThis.fetch = async (url, opcoes) => { chamadas.push({ url: String(url), opcoes }); return resposta(); };
  try {
    let r = await onRequest({ request: new Request('https://checkout.sancocore.com.br/api/admin/contratantes', { headers: { 'x-admin-token': 't' } }) });
    igual([r.status, chamadas.length], [403, 0], 'função: sem o JWT do Access, não repassa nada');

    r = await onRequest({ request: new Request('https://checkout.sancocore.com.br/api/admin/contratantes?limite=5', {
      method: 'GET',
      headers: { 'cf-access-jwt-assertion': 'jwt-do-access', 'x-admin-token': 'tok', cookie: 'CF_Authorization=segredo-do-access', 'x-forwarded-for': '203.0.113.9', 'user-agent': 'navegador' }
    }) });
    igual(r.status, 200, 'função: com o JWT, repassa');
    igual(chamadas[0].url, 'https://api.sancocore.com.br/api/admin/contratantes?limite=5', 'para a API, no mesmo caminho e consulta');
    const repassados = [...chamadas[0].opcoes.headers.keys()].sort();
    igual(repassados, ['cf-access-jwt-assertion', 'x-admin-token'], 'só o JWT e o token de sessão seguem — o cookie do Access, o IP e o resto ficam');
    igual(chamadas[0].opcoes.redirect, 'manual', 'e nenhum redirecionamento é seguido');
    ok(!r.headers.get('set-cookie'), 'nenhum cookie da API volta ao navegador');
    igual(r.headers.get('cache-control'), 'no-store');

    chamadas.length = 0;
    r = await onRequest({ request: new Request('https://checkout.sancocore.com.br/api/admin/sessao', { method: 'POST', body: '{"usuario":"u","senha":"s"}', headers: { 'cf-access-jwt-assertion': 'j', 'content-type': 'application/json' } }) });
    igual(new TextDecoder().decode(chamadas[0].opcoes.body), '{"usuario":"u","senha":"s"}', 'o corpo do POST vai inteiro');
    igual(chamadas[0].opcoes.method, 'POST');

    resposta = () => new Response(null, { status: 302, headers: { location: 'https://outro.lugar/' } });
    r = await onRequest({ request: new Request('https://checkout.sancocore.com.br/api/admin/contratantes', { headers: { 'cf-access-jwt-assertion': 'j' } }) });
    igual(r.status, 502, 'redirecionamento da API não é devolvido nem seguido');

    chamadas.length = 0;
    r = await onRequest({ request: new Request('https://checkout.sancocore.com.br/api/checkout/pix/x/y', { headers: { 'cf-access-jwt-assertion': 'j' } }) });
    igual([r.status, chamadas.length], [404, 0], 'a função só atende /api/admin/*');

    globalThis.fetch = async (url, opcoes) => { chamadas.push({ url: String(url), opcoes }); throw new Error('conexão recusada'); };
    r = await onRequest({ request: new Request('https://checkout.sancocore.com.br/api/admin/contratantes', { headers: { 'cf-access-jwt-assertion': 'j' } }) });
    igual(r.status, 502, 'API fora do ar: 502 em JSON, não a página de erro da Cloudflare');
    ok(chamadas.at(-1).opcoes.signal instanceof AbortSignal, 'e a ida à API tem teto (signal)');
  } finally {
    globalThis.fetch = fetchOriginal;
  }
}

/* ---- o painel chama pelo PRÓPRIO domínio ---- */
{
  const fonte = readFileSync(join(RAIZ, 'public/js/utils/api.js'), 'utf8');
  ok(/caminho\.startsWith\('\/api\/admin\/'\) \? '' : URL_BASE/.test(fonte), 'em produção, /api/admin/* vai pelo domínio do painel (a função atrás do Access), não pelo da API');
}

access.fechar();
console.log(`admin-so-pelo-access: ${checagens} checagens OK`);
