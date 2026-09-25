#!/usr/bin/env node
/**
 * scripts/checar.mjs — a verificação que roda ANTES de empurrar.
 *
 *   npm run check
 *
 * Não há linter no projeto (nenhuma dependência de desenvolvimento, por
 * decisão: `CONSTRAINTS.md` §2). O que dá para garantir sem instalar
 * nada é o que mais dói quando falha: arquivo que nem analisa. Erro de
 * sintaxe em `public/js/` não é pego por `npm test` — as suítes rodam o
 * backend — e só aparece no navegador do comprador.
 *
 * Sai com código 1 no primeiro problema encontrado, para servir de porta
 * em CI e em gancho de commit.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

const PASTAS_JS = ['src', 'public/js', 'functions', 'scripts', 'tests']; // functions/: as Pages Functions (o proxy do admin atrás do Access, SEC-015)
const JSON_SOLTOS = ['package.json', 'public/site.webmanifest'];

function arquivos(pasta, extensoes) {
  const saida = [];
  for (const item of readdirSync(join(RAIZ, pasta), { withFileTypes: true })) {
    const caminho = join(pasta, item.name);
    if (item.isDirectory()) saida.push(...arquivos(caminho, extensoes));
    else if (extensoes.includes(extname(item.name))) saida.push(caminho);
  }
  return saida;
}

let problemas = 0;

for (const pasta of PASTAS_JS) {
  for (const arquivo of arquivos(pasta, ['.js', '.mjs'])) {
    const r = spawnSync(process.execPath, ['--check', arquivo], { cwd: RAIZ, encoding: 'utf8' });
    if (r.status !== 0) {
      problemas += 1;
      console.log(`FALHOU  ${arquivo}`);
      console.log(`${r.stderr ?? ''}`.trim().split('\n').map((l) => `          ${l}`).join('\n'));
    }
  }
}

for (const arquivo of JSON_SOLTOS) {
  try {
    JSON.parse(readFileSync(join(RAIZ, arquivo), 'utf8'));
  } catch (erro) {
    problemas += 1;
    console.log(`FALHOU  ${arquivo}\n          ${erro.message}`);
  }
}

const total = PASTAS_JS.flatMap((p) => arquivos(p, ['.js', '.mjs'])).length + JSON_SOLTOS.length;

console.log(
  problemas === 0
    ? `${total} arquivos analisados — nenhum erro de sintaxe.`
    : `${problemas} de ${total} arquivos com problema.`
);

process.exit(problemas === 0 ? 0 : 1);
