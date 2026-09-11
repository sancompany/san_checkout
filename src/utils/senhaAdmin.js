/**
 * SAN CHECKOUT — src/utils/senhaAdmin.js
 *
 * A senha do admin não fica mais em texto puro na variável de ambiente:
 * o que fica guardado é o resultado de uma derivação lenta (scrypt), e
 * quem ler a variável não tem a senha, tem um hash pra quebrar.
 *
 * Por que scrypt e não bcrypt/argon2: os dois exigem compilação nativa,
 * e `crypto.scrypt` já vem no Node (RFC 7914, lento e memory-hard, mesma
 * família). Dependência nova num serviço de pagamento é risco de build e
 * superfície de supply-chain — a biblioteca padrão resolve aqui.
 *
 * Os parâmetros de custo viajam DENTRO do hash. Assim dá pra endurecer o
 * custo no futuro sem invalidar o que já está guardado: hash antigo
 * continua conferindo com os parâmetros dele.
 *
 * Formato: scrypt$N$r$p$<sal base64>$<derivada base64>
 */

import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** N=16384, r=8 → 16 MB e ~50-100ms por verificação. Cabe no maxmem
 *  padrão do Node (32 MB) e é lento o bastante pra força bruta doer. */
const CUSTO = { N: 16384, r: 8, p: 1 };
const TAMANHO_CHAVE = 64;
const TAMANHO_SAL = 16;

export function gerarHashSenha(senha) {
  if (!senha) throw new Error('Senha vazia.');
  const sal = randomBytes(TAMANHO_SAL);
  const derivada = scryptSync(String(senha), sal, TAMANHO_CHAVE, CUSTO);
  return `scrypt$${CUSTO.N}$${CUSTO.r}$${CUSTO.p}$${sal.toString('base64')}$${derivada.toString('base64')}`;
}

/**
 * Devolve `false` — nunca lança — pra qualquer entrada malformada:
 * hash truncado, variável de ambiente vazia, formato de outro algoritmo.
 * Numa rota de autenticação, exceção não tratada vira 500, e 500 diferente
 * de 401 já conta como oráculo pra quem está sondando.
 */
export function senhaConfere(senha, armazenado) {
  const partes = String(armazenado ?? '').split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;

  const [, n, r, p, salBase64, hashBase64] = partes;

  try {
    const sal = Buffer.from(salBase64, 'base64');
    const esperada = Buffer.from(hashBase64, 'base64');
    if (sal.length === 0 || esperada.length === 0) return false;

    const derivada = scryptSync(String(senha ?? ''), sal, esperada.length, {
      N: Number(n), r: Number(r), p: Number(p)
    });

    // timingSafeEqual exige mesmo tamanho; o guard acima já garante.
    return timingSafeEqual(derivada, esperada);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------
   Autoteste — `node src/utils/senhaAdmin.js`
   Roda junto com os outros em `npm test`.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('senhaAdmin.js')) {
  const { strict: assert } = await import('node:assert');

  const hash = gerarHashSenha('senha-de-teste-123');

  assert.ok(hash.startsWith('scrypt$16384$8$1$'), 'formato com parâmetros de custo');
  assert.ok(senhaConfere('senha-de-teste-123', hash), 'senha certa confere');
  assert.ok(!senhaConfere('senha-de-teste-124', hash), 'senha errada não confere');
  assert.ok(!senhaConfere('', hash), 'senha vazia não confere');
  assert.ok(!senhaConfere('senha-de-teste-123', ''), 'hash vazio não confere');

  // sal aleatório: a mesma senha gera hashes diferentes
  assert.notEqual(gerarHashSenha('igual'), gerarHashSenha('igual'), 'sal é aleatório por hash');

  // entrada malformada devolve false, nunca estoura
  for (const lixo of ['abc', 'scrypt$1$2$3', 'bcrypt$16384$8$1$aa$bb', null, undefined, 42, 'scrypt$16384$8$1$$']) {
    assert.equal(senhaConfere('x', lixo), false, `lixo tratado: ${String(lixo)}`);
  }

  // hash com custo diferente continua conferindo (compatibilidade futura)
  const barato = (() => {
    const sal = randomBytes(16);
    const d = scryptSync('outra', sal, 64, { N: 1024, r: 8, p: 1 });
    return `scrypt$1024$8$1$${sal.toString('base64')}$${d.toString('base64')}`;
  })();
  assert.ok(senhaConfere('outra', barato), 'parâmetros lidos do próprio hash');

  console.log('senhaAdmin: 16 checagens OK');
}
