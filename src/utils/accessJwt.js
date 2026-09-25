/**
 * SAN CHECKOUT v2 — src/utils/accessJwt.js
 *
 * O JWT do Cloudflare Access (SEC-015, 25/09/2026).
 *
 * A API administrativa (`/api/admin/*`) morava em `api.sancocore.com.br`,
 * que é DNS-only — fora do Cloudflare Access —, e também respondia pela
 * origem da Northflank. Quem a protegia era só o login próprio. A lei do
 * projeto (skill `seguranca-san`, "Área administrativa: Cloudflare Access
 * na frente, sempre") exige as DUAS camadas, e diz que a origem alcançável
 * por fora é a barreira inteira contornada — "fechar a origem (…segredo
 * exigido na origem) é parte da tarefa".
 *
 * O segredo exigido na origem é este JWT: o Access o põe em toda
 * requisição que ele deixou passar (`Cf-Access-Jwt-Assertion`), assinado
 * com a chave da equipe (RS256), e só ele o emite. O painel fala com
 * `/api/admin` pelo MESMO domínio dele (a função do Pages
 * `functions/api/admin/[[caminho]].js`, atrás do Access), e a origem
 * recusa qualquer chamada administrativa sem um JWT válido — pelo domínio
 * da API ou pelo da Northflank, tanto faz.
 *
 * Conferido aqui, nesta ordem, e recusado ao primeiro que falhar:
 *   1. formato (três partes base64url, JSON nas duas primeiras);
 *   2. `alg` RS256 e nada mais (`none` e HS256 são os ataques clássicos);
 *   3. `kid` de uma chave da equipe;
 *   4. assinatura;
 *   5. `aud` do aplicativo do painel (outro aplicativo da mesma equipe não serve);
 *   6. `iss` da equipe;
 *   7. `type: app` (o `meta` que o Access entrega a qualquer visitante NÃO é credencial);
 *   8. validade (`exp`, `nbf`, com 60 s de folga de relógio);
 *   9. `email` presente — é quem entrou.
 */

import { createPublicKey, verify } from 'node:crypto';

/** A equipe e o aplicativo do painel (`CONSTRAINTS.md` §2.6). Não são
 *  segredo: identificam, não autorizam. E são constantes, NÃO variáveis de
 *  ambiente, de propósito: um `aud` trocado por configuração abriria o
 *  painel a quem passa pela política de OUTRO aplicativo da equipe (o do
 *  MostrAí, por exemplo). Aplicativo do Access recriado muda aqui, em
 *  código revisado — `RUNBOOK.md` §5. */
export const EQUIPE_ACCESS = 'https://fancy-dawn-740a.cloudflareaccess.com';
export const AUD_DO_PAINEL = '68d3d6ba08788001e497f765a0872491087dcf981c911665f3d77ac77558f4d0';
const FOLGA_DE_RELOGIO_S = 60;

const deBase64Url = (texto) => Buffer.from(String(texto).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Valor do token (de quem chamou) posto num motivo de log: só texto
 *  curto de caracteres comuns — nunca quebra de linha forjando uma linha
 *  nossa, nunca um objeto que lança ao virar texto (C1-01). */
const paraOLog = (valor) => (typeof valor === 'string' ? valor.replace(/[^\w.:-]/g, '?').slice(0, 20) : typeof valor);

/** As três partes do JWT, ou `null` se não tiver a forma de um. */
export function decodificarJwt(token) {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const partes = token.split('.');
  if (partes.length !== 3 || partes.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  try {
    const cabecalho = JSON.parse(deBase64Url(partes[0]).toString('utf8'));
    const carga = JSON.parse(deBase64Url(partes[1]).toString('utf8'));
    if (!cabecalho || typeof cabecalho !== 'object' || !carga || typeof carga !== 'object') return null;
    /* `alg` e `kid` são texto, ou o token não tem a forma de um JWT. Um
       `alg` objeto (`{"toString":0}`) lançava `TypeError` na primeira
       interpolação — antes da assinatura, sem login, e derrubando o
       processo (C1-01). */
    if (typeof cabecalho.alg !== 'string' || (cabecalho.kid !== undefined && typeof cabecalho.kid !== 'string')) return null;
    return { cabecalho, carga, assinado: `${partes[0]}.${partes[1]}`, assinatura: deBase64Url(partes[2]) };
  } catch {
    return null;
  }
}

/** A assinatura RS256 confere com alguma chave do JWKS (pelo `kid`)? */
export function assinaturaConfere(jwt, jwks) {
  if (!jwt || jwt.cabecalho.alg !== 'RS256' || typeof jwt.cabecalho.kid !== 'string') return false;
  const chave = (jwks?.keys ?? []).find((k) => k?.kid === jwt.cabecalho.kid && k?.kty === 'RSA');
  if (!chave) return false;
  try {
    const publica = createPublicKey({ key: { kty: 'RSA', n: chave.n, e: chave.e }, format: 'jwk' });
    return verify('RSA-SHA256', Buffer.from(jwt.assinado), publica, jwt.assinatura);
  } catch {
    return false;
  }
}

/**
 * O veredito sobre um JWT do Access. `{ valido: true, email }` ou
 * `{ valido: false, motivo }` — o motivo é para o LOG, nunca para quem chamou.
 */
export function verificarJwtDoAccess(token, { jwks, aud = AUD_DO_PAINEL, equipe = EQUIPE_ACCESS, agora = Date.now() } = {}) {
  const jwt = decodificarJwt(token);
  if (!jwt) return { valido: false, motivo: 'formato' };
  if (jwt.cabecalho.alg !== 'RS256') return { valido: false, motivo: `alg ${paraOLog(jwt.cabecalho.alg)}` };
  if (!assinaturaConfere(jwt, jwks)) return { valido: false, motivo: 'assinatura' };
  const c = jwt.carga;
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!auds.includes(aud)) return { valido: false, motivo: 'aud' };
  if (c.iss !== equipe) return { valido: false, motivo: 'iss' };
  if (c.type !== 'app') return { valido: false, motivo: `type ${paraOLog(c.type)}` };
  const segundos = Math.floor(agora / 1000);
  if (!Number.isFinite(c.exp) || c.exp + FOLGA_DE_RELOGIO_S < segundos) return { valido: false, motivo: 'vencido' };
  if (Number.isFinite(c.nbf) && c.nbf - FOLGA_DE_RELOGIO_S > segundos) return { valido: false, motivo: 'ainda não vale' };
  if (typeof c.email !== 'string' || !c.email.includes('@')) return { valido: false, motivo: 'sem email' };
  return { valido: true, email: c.email };
}

/**
 * As chaves da equipe, com cache. Busca de novo quando o `kid` pedido não
 * está no cache (o Access roda as chaves) — no máximo uma vez a cada
 * `intervaloMinimoMs`, para um token forjado com `kid` inventado não virar
 * uma requisição à Cloudflare por chamada.
 */
export function criarBuscadorDeChaves({ url = `${EQUIPE_ACCESS}/cdn-cgi/access/certs`, fetch = (...a) => globalThis.fetch(...a), ttlMs = 3600_000, intervaloMinimoMs = 60_000, agora = () => Date.now(), timeoutMs = 5000, velhoServeAteMs = 24 * 3600_000 } = {}) {
  let cache = null; let buscadoEm = -Infinity; let tentadoEm = -Infinity; let emVoo = null;
  /* C1-15: uma busca por vez (as requisições simultâneas esperam a mesma);
     depois de uma FALHA, o intervalo mínimo vale também — a queda da
     Cloudflare não vira uma busca por token forjado; e durante a queda as
     chaves já conhecidas continuam valendo por até `velhoServeAteMs` (a
     Cloudflare roda chaves com sobreposição), em vez de 503 no painel
     inteiro no minuto em que o cache vence. */
  async function buscar() {
    tentadoEm = agora();
    const controlador = new AbortController();
    const teto = setTimeout(() => controlador.abort(), timeoutMs);
    try {
      const resposta = await fetch(url, { signal: controlador.signal, redirect: 'error' });
      if (!resposta.ok) throw new Error(`certs do Access responderam ${resposta.status}`);
      const corpo = await resposta.json();
      if (!Array.isArray(corpo?.keys)) throw new Error('certs do Access sem `keys`');
      cache = { keys: corpo.keys }; buscadoEm = agora();
      return cache;
    } finally {
      clearTimeout(teto);
    }
  }
  return async function chavesPara(kid) {
    const temKid = cache?.keys?.some((k) => k.kid === kid);
    const vencido = agora() - buscadoEm > ttlMs;
    const podeBuscar = agora() - Math.max(buscadoEm, tentadoEm) > intervaloMinimoMs;
    if (cache && !vencido && (temKid || !podeBuscar)) return cache;
    const serveVelho = () => (cache && agora() - buscadoEm <= velhoServeAteMs ? cache : null);
    if (!podeBuscar && !emVoo) {
      const velho = serveVelho();
      if (velho) return velho;
      if (!cache) throw new Error('certs do Access indisponíveis (última tentativa falhou há pouco)');
    }
    emVoo ??= buscar().finally(() => { emVoo = null; });
    try {
      return await emVoo;
    } catch (erro) {
      const velho = serveVelho();
      if (velho) return velho;
      throw erro;
    }
  };
}

/* ------------------------------------------------------------------
   Autoteste — `node src/utils/accessJwt.js`
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('accessJwt.js')) {
  const { strict: assert } = await import('node:assert');
  const { generateKeyPairSync, createSign } = await import('node:crypto');
  let checagens = 0;
  const ok = (c, m) => { assert.ok(c, m); checagens += 1; };

  /* Material PÚBLICO da Cloudflare, capturado em 25/09/2026 para o controle positivo offline:
     a chave de assinatura do Access da equipe (de `/cdn-cgi/access/certs`, que qualquer um lê) e um
     token `meta` que o Access entrega a qualquer visitante no redirecionamento para o login. O token
     não dá acesso a nada (é `type: meta`, e já venceu) — serve só para provar que a verificação RS256
     daqui aceita uma assinatura DE VERDADE da Cloudflare, e não só as que o próprio teste fabrica. */
  const CHAVE_REAL_DO_ACCESS = {"kid": "28fb9540768dd6d6cd80b78f7b6c61322d5be548aa70f4550e5f039326ae17a0", "kty": "RSA", "alg": "RS256", "use": "sig", "e": "AQAB", "n": "nj1kmXXFwpSuOnuG05a2nYv_m5ZyMZhctkfV4A4liJx94pvqr0w-v7bxvteLooAQ7SpqvcHTTxpl1jMZOPa7NqbFYd9wtqvObacpe_gD8GwoJUo94RaxXkGiao6s52IglwkauLs-vD-AhJIiC3MkduYxtH80VnM27CNlHrn-XAfBH45D9fojcuZamjFUq3q_Ani3uZM4D2TVseaXx2tvVFiLuxPZg5JxQCuHd0sXCQMDhzfJrI78UgI5wTmZZ7VzVV6STnZe1S6yXXSF27phzXvEuEVWSMjaT4HIv0J_pxClIFyvVQIxNK0CgFzZc7UWvvKe0olxEsMz3jQkQCD8hQ"};
  const TOKEN_META_REAL = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImtpZCI6IjI4ZmI5NTQwNzY4ZGQ2ZDZjZDgwYjc4ZjdiNmM2MTMyMmQ1YmU1NDhhYTcwZjQ1NTBlNWYwMzkzMjZhZTE3YTAifQ.eyJ0eXBlIjoibWV0YSIsImF1ZCI6IjY4ZDNkNmJhMDg3ODgwMDFlNDk3Zjc2NWEwODcyNDkxMDg3ZGNmOTgxYzkxMTY2NWYzZDc3YWM3NzU1OGY0ZDAiLCJob3N0bmFtZSI6ImNoZWNrb3V0LnNhbmNvY29yZS5jb20uYnIiLCJyZWRpcmVjdF91cmwiOiIvYWRtaW4iLCJzZXJ2aWNlX3Rva2VuX3N0YXR1cyI6ZmFsc2UsImlzX3dhcnAiOmZhbHNlLCJpc19nYXRld2F5IjpmYWxzZSwiZXhwIjoxNzkwMzI2NTg3LCJuYmYiOjE3OTAzMjYyODcsImlhdCI6MTc5MDMyNjI4NywiYXV0aF9zdGF0dXMiOiJOT05FIiwibXRsc19hdXRoIjp7ImNlcnRfaXNzdWVyX2RuIjoiIiwiY2VydF9zZXJpYWwiOiIiLCJjZXJ0X2lzc3Vlcl9za2kiOiIiLCJjZXJ0X3ByZXNlbnRlZCI6ZmFsc2UsImNvbW1vbl9uYW1lIjoiIiwiYXV0aF9zdGF0dXMiOiJOT05FIn0sInJlYWxfY291bnRyeSI6IlVTIiwiYXBwX3Nlc3Npb25faGFzaCI6Ijc1YmIyNzk2N2RhZDExZDliNTA0ZTJiNTg3NWQzOTAzYWI0ODkzYWNmNmZlYTljYmRjN2I3YjU4NmRiNjNmMjQifQ.Mh4fSJBDI1rcahjxsm5Hex_LVoT49olRyDX3XTcKLYQyN_sOSNJi9GlI8g1OEeyZFVUEPgjKM91GNDaKyGv33I0ZH0IHJnm_eN1ZH_6UD5YTc1au_yUAfbLaCcj1dDRfAftZUbbhmCBStzGiz7t04aDVX9adICApOhx3uw5O2NTYtOQXZsqaJEG8z5mtd0o9M-gCrPFyonbDpOIrgLcyK4GYJT2qgKAASUf8MOjfT-JqnXlSKt2rydXizu8K407dJBOUG-LrRm_SuwrpSYJ6ucS_i7UNTxm-keF3hM_3NlSpIVN8yGNoEzRTLo5jMJFG57NB2nX1ihmads_rNz8mUA'; // gitleaks:allow — token `meta` público da Cloudflare, vencido, não dá acesso a nada
  /* ---- controle positivo com material REAL da Cloudflare ---- */
  const real = decodificarJwt(TOKEN_META_REAL);
  ok(real && real.cabecalho.alg === 'RS256', 'o token meta real tem a forma de um JWT RS256');
  ok(assinaturaConfere(real, { keys: [CHAVE_REAL_DO_ACCESS] }), 'CONTROLE POSITIVO: a verificação daqui aceita uma assinatura DE VERDADE da Cloudflare');
  const adulterado = { ...real, assinado: real.assinado.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) };
  ok(!assinaturaConfere(adulterado, { keys: [CHAVE_REAL_DO_ACCESS] }), 'e recusa o mesmo token com um caractere trocado');
  const r = verificarJwtDoAccess(TOKEN_META_REAL, { jwks: { keys: [CHAVE_REAL_DO_ACCESS] }, agora: real.carga.iat * 1000 });
  ok(!r.valido && /iss|type/.test(r.motivo), `o token META (que o Access entrega a qualquer visitante) NÃO é credencial (${r.motivo})`);

  /* ---- chaves de teste: o que a Cloudflare assinaria ---- */
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'kid-teste', alg: 'RS256' };
  const jwks = { keys: [jwk] };
  const outra = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const assinar = (carga, { cabecalho = { alg: 'RS256', kid: 'kid-teste', typ: 'JWT' }, chave = privateKey } = {}) => {
    const corpo = `${b64(cabecalho)}.${b64(carga)}`;
    const s = createSign('RSA-SHA256'); s.update(corpo);
    return `${corpo}.${s.sign(chave).toString('base64url')}`;
  };
  const agora = Date.parse('2026-09-25T12:00:00Z');
  const cargaBoa = { aud: [AUD_DO_PAINEL], iss: EQUIPE_ACCESS, type: 'app', email: 'dono@exemplo.com', sub: 'u1', iat: agora / 1000 - 10, nbf: agora / 1000 - 10, exp: agora / 1000 + 3600 };
  const veredito = (token, extra = {}) => verificarJwtDoAccess(token, { jwks, agora, ...extra });

  ok(veredito(assinar(cargaBoa)).valido, 'controle positivo: o token de aplicativo bem assinado passa');
  ok(veredito(assinar(cargaBoa)).email === 'dono@exemplo.com', 'e diz quem entrou');
  const recusas = [
    ['assinado por OUTRA chave', assinar(cargaBoa, { chave: outra.privateKey })],
    ['alg none', `${b64({ alg: 'none', kid: 'kid-teste' })}.${b64(cargaBoa)}.`],
    // Com assinatura NÃO vazia: o vazio a checagem de formato já barra, e a de `alg` ficava sem exercício (sabotagem H9).
    ['alg none com assinatura qualquer', `${b64({ alg: 'none', kid: 'kid-teste' })}.${b64(cargaBoa)}.AAAA`],
    ['alg RS512 com a chave certa', (() => { const corpo = `${b64({ alg: 'RS512', kid: 'kid-teste' })}.${b64(cargaBoa)}`; const s = createSign('RSA-SHA512'); s.update(corpo); return `${corpo}.${s.sign(privateKey).toString('base64url')}`; })()],
    ['alg HS256 com a chave pública como segredo', `${b64({ alg: 'HS256', kid: 'kid-teste' })}.${b64(cargaBoa)}.AAAA`],
    ['kid desconhecido', assinar(cargaBoa, { cabecalho: { alg: 'RS256', kid: 'kid-inventado' } })],
    ['aud de outro aplicativo', assinar({ ...cargaBoa, aud: ['7120cda61ce638992a2af382565cf88867f5b95e7987155cf1f439b90c4ea1e3'] })],
    ['iss de outra equipe', assinar({ ...cargaBoa, iss: 'https://outra.cloudflareaccess.com' })],
    ['type meta', assinar({ ...cargaBoa, type: 'meta' })],
    ['vencido', assinar({ ...cargaBoa, exp: agora / 1000 - 3600 })],
    ['ainda não vale', assinar({ ...cargaBoa, nbf: agora / 1000 + 3600 })],
    ['sem email', assinar({ ...cargaBoa, email: undefined })],
    ['sem exp', assinar({ ...cargaBoa, exp: undefined })],
    ['carga trocada depois de assinar', (() => { const t = assinar(cargaBoa).split('.'); t[1] = b64({ ...cargaBoa, email: 'intruso@exemplo.com' }); return t.join('.'); })()],
    ['lixo', 'nao.e.jwt'], ['vazio', ''], ['nulo', null], ['duas partes', 'a.b']
  ];
  for (const [nome, token] of recusas) ok(!veredito(token).valido, `recusa: ${nome}`);
  ok(veredito(assinar({ ...cargaBoa, exp: agora / 1000 - 30 })).valido, 'folga de relógio: vencido há 30 s ainda passa (o relógio da Cloudflare e o nosso não são o mesmo)');
  ok(veredito(assinar({ ...cargaBoa, aud: AUD_DO_PAINEL })).valido, '`aud` como texto (não lista) também é aceito');

  /* ---- C1-01: cabeçalho de tipo errado é "não é JWT", e nada lança ---- */
  const cabecalhoCru = (c) => `${b64(c)}.${b64(cargaBoa)}.AAAA`;
  ok(decodificarJwt(cabecalhoCru({ alg: { toString: 0 }, kid: 'kid-teste' })) === null, 'C1-01: `alg` objeto não tem forma de JWT');
  ok(decodificarJwt(cabecalhoCru({ alg: 'RS256', kid: { toString: 0 } })) === null, 'C1-01: `kid` objeto também não');
  ok(decodificarJwt(cabecalhoCru({ alg: 'RS256' })) !== null, 'controle: `kid` ausente continua sendo forma (a recusa é da assinatura)');
  ok(paraOLog({ toString: 0 }) === 'object' && paraOLog('HS256\nforjado') === 'HS256?forjado', 'o motivo de log nunca lança nem quebra linha');

  /* ---- CP3: cada camada SOZINHA ----
     A lista de recusas acima só olha `valido`, e as camadas se cobrem umas
     às outras: o `alg` é conferido no veredito E dentro de
     `assinaturaConfere`, e o `kty` é o que impede uma entrada do JWKS que
     não é RSA de virar chave RSA pelo `n`/`e` que ela carregar. Tirar
     qualquer uma dessas checagens deixava a suíte verde (sabotagens CP3
     jwt-alg, jwt-alg2, jwt-kty, jwt-len) — a outra camada recusava no
     lugar dela, e o furo só aparecia no dia em que a outra mudasse. Aqui
     cada uma é provada por um token que SÓ ela recusa, ou chamando a
     camada de baixo direto. */
  {
    const rs256 = decodificarJwt(assinar(cargaBoa));
    ok(assinaturaConfere(rs256, jwks), 'CP3 controle: a camada de assinatura, chamada direto, aceita o RS256 bem assinado');

    /* jwt-alg2: o cabeçalho diz RS512 (ou `none`), mas a assinatura é
       RSA-SHA256 válida da chave certa sobre esse cabeçalho. Só o `alg`
       DENTRO de `assinaturaConfere` recusa — ela é exportada, e quem a
       chamar sem passar pelo veredito não pode herdar a confusão de
       algoritmo. */
    for (const alg of ['RS512', 'none', 'HS256']) {
      const rotuloFalso = decodificarJwt(assinar(cargaBoa, { cabecalho: { alg, kid: 'kid-teste' } }));
      ok(rotuloFalso && !assinaturaConfere(rotuloFalso, jwks), `CP3 jwt-alg2: assinaturaConfere recusa sozinha o cabeçalho \`alg: ${alg}\` mesmo com assinatura RS256 válida por baixo`);
    }

    /* jwt-alg: no veredito, o `alg` é recusado ANTES da assinatura, e o
       motivo diz isso. Sem esta camada, a recusa ainda viria (da
       assinatura), mas com o motivo errado no log — e o `alg` do atacante
       deixaria de ser conferido antes de qualquer trabalho criptográfico. */
    ok(veredito(`${b64({ alg: 'none', kid: 'kid-teste' })}.${b64(cargaBoa)}.AAAA`).motivo === 'alg none', 'CP3 jwt-alg: o veredito recusa `alg none` pela checagem de alg (motivo `alg none`), não pela de assinatura');
    ok(veredito(assinar(cargaBoa, { cabecalho: { alg: 'RS512', kid: 'kid-teste' } })).motivo === 'alg RS512', 'CP3 jwt-alg: e o RS512 com assinatura RS256 válida também para no alg');

    /* jwt-kty: uma entrada do JWKS com o `kid` certo e o `n`/`e` da chave
       que assinou, mas declarada como outra família (EC, oct) ou sem
       família. `createPublicKey` recebe `kty: 'RSA'` à força — sem o
       filtro de `kty`, qualquer entrada vira chave RSA. */
    for (const kty of ['EC', 'oct', undefined]) {
      const impostora = { ...jwk, kty };
      ok(!assinaturaConfere(rs256, { keys: [impostora] }), `CP3 jwt-kty: entrada do JWKS com \`kty: ${kty}\` não serve de chave RSA, mesmo com o kid e o n/e certos`);
    }
    ok(assinaturaConfere(rs256, { keys: [{ ...jwk, kty: 'EC' }, jwk] }), 'CP3 controle: com a impostora e a RSA de verdade no mesmo JWKS, vale a RSA');

    /* jwt-len: o teto de 8192 caracteres. O token logo ACIMA do teto é
       válido em tudo o mais — assinado, aud/iss/type/exp certos —, então
       só o teto o recusa; o logo abaixo passa (controle). Sem o teto, um
       cabeçalho de requisição de megabytes seria decodificado e
       verificado em RSA antes do login. */
    const comEnchimento = (n) => assinar({ ...cargaBoa, enchimento: 'x'.repeat(n) });
    let baixo = 0; let alto = 8192;
    while (baixo < alto) { const meio = Math.floor((baixo + alto) / 2); if (comEnchimento(meio).length > 8192) alto = meio; else baixo = meio + 1; }
    const acima = comEnchimento(baixo); const abaixo = comEnchimento(baixo - 1);
    ok(acima.length > 8192 && abaixo.length <= 8192, `controle do teste: os dois tokens ficam um de cada lado do teto (${abaixo.length}, ${acima.length})`);
    ok(decodificarJwt(abaixo) !== null && veredito(abaixo).valido, 'CP3 controle: o token logo abaixo do teto, bem assinado, passa');
    ok(decodificarJwt(acima) === null, `CP3 jwt-len: decodificarJwt recusa o token de ${acima.length} caracteres (teto 8192)`);
    ok(veredito(acima).motivo === 'formato', 'CP3 jwt-len: e o veredito recusa por formato um token que, sem o teto, seria VÁLIDO');
  }

  /* ---- o buscador de chaves: cache, rotação e teto ---- */
  let buscas = 0; let relogio = 0;
  const buscador = criarBuscadorDeChaves({
    fetch: async () => { buscas += 1; return { ok: true, json: async () => jwks }; },
    agora: () => relogio
  });
  await buscador('kid-teste'); await buscador('kid-teste');
  ok(buscas === 1, 'o cache evita buscar de novo');
  relogio += 1000; await buscador('kid-inventado');
  ok(buscas === 1, 'kid desconhecido dentro do intervalo mínimo NÃO busca (forjado não vira chamada à Cloudflare por requisição)');
  relogio += 61_000; await buscador('kid-inventado');
  ok(buscas === 2, 'passado o intervalo, um kid novo (rotação) busca de novo');
  let erro = null;
  await criarBuscadorDeChaves({ fetch: async () => ({ ok: false, status: 503 }) })('x').catch((e) => { erro = e; });
  ok(erro && /503/.test(erro.message), 'certs indisponíveis LANÇAM — quem chama responde 503, nunca "passa"');

  /* ---- C1-15: busca única, recuo depois de falha, chave velha durante a queda ---- */
  {
    let n = 0; let t = 0; let fora = false; const soltar = [];
    const b = criarBuscadorDeChaves({
      fetch: async () => { n += 1; if (fora) return { ok: false, status: 503 }; await new Promise((r) => { soltar.push(r); }); return { ok: true, json: async () => jwks }; },
      agora: () => t
    });
    const juntas = [b('kid-teste'), b('kid-teste'), b('kid-teste')];
    await new Promise((r) => setImmediate(r)); soltar.forEach((r) => r());
    await Promise.all(juntas);
    ok(n === 1, `C1-15: três pedidos simultâneos, UMA busca à Cloudflare (${n})`);
    fora = true; t += 3600_001;
    const velho = await b('kid-teste');
    ok(velho?.keys?.length === jwks.keys.length && n === 2, 'C1-15: cache vencido e Cloudflare fora — a chave conhecida continua valendo');
    t += 1000;
    await b('kid-forjado'); await b('kid-forjado'); await b('kid-forjado');
    ok(n === 2, `C1-15: depois de uma falha, token com kid inventado não vira busca por requisição (${n})`);
    t += 25 * 3600_000;
    let e2 = null; await b('kid-teste').catch((e) => { e2 = e; });
    ok(e2 !== null, 'e a chave velha tem prazo: passado ele, sem Cloudflare, falha fechado');
  }

  console.log(`accessJwt: ${checagens} checagens OK`);
}
