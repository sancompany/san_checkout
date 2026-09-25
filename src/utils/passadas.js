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

/**
 * Os workers ATRASADOS: sem uma passada que terminou bem há mais de três
 * intervalos, mais dois minutos de folga (SEC-031, 25/09/2026). A conta é
 * a partir de quando os workers LIGARAM (`ligadosEm`), e nada é atrasado
 * enquanto eles não ligaram — o modo de teste não os liga.
 *
 * @param {object} p
 * @param {Object<string, number>} p.intervalos   ms entre passadas, por worker
 * @param {Object<string, number|null>} p.ultimaRodada  quando cada um terminou bem pela última vez
 * @param {number|null} p.ligadosEm
 * @param {number} [p.agora]
 * @returns {string[]} os nomes dos atrasados
 */
export function workersAtrasados({ intervalos, ultimaRodada, ligadosEm, agora = Date.now() }) {
  if (ligadosEm === null || ligadosEm === undefined) return [];
  return Object.entries(intervalos)
    .filter(([nome, intervalo]) => agora - (ultimaRodada[nome] ?? ligadosEm) > 3 * intervalo + 2 * 60_000)
    .map(([nome]) => nome);
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

  /* --- worker atrasado (SEC-031) --- */
  const MIN = 60_000;
  const intervalos = { rapido: 30_000, lento: 15 * MIN };
  const ligadosEm = 0;
  ok(workersAtrasados({ intervalos, ultimaRodada: {}, ligadosEm: null, agora: 10 * 60 * MIN }).length === 0, 'workers que não ligaram (modo de teste) nunca estão atrasados');
  ok(workersAtrasados({ intervalos, ultimaRodada: {}, ligadosEm, agora: 3 * MIN }).length === 0, 'logo depois de ligar, nenhum está atrasado (a folga cobre a primeira passada)');
  ok(JSON.stringify(workersAtrasados({ intervalos, ultimaRodada: {}, ligadosEm, agora: 4 * MIN })) === '["rapido"]', 'o rápido que nunca terminou passada em 4 min está atrasado; o lento, ainda não');
  ok(workersAtrasados({ intervalos, ultimaRodada: { rapido: 3.5 * MIN }, ligadosEm, agora: 4 * MIN }).length === 0, 'uma passada recente tira o atraso');
  ok(JSON.stringify(workersAtrasados({ intervalos, ultimaRodada: { rapido: 59 * MIN, lento: 0 }, ligadosEm, agora: 60 * MIN })) === '["lento"]', 'o lento parado há uma hora (limite 47 min) está atrasado');
  ok(workersAtrasados({ intervalos, ultimaRodada: { rapido: 0 }, ligadosEm, agora: 3.5 * MIN }).length === 0, 'no limite exato (3 × 30 s + 2 min) ainda não');
  ok(JSON.stringify(workersAtrasados({ intervalos, ultimaRodada: { rapido: 0 }, ligadosEm, agora: 3.5 * MIN + 1 })) === '["rapido"]', 'um milissegundo depois, sim');

  console.log(`passadas: ${checagens} checagens OK`);
}
