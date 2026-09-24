/**
 * SAN CHECKOUT v2 — src/utils/dinheiro.js
 *
 * Aritmética de dinheiro em CENTAVOS INTEIROS (M-05 da auditoria de
 * 24/09/2026). O banco guarda `numeric(10,2)` e a Asaas fala em reais
 * com duas casas; o que não pode acontecer é `Number` em ponto
 * flutuante decidir se dois valores são iguais — `30` e
 * `30.000000000000004` são o mesmo preço, e `0.1 + 0.2` não é `0.3`.
 *
 * Toda comparação de valor no caminho do dinheiro (cotação × pull,
 * estorno × cobrado, acerto) passa por aqui. A conversão é feita UMA vez
 * na fronteira (`emCentavos`) e desfeita UMA vez ao gravar/devolver
 * (`emReais`); no meio, é inteiro.
 */

/** `"30"`, `30`, `30.004` → `3000`. `null`/`undefined`/não numérico → `null`. */
export function emCentavos(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'boolean') return null;
  // Texto vazio é AUSÊNCIA, não zero: `Number('')` é `0`, a mesma
  // armadilha de `Number(null)` que reconciliou uma assinatura para
  // R$ 0,00 em 18/09/2026.
  if (typeof valor === 'string' && valor.trim() === '') return null;
  const numero = typeof valor === 'string' ? Number(valor.trim()) : Number(valor);
  if (!Number.isFinite(numero)) return null;
  // `Math.round` sobre o produto por 100 já absorve o ruído binário
  // (`1.005 * 100 = 100.49999…` arredonda para 100, que é o que 1,00 vale
  // em centavos para o Postgres também).
  return Math.round(numero * 100);
}

/** `3000` → `30`. Devolve `null` para `null`. */
export function emReais(centavos) {
  if (centavos === null || centavos === undefined) return null;
  if (!Number.isInteger(centavos)) throw new TypeError(`emReais: esperava inteiro de centavos, veio ${centavos}`);
  return centavos / 100;
}

/** Dois valores (em qualquer forma aceita por `emCentavos`) representam o
 *  mesmo dinheiro? `null` só é igual a `null`. */
export function mesmoDinheiro(a, b) {
  return emCentavos(a) === emCentavos(b);
}

/** Soma uma lista de valores em reais, em centavos, e devolve reais. */
export function somarReais(valores) {
  let total = 0;
  for (const v of valores) {
    const c = emCentavos(v);
    if (c === null) continue;
    total += c;
  }
  return emReais(total);
}

/* ------------------------------------------------------------------
   Autoteste — `node src/utils/dinheiro.js`
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('dinheiro.js')) {
  const { strict: assertReal } = await import('node:assert');
  let checagens = 0;
  const assert = new Proxy(assertReal, {
    get(alvo, nome) {
      const valor = alvo[nome];
      if (typeof valor !== 'function') return valor;
      return (...args) => { checagens += 1; return valor.apply(alvo, args); };
    }
  });

  assert.equal(emCentavos(0.01), 1);
  assert.equal(emCentavos(0.1), 10);
  assert.equal(emCentavos(0.99), 99);
  assert.equal(emCentavos('0.99'), 99);
  assert.equal(emCentavos(1.005), 100);   // ruído binário não vira centavo
  assert.equal(emCentavos(30.000000000000004), 3000);
  assert.equal(emCentavos(null), null);
  assert.equal(emCentavos(undefined), null);
  assert.equal(emCentavos('abc'), null);
  assert.equal(emCentavos(true), null);
  assert.equal(emCentavos(''), null);

  assert.equal(emReais(3000), 30);
  assert.equal(emReais(1), 0.01);
  assert.equal(emReais(null), null);
  assert.throws(() => emReais(1.5), /inteiro/);

  assert.ok(mesmoDinheiro(30, '30.00'));
  assert.ok(mesmoDinheiro(30, 30.000000000000004));
  assert.ok(!mesmoDinheiro(30, 30.01));
  assert.ok(mesmoDinheiro(null, null));
  assert.ok(!mesmoDinheiro(null, 0));      // ausência não é zero (lição do 18/09)

  assert.equal(somarReais([0.1, 0.2]), 0.3);
  assert.equal(somarReais([0.1, 0.2, null, 'x']), 0.3);
  assert.equal(somarReais([]), 0);
  assert.equal(somarReais(['99.90', 99.9, 0.01]), 199.81);

  console.log(`dinheiro: ${checagens} checagens OK`);
}
