#!/usr/bin/env node
/**
 * tests/filtro-or-so-interpola-o-que-o-servidor-fez.js
 *
 * CLASSE CR-01 da remediação da Estação 6 (JX-01): o `.or()` do PostgREST
 * recebe um TEXTO com a própria sintaxe de filtro — vírgula separa
 * condição, parêntese agrupa, ponto separa operador. Um valor de fora
 * interpolado ali não é um valor: é filtro. `a,id.neq.0` num id viraria
 * "ou qualquer linha".
 *
 * Em 25/09/2026 as dez interpolações de `src/` foram conferidas uma a uma:
 * datas calculadas no servidor (`.toISOString()`), `Number(...)`, e um id
 * que passa por `exigirIdCanonico` antes (`trocaIntencaoService`). Esta
 * checagem mantém assim: toda interpolação num `.or(\`…\`)` tem de ser uma
 * dessas três coisas, e a varredura cobre o `src/` inteiro.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arquivosJs } from './ajudantes.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let checagens = 0;
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };

/** O trecho ANTES do `.or(` onde a variável teria de nascer ou ser guardada. */
const JANELA = 40;

function interpolacoesSeguras(expr, antes) {
  const e = expr.trim();
  if (/^Number\(.+\)$/.test(e)) return 'Number()';
  if (/\.toISOString\(\)$/.test(e)) return 'data do servidor';
  if (/^[A-Za-z_$][\w$]*$/.test(e)) {
    const definicao = new RegExp(`const ${e} = [^;\\n]*toISOString\\(\\)`);
    if (definicao.test(antes)) return 'data do servidor (variável)';
    if (new RegExp(`exigirIdCanonico\\(${e}\\b`).test(antes)) return 'id canônico';
  }
  return null;
}

let vistas = 0;
const origens = {};
for (const arquivo of arquivosJs(join(RAIZ, 'src'))) {
  const linhas = readFileSync(arquivo, 'utf8').split('\n');
  linhas.forEach((linha, i) => {
    if (/^\s*(\*|\/\/)/.test(linha)) return;
    const chamada = linha.match(/\.or\(`([^`]*)`\)/);
    if (!chamada) return;
    const antes = linhas.slice(Math.max(0, i - JANELA), i + 1).join('\n');
    for (const [, expr] of chamada[1].matchAll(/\$\{([^}]*)\}/g)) {
      vistas += 1;
      const origem = interpolacoesSeguras(expr, antes);
      origens[origem ?? 'NÃO RECONHECIDA'] = (origens[origem ?? 'NÃO RECONHECIDA'] ?? 0) + 1;
      ok(origem !== null, `${relative(RAIZ, arquivo)}:${i + 1} interpola \`${expr}\` num .or() — só data do servidor, Number() ou id canônico (JX-01)`);
    }
  });
}
ok(vistas >= 10, `controle: a varredura achou as interpolações de .or() (${vistas})`);

/* Controle negativo da própria regra: o que ela tem de recusar, recusa. */
ok(interpolacoesSeguras('pedidoId', 'const x = 1;') === null, 'controle: um id cru, sem guarda, é recusado');
ok(interpolacoesSeguras('requisicao.query.dias', '') === null, 'controle: entrada de requisição é recusada');
ok(interpolacoesSeguras('chargeId', "exigirIdCanonico(chargeId, 'chargeId');") === 'id canônico', 'controle: o id guardado passa');

console.log(`filtro-or-so-interpola-o-que-o-servidor-fez: ${checagens} checagens OK (${vistas} interpolações: ${Object.entries(origens).map(([k, v]) => `${v} ${k}`).join(', ')})`);
