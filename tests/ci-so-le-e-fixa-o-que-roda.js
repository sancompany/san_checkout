#!/usr/bin/env node
/**
 * tests/ci-so-le-e-fixa-o-que-roda.js
 *
 * CLASSE CR-13 da remediação da Estação 6 (SEC-034): o que o CI executa é
 * código de terceiro, e ele roda com o token deste repositório.
 *
 *   - toda ação (`uses:`) fixada por SHA de 40 caracteres, nunca por tag
 *     (tag é referência móvel: foi assim no trivy-action e no
 *     kics-github-action);
 *   - todo workflow declara `permissions:` — sem isso o token tem as
 *     permissões padrão do repositório, que podem ser de escrita;
 *   - imagem de contêiner fixada por digest;
 *   - binário baixado conferido por `sha256sum --check` antes de rodar.
 *
 * Checagem de TEXTO sobre `.github/workflows/`, grosseira de propósito.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASTA = join(RAIZ, '.github/workflows');
let checagens = 0;
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };

const workflows = readdirSync(PASTA).filter((n) => /\.ya?ml$/.test(n));
ok(workflows.length >= 2, `controle: achou os workflows (${workflows.join(', ')})`);

let acoes = 0; let conteineres = 0; let downloads = 0;
for (const nome of workflows) {
  const texto = readFileSync(join(PASTA, nome), 'utf8');
  const semComentario = texto.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  ok(/^permissions:\s*$/m.test(semComentario), `${nome}: declara \`permissions:\` no topo — sem isso o token do CI herda o padrão do repositório`);
  ok(!/permissions:\s*write-all/.test(semComentario), `${nome}: nada de write-all`);

  for (const [, ref] of semComentario.matchAll(/uses:\s*([^\s#]+)/g)) {
    acoes += 1;
    ok(/@[0-9a-f]{40}$/.test(ref), `${nome}: \`${ref}\` fixada por SHA de 40 caracteres, não por tag`);
  }
  for (const [, imagem] of semComentario.matchAll(/container:\s*([^\s#]+)/g)) {
    conteineres += 1;
    ok(/@sha256:[0-9a-f]{64}$/.test(imagem), `${nome}: a imagem \`${imagem}\` fixada por digest`);
  }
  for (const linha of semComentario.split('\n').filter((l) => /curl\b[^\n]*https?:\/\//.test(l))) {
    downloads += 1;
    ok(/sha256sum --check/.test(semComentario), `${nome}: o que é baixado por curl (${linha.trim().slice(0, 60)}…) é conferido por sha256sum antes de rodar`);
    ok(!/curl[^\n]*\|\s*(tar|sh|bash)\b/.test(semComentario), `${nome}: nada baixado vai direto para tar/sh sem conferência`);
  }
}
ok(acoes >= 4, `controle: a varredura achou as ações (${acoes})`);
ok(conteineres >= 1 && downloads >= 1, `controle: e o contêiner (${conteineres}) e o download (${downloads}) do job de segurança`);

ok(existsSync(join(RAIZ, '.github/dependabot.yml')), 'o Dependabot existe — SHA fixo não se atualiza sozinho, nem quando a versão fixada ganha correção de segurança');
const dependabot = readFileSync(join(RAIZ, '.github/dependabot.yml'), 'utf8');
ok(/package-ecosystem:\s*npm/.test(dependabot) && /package-ecosystem:\s*github-actions/.test(dependabot), 'e cobre as dependências do npm e as ações do GitHub');
const blocos = dependabot.split(/\n\s*- package-ecosystem:/).slice(1);
ok(blocos.length >= 2 && blocos.every((b) => /cooldown:\s*\n\s*default-days:\s*([7-9]|[1-9]\d+)\b/.test(b)), 'e cada ecossistema espera 7 dias antes de propor versão nova (cooldown) — o pacote sequestrado costuma cair nesses dias');

console.log(`ci-so-le-e-fixa-o-que-roda: ${checagens} checagens OK (${acoes} ações, ${conteineres} contêiner, ${downloads} download)`);
