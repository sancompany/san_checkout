#!/usr/bin/env node
/**
 * tests/data-para-asaas-e-de-brasilia.js
 *
 * Nenhuma data que vai para a Asaas sai do relógio do processo.
 *
 * ── Por que isto virou teste, em 25/09/2026 ─────────────────────────
 * Primeiro pagamento real de assinatura, às 22:26 de Brasília. O
 * `nextDueDate` era montado com `getFullYear()/getDate()/getHours()` —
 * o relógio do PROCESSO, que roda em UTC (medido no contêiner em
 * 16/09, `src/utils/diaCivil.js`). Em UTC já eram 01:26 do dia 25: a
 * Asaas recebeu vencimento "amanhã", a sessão da pop-up fechou com
 * sucesso e o cartão NÃO foi cobrado — o primeiro ciclo ficou `PENDING`
 * para o dia seguinte. `dataDeHoje()` (Pix, acerto de troca) e o
 * vencimento do boleto tinham o mesmo defeito por `toISOString()`.
 *
 * A regra já era conhecida — `diaCivil.js` existe desde 16/09 por causa
 * da métrica — e não foi aplicada no caminho do dinheiro. Por isso a
 * checagem varre `src/` inteiro em vez de confiar em memória (mesmo
 * argumento de `nenhuma-chamada-de-saida-sem-teto.js`): fora de
 * `diaCivil.js`, nenhum arquivo pode ler dia/hora do relógio local nem
 * cortar `toISOString()` em data.
 *
 * `toISOString()` inteiro continua permitido: é instante absoluto, com
 * `Z`, e é o que se grava em banco. O proibido é tirar DIA dele.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { arquivosJs } from './ajudantes.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGEM = join(RAIZ, 'src');
const PERMITIDO = join(ORIGEM, 'utils', 'diaCivil.js');

/* Leitura de dia/hora no fuso do processo, ou dia recortado do ISO. */
const PROIBIDOS = [
  /\.get(FullYear|Month|Date|Day|Hours|Minutes|Seconds)\(\)/,
  /\.set(FullYear|Month|Date|Hours)\(/,
  /toISOString\(\)\s*\.\s*(slice|substring|substr)\(\s*0\s*,\s*10\s*\)/,
  /toISOString\(\)\s*\.\s*split\(\s*['"]T['"]\s*\)/,
  /toLocaleDateString\(\s*\)/
];

function achados(texto) {
  const lista = [];
  texto.split('\n').forEach((linha, i) => {
    const codigo = linha.replace(/\/\/.*$/, '');
    if (/^\s*\*/.test(codigo)) return; // corpo de comentário em bloco
    if (PROIBIDOS.some((re) => re.test(codigo))) lista.push({ linha: i + 1, texto: linha.trim() });
  });
  return lista;
}

let checagens = 0;

/* Controle positivo: o detector acha os DOIS padrões do incidente. */
assert.equal(achados('const d = `${data.getFullYear()}-${data.getDate()}`;').length, 1, 'controle: getFullYear/getDate');
assert.equal(achados('  return new Date().toISOString().slice(0, 10);').length, 1, 'controle: toISOString().slice(0, 10)');
assert.equal(achados('  data.setDate(data.getDate() + 3);').length, 1, 'controle: setDate/getDate');
assert.equal(achados('criado_em: new Date().toISOString(),').length, 0, 'controle negativo: instante absoluto é permitido');
assert.equal(achados('// antes era getDate() do processo').length, 0, 'controle negativo: comentário não conta');
checagens += 5;

let arquivos = 0;
const violacoes = [];
for (const caminho of arquivosJs(ORIGEM)) {
  if (caminho === PERMITIDO) continue;
  arquivos += 1;
  for (const a of achados(readFileSync(caminho, 'utf8'))) violacoes.push(`${relative(RAIZ, caminho)}:${a.linha}  ${a.texto}`);
}
assert.ok(arquivos > 30, `controle: a varredura precisa alcançar src/ inteiro (alcançou ${arquivos})`);
checagens += 1;
assert.deepEqual(violacoes, [], 'data lida do relógio do processo (UTC) — use src/utils/diaCivil.js:\n  ' + violacoes.join('\n  '));
checagens += 1;

/* Os três pontos do incidente usam o relógio de Brasília. */
const checkout = readFileSync(join(ORIGEM, 'controllers', 'asaasCheckoutController.js'), 'utf8');
assert.match(checkout, /nextDueDate:\s*dataHoraCivil\(\)/, 'nextDueDate da assinatura precisa vir de dataHoraCivil()');
const servico = readFileSync(join(ORIGEM, 'services', 'asaasService.js'), 'utf8');
assert.match(servico, /function dataDeHoje\(\)\s*\{\s*return hojeCivil\(\);/, 'dataDeHoje() precisa ser o dia de Brasília');
assert.match(servico, /diaCivilAntes\(hojeCivil\(\), -DIAS_VENCIMENTO_BOLETO\)/, 'vencimento do boleto precisa partir do dia de Brasília');
checagens += 3;

console.log(`data-para-asaas-e-de-brasilia: ${checagens} checagens OK (${arquivos} arquivos de src/)`);
