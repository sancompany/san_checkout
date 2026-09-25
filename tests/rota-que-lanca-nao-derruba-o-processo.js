#!/usr/bin/env node
/**
 * tests/rota-que-lanca-nao-derruba-o-processo.js
 *
 * CLASSE CR-13 da remediação da Estação 6 (C1-01, achado no ciclo
 * adversarial 1 de 25/09/2026): handler assíncrono do Express sem dono.
 *
 * O furo: o Express 4 NÃO observa a promessa que um handler `async`
 * devolve. Uma exceção ali dentro vira rejeição sem dono, e o tratador de
 * `unhandledRejection` do `server.js` derruba o processo de propósito
 * (Lei 8, `tests/o-processo-nao-morre-calado.js`). Com UMA instância, um
 * pedido que faça qualquer handler lançar derruba o checkout, o receptor
 * de webhook e os workers juntos — e repetir mantém tudo no chão.
 *
 * Quem achou: um JWT com `alg` = `{"toString":0}`. A guarda do Access
 * interpolava o `alg` num texto de log (`\`alg ${alg}\``), a
 * interpolação lança `TypeError`, e a guarda roda ANTES de todo limitador
 * e sem login nenhum. Mas o `alg` é só a porta: onze handlers do admin
 * não tinham `try` nenhum, e quase todos os públicos tinham instruções
 * antes do `try`. Corrigir a linha deixaria a classe aberta.
 *
 * A correção é na raiz: `comRejeicaoTratada` (`src/utils/rotaSegura.js`)
 * envolve TODO handler registrado no `app` e em todo roteador, e manda o
 * que ele lançar — síncrono ou assíncrono — para o tratador de erro do
 * fim da pilha (500 genérico, linha em `erros`). Aqui:
 *   1. a porta que achou: o JWT forjado contra o `server.js` DE VERDADE,
 *      em processo filho (de dentro não dá para provar que ele não morre);
 *   2. a classe: um roteador com handler que lança dos três jeitos;
 *   3. a cobertura: nenhum `Router()` nem `express()` em `src/` fica sem
 *      a proteção.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arquivosJs } from './ajudantes.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let checagens = 0;
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };
const igual = (a, b, m) => { assert.deepEqual(a, b, m); checagens += 1; };

async function filho(codigo, { importar = null, ...extra } = {}) {
  const p = spawn(process.execPath, [...(importar ? ['--import', importar] : []), '--input-type=module', '-e', codigo], {
    cwd: RAIZ,
    env: { ...process.env, CHECKOUT_SEM_LISTEN: '1', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_KEY: 'teste', ASAAS_API_KEY: 'chave-de-teste', ASAAS_AMBIENTE: 'sandbox', ...extra }
  });
  let stdout = ''; let stderr = '';
  p.stdout.on('data', (c) => { stdout += c; });
  p.stderr.on('data', (c) => { stderr += c; });
  const [status] = await once(p, 'close');
  const linha = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  return { status, resultado: linha ? JSON.parse(linha) : null, stderr };
}

/* ---- 1. a porta que achou: o JWT forjado contra o server.js real ---- */
const jwtVenenoso = (cabecalho) => `${Buffer.from(JSON.stringify(cabecalho)).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.AAAA`;
const venenos = {
  algObjeto: jwtVenenoso({ alg: { toString: 0 }, kid: 'kid-do-access-de-teste' }),
  kidObjeto: jwtVenenoso({ alg: 'RS256', kid: { toString: 0 } }),
  algComQuebraDeLinha: jwtVenenoso({ alg: 'HS256\n[admin/access] JWT aceito para operador@x', kid: 'k' })
};
const real = await filho(`
  const { subirAccessDeTeste } = await import('./tests/access-de-teste.js');
  await subirAccessDeTeste();
  const avisos = [];
  const avisoOriginal = console.warn;
  console.warn = (...a) => { avisos.push(a.join(' ')); };
  const { app } = await import('./src/server.js');
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const base = 'http://127.0.0.1:' + servidor.address().port;
  const venenos = ${JSON.stringify(venenos)};
  const respostas = {};
  for (const [nome, jwt] of Object.entries(venenos)) {
    const r = await fetch(base + '/api/admin/sessao', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': jwt }, body: '{}' });
    respostas[nome] = r.status;
    await new Promise((r) => setTimeout(r, 50));
  }
  const vivo = await fetch(base + '/api/saude').then((r) => r.status, () => 'morto');
  servidor.close();
  console.warn = avisoOriginal;
  console.log(JSON.stringify({ respostas, vivo, avisos }));
  process.exit(0);
`);
ok(real.status === 0 && real.resultado, `C1-01: o server.js real sobrevive aos JWTs forjados (saiu ${real.status}; ${real.stderr.split('\n').find((l) => /TypeError|morrer|unhandled/i.test(l)) ?? ''})`);
igual(real.resultado?.respostas, { algObjeto: 401, kidObjeto: 401, algComQuebraDeLinha: 401 }, 'C1-01: e cada um recebe a recusa de sempre do Access (401), não 500 nem queda');
ok(real.resultado && real.resultado.vivo !== 'morto', 'e depois deles o processo ainda responde');
const logDoAccess = (real.resultado?.avisos ?? []).filter((l) => l.includes('[admin/access]'));
ok(logDoAccess.length >= 3 && logDoAccess.every((l) => !l.includes('\n')), 'o motivo da recusa não injeta linha no log (o alg não é interpolado cru)');
ok(logDoAccess.every((l) => !/JWT aceito/.test(l)), 'e o texto do atacante não aparece no log como se fosse nosso');

/* ---- 1b. o INVÓLUCRO no server.js real, não só o decodificador (C2-L5) ----
   A parte 1 passa com a correção do decodificador sozinha — o JWT
   venenoso nunca chega a lançar. Aqui um handler DE VERDADE rejeita: a
   listagem do admin não tem `try`, e o cliente do banco (o falso, com
   exceção injetada) LANÇA no meio dela. Sem o invólucro, é
   `unhandledRejection` e o processo morre. */
const pasta = mkdtempSync(join(tmpdir(), 'rota-que-lanca-'));
const banco = join(pasta, 'banco.json');
writeFileSync(banco, JSON.stringify({ tabelas: { contratantes: [] }, lancar: { 'contratantes.select': 1 } }));
const realRejeita = await filho(`
  const { gerarHashSenha } = await import('./src/utils/senhaAdmin.js');
  process.env.CHECKOUT_ADMIN_USER = 'op'; process.env.CHECKOUT_ADMIN_PASS_HASH = await gerarHashSenha('senha-do-teste');
  const { subirAccessDeTeste } = await import('./tests/access-de-teste.js');
  const access = await subirAccessDeTeste();
  console.error = () => {};
  const { app } = await import('./src/server.js');
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const base = 'http://127.0.0.1:' + servidor.address().port;
  const h = { 'content-type': 'application/json', 'cf-access-jwt-assertion': access.jwt() };
  const login = await fetch(base + '/api/admin/sessao', { method: 'POST', headers: h, body: JSON.stringify({ usuario: 'op', senha: 'senha-do-teste' }) }).then((r) => r.json());
  const lista = await fetch(base + '/api/admin/contratantes', { headers: { ...h, 'x-admin-token': login.token } });
  await new Promise((r) => setTimeout(r, 100));
  const depois = await fetch(base + '/api/admin/contratantes', { headers: { ...h, 'x-admin-token': login.token } });
  servidor.close();
  console.log(JSON.stringify({ lista: lista.status, corpo: await lista.json().catch(() => null), depois: depois.status }));
  process.exit(0);
`, { BANCO_FALSO_ARQUIVO: banco, importar: './tests/banco-falso/loader.mjs' });
ok(realRejeita.status === 0 && realRejeita.resultado, `C2-L5: o server.js real sobrevive a um handler que rejeita (saiu ${realRejeita.status}; ${realRejeita.stderr.split('\n').find((l) => /unhandled|morrer|encerrar/i.test(l)) ?? ''})`);
igual([realRejeita.resultado?.lista, realRejeita.resultado?.corpo?.erro], [500, 'Erro interno. Tente novamente em instantes.'], 'C2-L5: a rejeição vira o 500 genérico do tratador de erro');
igual(realRejeita.resultado?.depois, 200, 'e o pedido seguinte é atendido — o processo continua de pé');

/* ---- 2. a classe: handler que lança, dos três jeitos ---- */
const classe = await filho(`
  process.on('unhandledRejection', () => { console.log(JSON.stringify({ morreu: 'unhandledRejection' })); process.exit(1); });
  process.on('uncaughtException', () => { console.log(JSON.stringify({ morreu: 'uncaughtException' })); process.exit(1); });
  const express = (await import('express')).default;
  const { comRejeicaoTratada, roteador } = await import('./src/utils/rotaSegura.js');
  const app = comRejeicaoTratada(express());
  const r = roteador();
  r.get('/async', async () => { throw new TypeError('lançou depois do await'); });
  r.get('/sync', () => { throw new TypeError('lançou síncrono'); });
  r.get('/depois-de-responder', async (_q, res) => { res.json({ ok: 1 }); throw new Error('lançou depois de responder'); });
  r.get('/ok', async (_q, res) => { res.json({ ok: true }); });
  r.route('/pela-rota').get(async () => { throw new TypeError('lançou num handler de route()'); });
  app.use('/x', r);
  app.get('/no-app', async () => { throw new Error('no app'); });
  const vistos = [];
  app.use((erro, _q, res, proximo) => { vistos.push(erro.message); if (res.headersSent) return proximo(erro); res.status(500).json({ erro: 'interno' }); });
  const s = app.listen(0); await new Promise((ok) => s.once('listening', ok));
  const base = 'http://127.0.0.1:' + s.address().port;
  const st = {};
  for (const c of ['/x/async', '/x/sync', '/x/depois-de-responder', '/x/ok', '/x/pela-rota', '/no-app']) st[c] = (await fetch(base + c)).status;
  await new Promise((ok) => setTimeout(ok, 50));
  s.close();
  console.log(JSON.stringify({ st, vistos, get: app.get('env') !== undefined }));
  process.exit(0);
`);
ok(classe.status === 0 && classe.resultado && !classe.resultado.morreu, `a classe: nenhum dos handlers derruba o processo (${JSON.stringify(classe.resultado)})`);
igual(classe.resultado?.st, { '/x/async': 500, '/x/sync': 500, '/x/depois-de-responder': 200, '/x/ok': 200, '/x/pela-rota': 500, '/no-app': 500 }, 'o que lança vira 500 do tratador — inclusive o registrado por route() (C2-L4); o que já respondeu segue respondido; o que não lança é intocado (controle)');
igual(classe.resultado?.vistos, ['lançou depois do await', 'lançou síncrono', 'lançou depois de responder', 'lançou num handler de route()', 'no app'], 'e TODA exceção chega ao tratador de erro — nenhuma some');
ok(classe.resultado?.get === true, 'controle: `app.get(nome)` de uma configuração continua lendo a configuração');

/* ---- 3. a cobertura: nada em src/ monta roteador ou app sem a proteção ---- */
let construcoes = 0;
for (const arquivo of arquivosJs(join(RAIZ, 'src'))) {
  const nome = relative(RAIZ, arquivo);
  if (nome === 'src/utils/rotaSegura.js') continue;
  /* Só a parte de PRODUÇÃO do módulo: o autoteste do fim (depois de
     `if (process.argv[1]…`) monta app de mentira para se exercitar. */
  const linhas = readFileSync(arquivo, 'utf8').split(/\nif \(process\.argv\[1\]/)[0].split('\n');
  linhas.forEach((linha, i) => {
    if (/^\s*(\*|\/\/)/.test(linha)) return;
    for (const m of linha.matchAll(/\b(?:express\.)?Router\(\)|\bexpress\(\)/g)) {
      construcoes += 1;
      ok(/comRejeicaoTratada\(\s*(?:express\.)?(?:Router|express)\(\)/.test(linha), `${nome}:${i + 1} monta \`${m[0]}\` sem comRejeicaoTratada — handler async ali derruba o processo (C1-01)`);
    }
  });
}
const rotas = arquivosJs(join(RAIZ, 'src/routes')).map((a) => readFileSync(a, 'utf8'));
ok(rotas.every((f) => /\broteador\(\)/.test(f)), 'todo arquivo de rotas usa `roteador()`');
ok(construcoes >= 1 && /comRejeicaoTratada\(express\(\)\)/.test(readFileSync(join(RAIZ, 'src/server.js'), 'utf8')), `controle: a varredura achou o \`express()\` do server.js, e ele está protegido (${construcoes})`);

console.log(`rota-que-lanca-nao-derruba-o-processo: ${checagens} checagens OK`);
