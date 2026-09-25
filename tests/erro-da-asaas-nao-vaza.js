#!/usr/bin/env node
/**
 * tests/erro-da-asaas-nao-vaza.js
 *
 * CLASSE CR-12 da remediação da Estação 6 (SEC-028, INFO-11): o que a
 * Asaas responde num erro chegava cru a dois lugares.
 *
 *   SEC-028 — ao LOG. `chamarAsaas` já redigia o resumo que ele mesmo
 *   logava, mas a mensagem do erro (a descrição da Asaas) ia crua para o
 *   `console.error` de `responderErro`, e os controladores de cartão e
 *   assinatura logavam o `corpoAsaas` inteiro por fora da redação.
 *
 *   INFO-11 — a QUEM CHAMOU. Um `401` da Asaas (a NOSSA chave recusada)
 *   chegava ao contratante como `401` — que o `API.md` define como a
 *   `X-Checkout-Key` DELE inválida —, e um 5xx levava o texto interno
 *   dela.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arquivosJs } from './ajudantes.js';

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? 'teste';
process.env.ASAAS_API_KEY = 'chave-de-teste';
process.env.ASAAS_AMBIENTE = 'sandbox';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let checagens = 0;
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };
const igual = (a, b, m) => { assert.deepEqual(a, b, m); checagens += 1; };

const { redigirTextoDaAsaas, consultarStatus } = await import('../src/services/asaasService.js');
const { responderErro } = await import('../src/utils/erros.js');

const EMAIL = 'fulana.de.tal@provedor.exemplo';
const CPF = '111.444.777-35';

/* ---- a redação ---- */
{
  const r = redigirTextoDaAsaas(`O cliente ${EMAIL} (CPF ${CPF}, fone 16 98765-4321) é inválido`);
  ok(!r.includes(EMAIL) && !r.includes(CPF) && !r.includes('98765'), `e-mail, CPF e telefone saem (${r})`);
  ok(r.includes('[email]') && r.includes('[numero]'), 'e ficam marcados no lugar');
  igual(redigirTextoDaAsaas('O valor mínimo é R$ 5,00'), 'O valor mínimo é R$ 5,00', 'controle: texto sem dado de pessoa passa intacto');
}

/* ---- a mensagem do erro sai de `chamarAsaas` já redigida ---- */
const logs = [];
const erroOriginal = console.error;
console.error = (...partes) => { logs.push(partes.map(String).join(' ')); };
const fetchOriginal = globalThis.fetch;
let respostaDaAsaas;
globalThis.fetch = async (url) => {
  if (String(url).includes('asaas.com')) return respostaDaAsaas();
  throw new Error('rede fora do teste');
};
try {
  respostaDaAsaas = () => new Response(JSON.stringify({ errors: [{ code: 'invalid_customer', description: `O e-mail ${EMAIL} do CPF ${CPF} não confere` }] }), { status: 400, headers: { 'content-type': 'application/json' } });
  let capturado = null;
  await consultarStatus('pay_abc123').catch((e) => { capturado = e; });
  ok(capturado && capturado.status === 400, 'controle: a Asaas recusou (400)');
  ok(!capturado.message.includes(EMAIL) && !capturado.message.includes(CPF), `SEC-028: a mensagem do erro vem redigida (${capturado.message})`);
  ok(capturado.corpoAsaas?.errors?.[0]?.code === 'invalid_customer', 'e o corpo segue no erro para quem classifica (código, não texto)');

  /* ---- a resposta a quem chamou ---- */
  const res = () => ({ _s: null, _j: null, req: { method: 'POST', baseUrl: '/api/checkout', route: { path: '/x' } }, status(c) { this._s = c; return this; }, json(o) { this._j = o; return this; } });

  let r = res();
  responderErro(r, capturado, 'teste/400');
  igual(r._s, 400, 'recusa de validação da Asaas segue 400 — o pagador precisa saber o que corrigir');
  ok(!JSON.stringify(r._j).includes(EMAIL), 'e sem o e-mail');

  respostaDaAsaas = () => new Response(JSON.stringify({ errors: [{ code: 'invalid_access_token', description: 'A chave de API fornecida é inválida' }] }), { status: 401, headers: { 'content-type': 'application/json' } });
  let e401 = null;
  await consultarStatus('pay_abc123').catch((e) => { e401 = e; });
  r = res();
  responderErro(r, e401, 'teste/401');
  igual(r._s, 502, 'INFO-11: a NOSSA chave recusada pela Asaas é 502 para quem chamou, não 401');
  ok(!/chave de API/i.test(r._j.erro), `e o texto da Asaas não passa (${r._j.erro})`);

  respostaDaAsaas = () => new Response(JSON.stringify({ errors: [{ description: 'NullPointerException at br.com.asaas.Payment' }] }), { status: 500, headers: { 'content-type': 'application/json' } });
  let e500 = null;
  await consultarStatus('pay_abc123').catch((e) => { e500 = e; });
  r = res();
  responderErro(r, e500, 'teste/500');
  igual(r._s, 502, 'INFO-11: 5xx da Asaas é 502');
  ok(!/NullPointer/.test(JSON.stringify(r._j)), 'e o detalhe interno dela não chega a quem chamou');

  r = res();
  responderErro(r, Object.assign(new Error('X-Checkout-Key inválida.'), { status: 401 }), 'teste/nosso-401');
  igual(r._s, 401, 'controle: um 401 NOSSO (sem origem na Asaas) continua 401');

  await new Promise((x) => setTimeout(x, 50));
  ok(logs.length > 0, 'controle: houve log');
  ok(!logs.some((l) => l.includes(EMAIL) || l.includes(CPF)), 'SEC-028: nenhuma linha de log leva o e-mail ou o CPF que a Asaas ecoou');
} finally {
  console.error = erroOriginal;
  globalThis.fetch = fetchOriginal;
}

/* ---- ninguém loga o corpo cru da Asaas por fora ---- */
{
  let achados = 0;
  for (const arquivo of arquivosJs(join(RAIZ, 'src'))) {
    const fonte = readFileSync(arquivo, 'utf8');
    for (const [linha] of fonte.matchAll(/console\.(?:log|error|warn)\([^\n]*corpoAsaas[^\n]*/g)) {
      achados += 1;
      ok(false, `${arquivo.slice(RAIZ.length + 1)} loga o corpo cru da Asaas: ${linha.trim().slice(0, 100)}`);
    }
  }
  ok(achados === 0, 'SEC-028: nenhum console.* de src/ leva `corpoAsaas` — o que vai ao log é o resumo redigido de `chamarAsaas`');
}

console.log(`erro-da-asaas-nao-vaza: ${checagens} checagens OK`);
