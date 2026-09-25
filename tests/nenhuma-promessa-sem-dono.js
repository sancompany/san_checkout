#!/usr/bin/env node
/**
 * tests/nenhuma-promessa-sem-dono.js
 *
 * CLASSE CR-06 da remediação da Estação 6 (SEC-013): efeito assíncrono
 * sem dono.
 *
 * O furo: três avisos ao contratante (cancelamento, troca de plano
 * imediata, troca aprovada) eram chamados sem `await` nem `.catch`.
 * `enfileirarNotificacao` lança quando o banco recusa; a promessa
 * rejeitada não tinha quem a observasse, e o tratador de
 * `unhandledRejection` do `server.js` derruba o processo de propósito
 * (Lei 8, `tests/o-processo-nao-morre-calado.js`). O comentário ao lado
 * dele dizia "todos têm `catch` hoje" — e três não tinham.
 *
 * Uma afirmação daquelas envelhece no primeiro PR. Esta suíte varre o
 * `src/` inteiro e exige, para toda chamada de função `async` em posição
 * de instrução, um dono: `await`, `return`, ou `.catch(` na mesma
 * instrução. E toda função `async` passada crua a `setInterval`/
 * `setTimeout` é recusada — o timer descarta a promessa.
 *
 * A única exceção nomeada é `registrarErro`, cujo contrato é nunca lançar
 * (tem `try/catch` por fora de tudo) — e isso é conferido aqui também,
 * contra o código, não contra a palavra.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let checagens = 0;
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };

/** Funções que NUNCA rejeitam — cada uma com o motivo conferido abaixo. */
const NUNCA_REJEITAM = {
  registrarErro: 'src/services/erroService.js'
};

function arquivosJs(dir) {
  return readdirSync(join(RAIZ, dir), { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? arquivosJs(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []
  ));
}

/** A parte de PRODUÇÃO do módulo (o autoteste, no fim, fica de fora). */
const producao = (fonte) => fonte.split(/\nif \(process\.argv\[1\]/)[0];

/** Nomes de toda função `async` declarada: `async function x`, `x: async (`, `const x = async (`. */
function funcoesAssincronas(fontes) {
  const nomes = new Set();
  for (const fonte of fontes) {
    for (const m of fonte.matchAll(/async function (\w+)/g)) nomes.add(m[1]);
    for (const m of fonte.matchAll(/(\w+)\s*[:=]\s*async\s*(?:\(|\w+\s*=>)/g)) nomes.add(m[1]);
  }
  return nomes;
}

/**
 * As chamadas sem dono de um arquivo. Instrução que COMEÇA com a chamada
 * (`x(...)`, `deps.x(...)`), sem `await`/`return`/`void` antes e sem
 * `.catch(` até o fim da instrução. Linha que continua uma lista de
 * argumentos (a anterior termina em `[`, `(` ou `,`) não é instrução.
 */
function semDono(fonte, assincronas) {
  const linhas = fonte.split('\n');
  const achados = [];
  linhas.forEach((linha, i) => {
    const m = linha.match(/^\s*(?:deps(?:\.\w+)*\.)?(\w+)\(/);
    if (!m || !assincronas.has(m[1]) || NUNCA_REJEITAM[m[1]]) return;
    const anterior = linhas.slice(0, i).reverse().find((l) => l.trim() && !l.trim().startsWith('//'))?.trim() ?? '';
    if (/[[(,]$/.test(anterior) || /=>$/.test(anterior) || /[?:]$/.test(anterior) || /=$/.test(anterior)) return;
    // a instrução vai até a primeira linha que fecha o nível de parênteses aberto aqui
    let nivel = 0; let fim = i;
    for (let j = i; j < Math.min(linhas.length, i + 40); j += 1) {
      for (const c of linhas[j]) { if (c === '(') nivel += 1; if (c === ')') nivel -= 1; }
      fim = j;
      if (nivel <= 0) break;
    }
    const instrucao = linhas.slice(i, fim + 1).join('\n') + '\n' + (linhas[fim + 1] ?? '');
    if (/\??\.catch\??\.?\(/.test(instrucao)) return;
    achados.push(`${i + 1}: ${linha.trim().slice(0, 90)}`);
  });
  for (const m of fonte.matchAll(/set(?:Interval|Timeout)\(\s*(\w+)\s*,/g)) {
    if (assincronas.has(m[1]) && !NUNCA_REJEITAM[m[1]]) achados.push(`timer com função async crua: set…(${m[1]}, …)`);
  }
  return achados;
}

const arquivos = arquivosJs('src');
const fontes = Object.fromEntries(arquivos.map((a) => [a, producao(readFileSync(join(RAIZ, a), 'utf8'))]));
const assincronas = funcoesAssincronas(Object.values(fontes));
ok(assincronas.size > 50, `a varredura achou as funções async do projeto (${assincronas.size})`);
for (const nome of ['notificarAssinaturaCancelada', 'notificarPlanoTrocado', 'enfileirarNotificacao', 'retomarAplicacao', 'sincronizarTaxasAsaas']) {
  ok(assincronas.has(nome), `${nome} está no conjunto das async — senão a varredura não o vigiaria`);
}

/* ---- controle positivo: o detector ACUSA o furo como ele era ---- */
{
  const comoEra = [
    "      await deps.atualizarStatusAssinatura(assinatura.id, 'cancelada');",
    '      deps.notificarAssinaturaCancelada(contratante, {',
    '        planoId, documento',
    '      });',
    '  sincronizarTaxasAsaas();',
    '  setInterval(sincronizarTaxasAsaas, UM_DIA_MS).unref();'
  ].join('\n');
  const acusados = semDono(comoEra, assincronas);
  ok(acusados.length === 3, `controle: o detector acusa as três formas do furo (${acusados.join(' | ')})`);
  const comDono = [
    '      await deps.notificarAssinaturaCancelada(contratante, {});',
    '      return deps.notificarPlanoTrocado(contratante, {});',
    '      retomarAplicacao(confirmada).catch((erro) => registrarErro(erro));',
    '      deps.notificarPlanoTrocado(c, {',
    '      }).catch(() => {});',
    '  const x = [',
    '    enfileirarNotificacao(a),',
    '  ];'
  ].join('\n');
  ok(semDono(comDono, assincronas).length === 0, `controle: com dono, nada é acusado (${semDono(comDono, assincronas).join(' | ')})`);
}

/* ---- a varredura de verdade ---- */
for (const [arquivo, fonte] of Object.entries(fontes)) {
  const achados = semDono(fonte, assincronas);
  ok(achados.length === 0, `${arquivo}: promessa sem dono —\n  ${achados.join('\n  ')}`);
}

/* ---- a exceção nomeada é conferida contra o código ---- */
for (const [nome, arquivo] of Object.entries(NUNCA_REJEITAM)) {
  const fonte = fontes[arquivo];
  // os parâmetros podem ter `{}` (default), mas não `)`: o corpo começa no `{` depois do `)`
  const comecoDoCorpo = new RegExp(`export async function ${nome}\\([^)]*\\)\\s*\\{\\s*try\\s*\\{`);
  ok(comecoDoCorpo.test(fonte), `${nome} só pode ficar sem dono se o corpo INTEIRO estiver num try — e está`);
  const antesDoFim = fonte.slice(fonte.indexOf(`export async function ${nome}(`)).split(/\n\}\n/)[0];
  ok(/\} catch \(\w+\) \{[\s\S]*$/.test(antesDoFim), `${nome}: e o try termina num catch que não relança`);
  ok(!/\bthrow\b/.test(antesDoFim.slice(antesDoFim.lastIndexOf('} catch'))), `${nome}: o catch não relança`);
}

/* ---- o comentário que afirmava o contrário não volta ---- */
ok(!/Todos têm `catch` hoje/.test(readFileSync(join(RAIZ, 'src/server.js'), 'utf8')), 'a frase falsa do server.js não volta');

console.log(`nenhuma-promessa-sem-dono: ${checagens} checagens OK (${arquivos.length} arquivos, ${assincronas.size} funções async)`);
