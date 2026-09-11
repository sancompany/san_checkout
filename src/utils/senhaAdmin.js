/**
 * SAN CHECKOUT — src/utils/senhaAdmin.js
 *
 * A senha do admin não fica em texto puro: o que é guardado é o
 * resultado de uma derivação lenta, e quem ler a variável de ambiente
 * tem um hash pra quebrar, não a senha.
 *
 * ── Por que scrypt e não Argon2id ────────────────────────────────────
 * A ordem de preferência da Lei 3 é Argon2id primeiro, scrypt quando
 * Argon2id não estiver disponível. Argon2id exige dependência nativa;
 * num serviço de pagamento isso é risco de build e superfície de
 * supply-chain. `crypto.scrypt` é scrypt de verdade (RFC 7914) e vem na
 * biblioteca padrão.
 *
 * A lei permite essa troca sob três condições, e as três estão aqui:
 *   1. salt aleatório por senha           → `randomBytes` abaixo
 *   2. salt e parâmetros guardados junto  → formato `scrypt$N$r$p$...`
 *   3. comparação em tempo constante      → `timingSafeEqual`
 *
 * ── Por que N=2^17 e não o padrão do Node ────────────────────────────
 * O padrão é N=2^14 e produz hash fraco SEM avisar. O mínimo é 2^17.
 * Medido nesta base: 2^14 = 16 MB / 144 ms · 2^17 = 128 MB / 791 ms.
 *
 * ── Por que assíncrono ───────────────────────────────────────────────
 * `scryptSync` bloqueia o event loop pelo tempo inteiro da derivação.
 * A 791 ms, uma tentativa de login no admin congelaria TODA rota de
 * pagamento em voo. A versão assíncrona roda no threadpool e não
 * atrapalha ninguém. Por isso as duas funções aqui são `async`, e o
 * middleware que as usa também é.
 *
 * ── Por que o valor guardado é base64, e não `scrypt$N$r$p$sal$hash` cru ──
 * Era assim antes, e quebrou em produção: o Render trata `$` dentro do
 * valor de uma variável de ambiente como início de substituição de shell
 * e apaga o que vem depois do primeiro `$` que não resolve — o hash
 * guardado chegava truncado. `senhaConfere` então falhava o teste de
 * formato (`partes.length !== 6`) e devolvia `false` na hora, sem nem
 * tentar derivar — login certo ou errado dava o mesmo 401, na mesma
 * velocidade da sonda sem verificação nenhuma. Ver
 * `docs/erros/2026-09-11-cifrao-em-variavel-de-ambiente.md`.
 * Envelopar a linha inteira em base64 elimina todo `$` do valor
 * armazenado — o alfabeto base64 é só `A-Za-z0-9+/=`. Efeito colateral
 * bom: quem olha a variável no painel não vê os parâmetros de custo de
 * cara.
 */

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derivar = promisify(scrypt);

/** Mínimo recomendado (OWASP): N=2^17, r=8, p=1. */
const CUSTO = { N: 131072, r: 8, p: 1 };
const TAMANHO_CHAVE = 64;
const TAMANHO_SAL = 16;

/** scrypt precisa de 128*N*r bytes; o `maxmem` padrão do Node (32 MB)
 *  recusaria N=2^17. Calculado a partir dos próprios parâmetros, com
 *  folga — número chumbado aqui viraria a próxima armadilha silenciosa. */
function limiteDeMemoria({ N, r }) {
  return 128 * N * r * 2;
}

export async function gerarHashSenha(senha) {
  if (!senha) throw new Error('Senha vazia.');
  const sal = randomBytes(TAMANHO_SAL);
  const derivada = await derivar(String(senha), sal, TAMANHO_CHAVE, {
    ...CUSTO, maxmem: limiteDeMemoria(CUSTO)
  });
  const linha = `scrypt$${CUSTO.N}$${CUSTO.r}$${CUSTO.p}$${sal.toString('base64')}$${derivada.toString('base64')}`;
  return Buffer.from(linha, 'utf8').toString('base64');
}

/**
 * Devolve `false` — nunca lança — pra qualquer entrada malformada.
 * Numa rota de autenticação, exceção não tratada vira 500, e 500
 * diferente de 401 já é um oráculo pra quem está sondando.
 *
 * Aceita hash gerado com parâmetros mais fracos, de propósito: recusar
 * trancaria o operador para fora sem aviso. Mas NÃO aceita em silêncio —
 * avisa no log, porque hash fraco que ninguém enxerga é o problema que a
 * Lei 3 nomeia.
 */
export async function senhaConfere(senha, armazenadoBase64) {
  let armazenado;
  try {
    armazenado = Buffer.from(String(armazenadoBase64 ?? ''), 'base64').toString('utf8');
  } catch {
    return false;
  }

  const partes = armazenado.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;

  const [, n, r, p, salBase64, hashBase64] = partes;
  const parametros = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(parametros.N) || !Number.isInteger(parametros.r) || !Number.isInteger(parametros.p)) return false;

  if (parametros.N < CUSTO.N) {
    console.warn(
      `[senhaAdmin] o hash guardado usa N=${parametros.N}, abaixo do mínimo ${CUSTO.N}. ` +
      'Gere um novo com `node scripts/gerar-hash-admin.js` e troque CHECKOUT_ADMIN_PASS_HASH.'
    );
  }

  try {
    const sal = Buffer.from(salBase64, 'base64');
    const esperada = Buffer.from(hashBase64, 'base64');
    if (sal.length === 0 || esperada.length === 0) return false;

    const derivada = await derivar(String(senha ?? ''), sal, esperada.length, {
      ...parametros, maxmem: limiteDeMemoria(parametros)
    });

    return timingSafeEqual(derivada, esperada);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------
   Autoteste — `node src/utils/senhaAdmin.js`
   Roda junto com os outros em `npm test`. Leva alguns segundos: cada
   derivação a N=2^17 custa ~800 ms, e isso é o recurso funcionando.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('senhaAdmin.js')) {
  const { strict: assert } = await import('node:assert');

  const hash = await gerarHashSenha('senha-de-teste-123');

  assert.ok(!hash.includes('$'), 'valor de saída não tem `$` — é seguro colar em variável de ambiente do Render');
  const linhaDecodificada = Buffer.from(hash, 'base64').toString('utf8');
  assert.ok(linhaDecodificada.startsWith('scrypt$131072$8$1$'), 'por dentro, gera com o parâmetro mínimo da Lei 3, não com o padrão do Node');
  assert.ok(await senhaConfere('senha-de-teste-123', hash), 'senha certa confere');
  assert.ok(!(await senhaConfere('senha-de-teste-124', hash)), 'senha errada não confere');
  assert.ok(!(await senhaConfere('', hash)), 'senha vazia não confere');
  assert.ok(!(await senhaConfere('senha-de-teste-123', '')), 'hash vazio não confere');

  assert.notEqual(await gerarHashSenha('igual'), await gerarHashSenha('igual'), 'sal é aleatório por hash');

  for (const lixo of ['abc', 'scrypt$1$2$3', 'bcrypt$131072$8$1$aa$bb', null, undefined, 42, 'scrypt$131072$8$1$$', 'scrypt$x$8$1$aa$bb']) {
    assert.equal(await senhaConfere('x', lixo), false, `lixo tratado: ${String(lixo)}`);
  }

  // Hash antigo, com parâmetro fraco, ainda confere — e avisa. Já
  // envelopado em base64, porque é assim que `senhaConfere` sempre
  // espera receber o valor agora.
  const antigo = await (async () => {
    const sal = randomBytes(16);
    const d = await derivar('antiga', sal, 64, { N: 16384, r: 8, p: 1, maxmem: 128 * 16384 * 8 * 2 });
    const linha = `scrypt$16384$8$1$${sal.toString('base64')}$${d.toString('base64')}`;
    return Buffer.from(linha, 'utf8').toString('base64');
  })();
  assert.ok(await senhaConfere('antiga', antigo), 'hash com parâmetro antigo continua verificável (não tranca ninguém pra fora)');

  console.log('senhaAdmin: 18 checagens OK');
}
