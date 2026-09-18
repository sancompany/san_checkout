#!/usr/bin/env node
/**
 * tests/documento-e-uma-chave-so.js
 *
 * `552.085.198-01` e `55208519801` são o MESMO CPF. Os dois passam em
 * `documentoValido` (ela tira a pontuação para validar), e até
 * 17/09/2026 os dois eram gravados como vieram — duas chaves diferentes
 * para a mesma pessoa.
 *
 * O dano está no caminho do dinheiro. A assinatura é localizada por
 * `contratante_id + plano_id + documento` (`API.md` §5.5): quem assinasse
 * mandando o CPF pontuado e depois pedisse cancelamento mandando só
 * dígitos receberia `404` — assinatura que existe, está cobrando, e não
 * pode mais ser cancelada pela API. É o mesmo desfecho do furo de
 * "pausar era porta de mão única" de 15/09, por outra porta. E vale nos
 * dois sentidos.
 *
 * Passava despercebido porque a máscara do front tira a pontuação antes
 * de enviar — as 13 linhas de `documento` em produção em 17/09/2026 são
 * todas só dígitos, medido. Mas a máscara é do navegador e a API é
 * pública: quem chama direto manda o que quiser.
 *
 * ── Por que este teste é varredura de texto-fonte ──────────────────
 * A regra não é sobre UMA função, é sobre TODA fronteira que aceita
 * `documento` — hoje oito, em quatro controladores, e amanhã a nona.
 * Um teste comportamental cobriria a fronteira que eu lembrasse de
 * cobrir; a varredura cobre a que alguém escrever depois de mim. É a
 * mesma forma, e o mesmo motivo, de `nenhuma-chamada-de-saida-sem-teto.js`.
 *
 * O autoteste de `normalizarDocumento` em `utils/validadores.js` prova a
 * FUNÇÃO. Este prova a FIAÇÃO — e a distinção não é acadêmica: em 16/09
 * uma sabotagem passou justamente porque o teste exercitava a função
 * direto em vez do caminho que a produção usa.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizarDocumento } from '../src/utils/validadores.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let checagens = 0;
const ok = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };
const igual = (a, b, mensagem) => { assert.deepEqual(a, b, mensagem); checagens += 1; };

/* ------------------------------------------------------------------
   1. TODA FRONTEIRA QUE VALIDA `documento` TAMBÉM O NORMALIZA
------------------------------------------------------------------ */

const DIR = join(RAIZ, 'src', 'controllers');

/** Recorta o corpo de cada função de nível superior (e das internas de
 *  uma fábrica, que é como `assinaturaController` monta pausar/retomar). */
function funcoesDe(fonte) {
  const marcas = [...fonte.matchAll(/^(?:export )?(?:async )?function \w+|^\s*return async function \w+/gm)];
  return marcas.map((m, i) => ({
    nome: m[0].trim().replace(/^(?:export )?(?:return )?(?:async )?function /, ''),
    corpo: fonte.slice(m.index, marcas[i + 1]?.index ?? fonte.length)
  }));
}

let fronteiras = 0;
const desprotegidas = [];

for (const arquivo of readdirSync(DIR).filter((n) => n.endsWith('.js'))) {
  const fonte = readFileSync(join(DIR, arquivo), 'utf8');

  for (const { nome, corpo } of funcoesDe(fonte)) {
    const valida = corpo.indexOf('documentoValido(documento)');
    if (valida === -1) continue;

    fronteiras += 1;
    const normaliza = corpo.indexOf('documento = normalizarDocumento(documento)');

    if (normaliza === -1 || normaliza < valida) {
      desprotegidas.push(`${arquivo}:${nome}`);
    }
  }
}

/* CONTROLE POSITIVO. Sem isto a varredura passaria calada no dia em que
   a regex deixasse de casar — que é exatamente o que aconteceu com
   `valor-vem-do-servidor.js` nesta mesma rodada, quando os blocos
   viraram `let`: ela só não passou calada porque tinha este controle. */
ok(fronteiras >= 8, `a varredura precisa ACHAR as fronteiras para significar algo (achou ${fronteiras}, esperado >= 8)`);

igual(
  desprotegidas, [],
  'fronteira que valida `documento` e não o normaliza: a assinatura criada com uma forma responde 404 para quem cancela com a outra'
);

/* A normalização tem de vir DEPOIS da validação, não antes: validar já
   normalizado esconderia entrada absurda. Conferido pela ordem acima —
   e aqui o contrário, para a checagem não ser vazia. */
const exemplo = readFileSync(join(DIR, 'checkoutController.js'), 'utf8');
ok(
  exemplo.indexOf('documentoValido(documento)') < exemplo.indexOf('documento = normalizarDocumento(documento)'),
  'valida primeiro, normaliza depois'
);

/* ------------------------------------------------------------------
   1.1 NINGUÉM REIMPLEMENTA A NORMALIZAÇÃO

   A regra "documento é uma chave só, em dígitos" tem de ter UM dono. O
   `adminController` tinha a sua própria cópia do mesmo `replace`, e cópia
   é como uma regra passa a valer em um lugar menos: quem mexer no dono
   não encontra a cópia. Mesmo argumento dos tetos de campo em
   `utils/validadores.js`.
------------------------------------------------------------------ */

const copias = [];
for (const arquivo of readdirSync(DIR).filter((n) => n.endsWith('.js'))) {
  const fonte = readFileSync(join(DIR, arquivo), 'utf8');
  for (const linha of fonte.split('\n')) {
    if (linha.trim().startsWith('*') || linha.trim().startsWith('//')) continue;
    if (/documento[^\n]*\.replace\(\s*\/\\D\/g/i.test(linha)) copias.push(`${arquivo} — ${linha.trim()}`);
  }
}
igual(copias, [], 'controlador reimplementando a normalização do documento em vez de chamar `normalizarDocumento`');

/* ------------------------------------------------------------------
   2. NENHUMA BUSCA POR `documento` ACEITA A FORMA PONTUADA

   As duas consultas que localizam por documento moram nos serviços. Elas
   recebem o valor já normalizado pelo controlador — mas se alguém um dia
   chamar uma delas com o texto cru do corpo, o `404` silencioso volta.
   O que se trava aqui é a existência das duas, para a lista não
   envelhecer calada.
------------------------------------------------------------------ */

const BUSCAS = [
  ['src/services/assinaturaService.js', "eq('documento', documento)"],
  ['src/services/cobrancaService.js', "eq('documento', documento)"]
];
for (const [arquivo, trecho] of BUSCAS) {
  const fonte = readFileSync(join(RAIZ, arquivo), 'utf8');
  ok(fonte.includes(trecho), `${arquivo} continua localizando por documento — se isto mudar, revise a normalização`);
}

/* ------------------------------------------------------------------
   3. O EFEITO, medido na função
------------------------------------------------------------------ */

igual(
  normalizarDocumento('552.085.198-01'), normalizarDocumento('55208519801'),
  'as duas formas do mesmo CPF colapsam na mesma chave'
);
igual(
  normalizarDocumento('11.222.333/0001-81'), normalizarDocumento('11222333000181'),
  'e as duas do mesmo CNPJ também'
);
ok(
  normalizarDocumento('552.085.198-01') !== normalizarDocumento('11144477735'),
  'controle positivo: CPFs DIFERENTES continuam sendo chaves diferentes'
);
igual(normalizarDocumento('55208519801').length, 11, 'CPF normalizado tem 11 dígitos');
igual(normalizarDocumento('11222333000181').length, 14, 'CNPJ normalizado tem 14');

console.log(`documento-e-uma-chave-so: ${checagens} checagens OK (${fronteiras} fronteiras varridas)`);
