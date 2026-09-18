/**
 * tests/ajudantes.js — o que mais de uma suíte precisa, num lugar só.
 *
 * Nasceu de um bug concreto, não de gosto por arrumação. Em 17/09/2026
 * três suítes tinham a própria cópia do andador de diretório, e a cópia
 * mais nova — escrita do zero, como cópia é — **não descia
 * subdiretório**: a varredura que devia cobrir o `src/` inteiro cobria
 * uma pasta. Ela aprovou o que não olhou, que é o pior desfecho de uma
 * varredura.
 *
 * Uma varredura é tão forte quanto o seu alcance, e alcance escrito três
 * vezes é alcance que um dia vale duas. O andador mora aqui e ganha
 * autoteste próprio — inclusive um que prova que ele DESCE.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Todo `.js` debaixo de `diretorio`, recursivamente. */
export function arquivosJs(diretorio) {
  const achados = [];
  for (const entrada of readdirSync(diretorio, { withFileTypes: true })) {
    const caminho = join(diretorio, entrada.name);
    if (entrada.isDirectory()) achados.push(...arquivosJs(caminho));
    else if (entrada.name.endsWith('.js')) achados.push(caminho);
  }
  return achados;
}

/**
 * Conta os argumentos de NÍVEL SUPERIOR de uma chamada, a partir do
 * índice do abre-parênteses.
 *
 * Existe porque regex não serve para isto, e eu caí duas vezes na mesma
 * armadilha em 17/09: `\(([^;]*?)\)` é lazy e fecha no `)` de um
 * argumento como `Boolean(x)`, então nunca vê o argumento seguinte. As
 * duas vezes uma sabotagem passou por causa disso.
 *
 * @returns {number} quantos argumentos, ou `-1` se os parênteses não
 *          fecharem — quem chama decide o que fazer com isso.
 */
export function argumentosDe(fonte, indiceDoAbre) {
  let profundidade = 0;
  let argumentos = 1;
  for (let i = indiceDoAbre; i < fonte.length; i += 1) {
    const c = fonte[i];
    if (c === '(' || c === '[' || c === '{') profundidade += 1;
    else if (c === ')' || c === ']' || c === '}') {
      profundidade -= 1;
      if (profundidade === 0) return argumentos;
    } else if (c === ',' && profundidade === 1) argumentos += 1;
  }
  return -1;
}

/* ====================================================================
   AUTOTESTE — `node tests/ajudantes.js`
   Ajudante de teste também é código, e este já teve um bug que deixou
   uma varredura cega.
   ==================================================================== */
if (process.argv[1]?.endsWith('ajudantes.js')) {
  const assert = (await import('node:assert/strict')).default;
  const { dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  let checagens = 0;
  const ok = (c, m) => { assert.ok(c, m); checagens += 1; };
  const igual = (a, b, m) => { assert.deepEqual(a, b, m); checagens += 1; };

  const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

  /* --- o andador DESCE, que era o bug --- */
  const tudo = arquivosJs(join(RAIZ, 'src'));
  ok(tudo.length > 20, `achou os .js do src (achou ${tudo.length})`);
  ok(
    tudo.some((c) => c.includes(`${join('src', 'controllers')}`)),
    'desceu para src/controllers'
  );
  ok(
    tudo.some((c) => c.includes(`${join('src', 'utils')}`)),
    'e para src/utils — sem isto a varredura aprova o que não olhou'
  );
  ok(tudo.every((c) => c.endsWith('.js')), 'e devolve só .js');
  igual(
    arquivosJs(join(RAIZ, 'src', 'routes')).length,
    arquivosJs(join(RAIZ, 'src', 'routes')).filter((c) => c.endsWith('.js')).length,
    'nenhum não-.js escapa'
  );

  /* --- o contador de argumentos, com a armadilha que o gerou --- */
  igual(argumentosDe('f(a, b, c)', 1), 3, 'três argumentos simples');
  igual(argumentosDe('f(a, b, Boolean(x), 1)', 1), 4, 'quatro, com parênteses dentro de um deles');
  igual(argumentosDe('f(\n a,\n b,\n Boolean(x),\n 1\n)', 1), 4, 'e igual em várias linhas');
  igual(argumentosDe('f(a, [1, 2], { x: 1 })', 1), 3, 'vírgula dentro de lista ou objeto não conta');
  igual(argumentosDe('f()', 1), 1, 'chamada sem argumento devolve 1 (o vazio)');
  igual(argumentosDe('f(a, b', 1), -1, 'parênteses que não fecha devolve -1');

  console.log(`ajudantes: ${checagens} checagens OK`);
}
