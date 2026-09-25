/**
 * SAN CHECKOUT v2 — src/utils/passadas.js
 *
 * Uma passada por vez (SEC-023, 25/09/2026). `setInterval` não espera a
 * passada anterior terminar: a outbox com endpoints pendurados (10 s cada,
 * até 50 linhas) ainda estava rodando quando o tique seguinte chegava, e
 * as duas passadas disputavam as mesmas linhas com listas tiradas em
 * momentos diferentes. O CAS de cada fila impede o envio em dobro; isto
 * impede a disputa — o tique que encontra a anterior em curso é pulado e
 * devolve a promessa dela.
 */
export function umaPassadaPorVez(passada) {
  let emCurso = null;
  return () => {
    if (emCurso) return emCurso;
    emCurso = Promise.resolve().then(passada).finally(() => { emCurso = null; });
    return emCurso;
  };
}

/* ------------------------------------------------------------------
   Autoteste — `node src/utils/passadas.js`
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('passadas.js')) {
  const { strict: assert } = await import('node:assert');
  let checagens = 0;
  const ok = (c, m) => { assert.ok(c, m); checagens += 1; };

  let rodando = 0; let maximo = 0; let rodadas = 0;
  let soltar;
  const passada = umaPassadaPorVez(async () => {
    rodando += 1; rodadas += 1; maximo = Math.max(maximo, rodando);
    await new Promise((r) => { soltar = r; });
    rodando -= 1;
  });
  const p1 = passada();
  const p2 = passada(); // tique no meio da primeira
  const p3 = passada();
  await new Promise((r) => setImmediate(r));
  ok(rodadas === 1, 'tiques durante a passada em curso não abrem outra');
  ok(p1 === p2 && p2 === p3, 'e devolvem a promessa da que está rodando');
  soltar();
  await p1;
  ok(maximo === 1, 'nunca duas ao mesmo tempo');
  const p4 = passada();
  await new Promise((r) => setImmediate(r));
  ok(rodadas === 2 && p4 !== p1, 'terminada, o tique seguinte roda de novo');
  soltar();
  await p4;

  // passada que lança não trava a fila para sempre
  let tentativas = 0;
  const quebrada = umaPassadaPorVez(async () => { tentativas += 1; throw new Error('falhou'); });
  await quebrada().catch(() => {});
  await quebrada().catch(() => {});
  ok(tentativas === 2, 'uma passada que lançou não deixa o trinco fechado');

  console.log(`passadas: ${checagens} checagens OK`);
}
