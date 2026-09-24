/**
 * SAN CHECKOUT v2 — src/utils/ciclos.js
 *
 * A CAMADA CANÔNICA DE CICLOS (M-10 da auditoria de 24/09/2026).
 *
 * Três vocabulários se encontram aqui, e nenhum chamador precisa
 * conhecer os outros dois:
 *
 *  1. o da Asaas — `MONTHLY`, `QUARTERLY`, `SEMIANNUALLY`, `YEARLY`,
 *     mais `WEEKLY`, `BIWEEKLY`, `BIMONTHLY` (conjunto fechado, conferido
 *     na doc de `POST /v3/subscriptions` em 24/09/2026). É o que se grava
 *     no banco (check da migration 0014) e o que se manda para a Asaas;
 *  2. o canônico do ecossistema, em português — `mensal`, `trimestral`,
 *     `semestral`, `anual` (e `semanal`, `quinzenal`, `bimestral` para o
 *     resto). É o que um contratante pode mandar em `plano.ciclo` sem
 *     precisar falar o vocabulário interno do PSP;
 *  3. o de meses — `1`, `3`, `6`, `12`: o MostrAí guarda
 *     `compromisso_meses`, e um número é o que menos envelhece.
 *
 * `normalizarCiclo` aceita QUALQUER um dos três e devolve o da Asaas, ou
 * `null` quando não reconhece — nunca cai em `MONTHLY` por omissão: era
 * exatamente esse default silencioso que gravou assinaturas trimestrais
 * como mensais em 15/09/2026.
 *
 * Por contratante, `contratantes.ciclos_permitidos` (migration 0015)
 * restringe a lista: o MostrAí só vende os quatro do catálogo dele, e o
 * Checkout continua genérico para quem vender os outros.
 */

export const CICLOS_ASAAS = ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'BIMONTHLY', 'QUARTERLY', 'SEMIANNUALLY', 'YEARLY'];

const POR_CANONICO = {
  semanal: 'WEEKLY',
  quinzenal: 'BIWEEKLY',
  mensal: 'MONTHLY',
  bimestral: 'BIMONTHLY',
  trimestral: 'QUARTERLY',
  semestral: 'SEMIANNUALLY',
  anual: 'YEARLY'
};

const POR_MESES = { 1: 'MONTHLY', 2: 'BIMONTHLY', 3: 'QUARTERLY', 6: 'SEMIANNUALLY', 12: 'YEARLY' };

const CANONICO_POR_ASAAS = Object.fromEntries(Object.entries(POR_CANONICO).map(([pt, en]) => [en, pt]));
const MESES_POR_ASAAS = Object.fromEntries(Object.entries(POR_MESES).map(([m, en]) => [en, Number(m)]));

/** Qualquer vocabulário → nome da Asaas, ou `null`. */
export function normalizarCiclo(entrada) {
  if (entrada === null || entrada === undefined) return null;
  if (typeof entrada === 'number') return POR_MESES[entrada] ?? null;
  if (typeof entrada !== 'string') return null;
  const texto = entrada.trim();
  if (!texto) return null;
  if (/^\d+$/.test(texto)) return POR_MESES[Number(texto)] ?? null;
  const maiusculo = texto.toUpperCase();
  if (CICLOS_ASAAS.includes(maiusculo)) return maiusculo;
  return POR_CANONICO[texto.toLowerCase()] ?? null;
}

/** Nome da Asaas → canônico em português (`MONTHLY` → `mensal`). */
export function cicloCanonico(cicloAsaas) {
  return CANONICO_POR_ASAAS[cicloAsaas] ?? null;
}

/** Nome da Asaas → meses (`QUARTERLY` → 3). `WEEKLY`/`BIWEEKLY` → `null`. */
export function mesesDoCiclo(cicloAsaas) {
  return MESES_POR_ASAAS[cicloAsaas] ?? null;
}

/**
 * O ciclo é aceito para ESTE contratante? `ciclos_permitidos` nulo =
 * os sete da Asaas. Devolve a lista permitida junto, para a mensagem de
 * recusa nomear os aceitos (lição nº 19: conjunto fechado recusa
 * nomeando o conjunto).
 */
export function cicloPermitido(cicloAsaas, contratante) {
  const permitidos = Array.isArray(contratante?.ciclos_permitidos) && contratante.ciclos_permitidos.length > 0
    ? contratante.ciclos_permitidos
    : CICLOS_ASAAS;
  return { permitido: permitidos.includes(cicloAsaas), permitidos };
}

/* ------------------------------------------------------------------
   Autoteste — `node src/utils/ciclos.js`
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('ciclos.js')) {
  const { strict: assertReal } = await import('node:assert');
  let checagens = 0;
  const assert = new Proxy(assertReal, {
    get(alvo, nome) {
      const valor = alvo[nome];
      if (typeof valor !== 'function') return valor;
      return (...args) => { checagens += 1; return valor.apply(alvo, args); };
    }
  });

  // os quatro do MostrAí, nos três vocabulários
  for (const [pt, meses, en] of [['mensal', 1, 'MONTHLY'], ['trimestral', 3, 'QUARTERLY'], ['semestral', 6, 'SEMIANNUALLY'], ['anual', 12, 'YEARLY']]) {
    assert.equal(normalizarCiclo(pt), en);
    assert.equal(normalizarCiclo(pt.toUpperCase()), en);
    assert.equal(normalizarCiclo(meses), en);
    assert.equal(normalizarCiclo(String(meses)), en);
    assert.equal(normalizarCiclo(en), en);
    assert.equal(normalizarCiclo(en.toLowerCase()), en);
    assert.equal(cicloCanonico(en), pt);
    assert.equal(mesesDoCiclo(en), meses);
  }

  // nunca cai em MONTHLY por omissão
  assert.equal(normalizarCiclo(undefined), null);
  assert.equal(normalizarCiclo(null), null);
  assert.equal(normalizarCiclo(''), null);
  assert.equal(normalizarCiclo('MENSALMENTE'), null);
  assert.equal(normalizarCiclo(4), null);
  assert.equal(normalizarCiclo({}), null);

  // o resto do conjunto fechado da Asaas continua aceito no genérico
  assert.equal(normalizarCiclo('semanal'), 'WEEKLY');
  assert.equal(normalizarCiclo('BIWEEKLY'), 'BIWEEKLY');
  assert.equal(mesesDoCiclo('WEEKLY'), null);

  // restrição por contratante
  const mostrai = { ciclos_permitidos: ['MONTHLY', 'QUARTERLY', 'SEMIANNUALLY', 'YEARLY'] };
  assert.equal(cicloPermitido('SEMIANNUALLY', mostrai).permitido, true);
  assert.equal(cicloPermitido('WEEKLY', mostrai).permitido, false);
  assert.deepEqual(cicloPermitido('WEEKLY', mostrai).permitidos, mostrai.ciclos_permitidos);
  assert.equal(cicloPermitido('WEEKLY', { ciclos_permitidos: null }).permitido, true);
  assert.equal(cicloPermitido('WEEKLY', {}).permitido, true);
  assert.equal(cicloPermitido('WEEKLY', { ciclos_permitidos: [] }).permitido, true);

  console.log(`ciclos: ${checagens} checagens OK`);
}
