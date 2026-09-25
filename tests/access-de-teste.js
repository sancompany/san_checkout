/**
 * tests/access-de-teste.js — um "Cloudflare Access" de mentira, para as
 * suítes que montam a pilha HTTP de verdade e para o teste manual local
 * (SEC-015).
 *
 * Desde 25/09/2026 toda rota de `/api/admin` exige o JWT do Access, e não
 * existe desligamento — nem em localhost. Este ajudante gera um par de
 * chaves RSA DESTE processo, serve a chave pública num servidor local no
 * formato do `/cdn-cgi/access/certs` e assina tokens com o `aud` e o `iss`
 * do painel — o que a Cloudflare faria. A chave privada nunca sai da
 * memória: morto o processo, todo token que ele assinou deixa de valer.
 *
 * Duas formas de usar:
 *   - nas suítes: `const access = await subirAccessDeTeste()` (aponta
 *     `CF_ACCESS_CERTS_URL` para ele sozinho);
 *   - à mão (`docs/TESTES.md`, passo 2): `node tests/access-de-teste.js`
 *     imprime a linha do `.env` e um JWT de 8 horas, e fica no ar.
 *
 * Nada daqui existe em ambiente nenhum; e o servidor só aceita
 * `CF_ACCESS_CERTS_URL` apontando para o loopback, onde em produção não há
 * nada escutando.
 */
import { generateKeyPairSync, createSign } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { AUD_DO_PAINEL, EQUIPE_ACCESS } from '../src/utils/accessJwt.js';

export async function subirAccessDeTeste({ porta = 0, manterVivo = false } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'kid-do-access-de-teste', alg: 'RS256' };
  const servidor = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  servidor.listen(porta, '127.0.0.1');
  await once(servidor, 'listening');
  if (!manterVivo) servidor.unref();
  const urlDasChaves = `http://127.0.0.1:${servidor.address().port}/cdn-cgi/access/certs`;
  process.env.CF_ACCESS_CERTS_URL = urlDasChaves;

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const assinar = (carga, { chave = privateKey, kid = jwk.kid } = {}) => {
    const corpo = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64(carga)}`;
    const s = createSign('RSA-SHA256');
    s.update(corpo);
    return `${corpo}.${s.sign(chave).toString('base64url')}`;
  };
  const agora = () => Math.floor(Date.now() / 1000);
  /** Um JWT de aplicativo válido do painel, com o que se quiser por cima. */
  const jwt = (extra = {}) => assinar({ aud: [AUD_DO_PAINEL], iss: EQUIPE_ACCESS, type: 'app', email: 'operador@teste.invalid', sub: 'op', iat: agora() - 5, nbf: agora() - 5, exp: agora() + 3600, ...extra });
  const outraChave = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  return { jwt, assinar, outraChave, urlDasChaves, fechar: () => servidor.close() };
}

/* `node tests/access-de-teste.js` — o Access de mentira para o teste manual. */
if (process.argv[1]?.endsWith('access-de-teste.js')) {
  const access = await subirAccessDeTeste({ porta: Number(process.env.PORTA_ACCESS_DE_TESTE) || 4010, manterVivo: true });
  const oitoHoras = Math.floor(Date.now() / 1000) + 8 * 3600;
  console.log('Access de teste no ar (Ctrl+C para parar — os tokens morrem junto).\n');
  console.log('No .env do servidor LOCAL (nunca no de produção), e reinicie o `npm start`:');
  console.log(`  CF_ACCESS_CERTS_URL=${access.urlDasChaves}\n`);
  console.log('Cabeçalho para as chamadas ao /api/admin local (vale 8 horas):');
  console.log(`  Cf-Access-Jwt-Assertion: ${access.jwt({ exp: oitoHoras })}`);
}
