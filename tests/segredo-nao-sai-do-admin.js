#!/usr/bin/env node
/**
 * tests/segredo-nao-sai-do-admin.js
 *
 * H-08 da auditoria de 24/09/2026 — **segredo não sai em listagem**:
 *
 *   a `api_key` de um contratante aparece inteira UMA vez, na resposta
 *   da criação e na da rotação (quem acabou de gerá-la precisa dela). Em
 *   toda outra resposta do painel — listagem, edição, detalhe — vai só
 *   `api_key_final` (os 4 últimos), nunca `api_key`.
 *
 * POR QUE ISTO MERECE TESTE
 * Até 24/09 a listagem devolvia todas as chaves de todos os
 * contratantes a cada abertura do painel: um XSS no admin, ou um token
 * de sessão vazado, levava tudo de uma vez. A correção é uma função de
 * uma linha — e é por isso que precisa de teste: alguém acrescenta um
 * `select` novo com `api_key` e esquece o `map(mascararChave)`.
 *
 * Duas camadas: (1) a máscara em si; (2) varredura do texto-fonte do
 * controlador — todo `select(` que traz `api_key` precisa, na MESMA
 * função, passar por `mascararChave`, salvo as duas funções que são a
 * exceção declarada (criar, rotacionar). Nome de função é conferido
 * contra o arquivo, para a lista de exceções não envelhecer calada.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? 'teste';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const { mascararChave } = await import('../src/controllers/adminController.js');

let checagens = 0;
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };
const igual = (a, b, m) => { assert.deepEqual(a, b, m); checagens += 1; };

/* 1. A máscara */
{
  const m = mascararChave({ id: 'x', nome: 'Loja', api_key: 'chave-de-mentira-cdef', webhook_url: 'https://l' });
  ok(!('api_key' in m), 'api_key não sobrevive à máscara');
  igual(m.api_key_final, 'cdef', 'só os 4 últimos');
  igual(m.nome, 'Loja', 'o resto passa intacto');
  igual(mascararChave({ id: 'y', api_key: null }).api_key_final, null, 'sem chave: null, não "null"');
  igual(mascararChave({ id: 'z', api_key: 'abc' }).api_key_final, null, 'chave curta demais para mostrar 4: nada');
  igual(mascararChave(null), null);
}

/* 2. O controlador: todo select com api_key passa pela máscara, salvo as exceções */
{
  const fonte = readFileSync(join(RAIZ, 'src/controllers/adminController.js'), 'utf8');
  /* `criarSubconta` devolve a chave da subconta UMA vez, na criação — a
     mesma regra das duas de contratante. */
  const EXCECOES = ['criarContratante', 'rotacionarChaveContratante', 'criarSubconta'];
  for (const nome of EXCECOES) ok(fonte.includes(`export async function ${nome}(`), `a exceção "${nome}" precisa existir no arquivo — lista de exceções não pode envelhecer calada`);

  // Fatia o arquivo por função exportada.
  const partes = fonte.split(/(?=^export async function |^export function |^async function |^function )/m);
  let selectsComChave = 0;
  let funcoesConferidas = 0;
  for (const parte of partes) {
    const nome = parte.match(/^(?:export )?(?:async )?function (\w+)/)?.[1];
    if (!nome) continue;
    const selects = [...parte.matchAll(/\.select\(\s*'([^']*)'/g)].map((m) => m[1]);
    /* `*` também traz a chave (SEC-016, 25/09/2026): a varredura olhava só
       o nome escrito, e `atualizarLinkAtivacaoSubconta` — `select('*')` —
       devolvia a `api_key` da subconta a cada link colado sem ela ver. */
    const traz = selects.some((s) => /\bapi_key\b/.test(s) || s.trim() === '*');
    if (!traz) continue;
    selectsComChave += 1;
    if (EXCECOES.includes(nome)) continue;
    funcoesConferidas += 1;
    ok(/mascararChave/.test(parte), `${nome}: seleciona api_key e responde sem mascararChave — a chave inteira sairia do painel (H-08)`);
    ok(!/resposta\.(?:status\(\d+\)\.)?json\(\s*data\s*\)/.test(parte), `${nome}: devolve \`data\` cru depois de selecionar api_key`);
  }
  ok(selectsComChave >= 3, `controle positivo: a varredura precisa ACHAR selects com api_key (achou ${selectsComChave})`);
  ok(funcoesConferidas >= 1, `controle positivo: pelo menos uma função fora das exceções foi conferida (${funcoesConferidas})`);
}

/* 3. O painel: o que a tela mostra é o final, e o que ela guarda em
      memória depois de criar/rotacionar não vai para storage */
{
  const admin = readFileSync(join(RAIZ, 'public/js/admin.js'), 'utf8');
  ok(/api_key_final/.test(admin), 'a tela lê api_key_final');
  ok(!/localStorage\.setItem\([^)]*api_key/.test(admin) && !/sessionStorage\.setItem\([^)]*api_key/.test(admin), 'a chave nunca vai para storage do navegador');
}

/* 4. Subcontas: a chave de API da subconta também não sai em listagem */
{
  const fonte = readFileSync(join(RAIZ, 'src/controllers/adminController.js'), 'utf8');
  const listagem = fonte.slice(fonte.indexOf('export async function listarSubcontas'), fonte.indexOf('export async function', fonte.indexOf('export async function listarSubcontas') + 10));
  ok(listagem.length > 0, 'listarSubcontas existe');
  ok(/mascararChave/.test(listagem), 'listarSubcontas passa pela máscara (select(*) traz api_key)');
}

/* 5. A subconta, por comportamento (SEC-016 e SEC-032): banco falso com
      FALHA INJETADA no insert, Asaas roteirizada devolvendo uma chave de
      mentira. A chave não pode aparecer no que o processo escreveu no log;
      o link colado precisa ser https; e a resposta do link vem mascarada. */
{
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const CHAVE_DA_SUBCONTA = 'chave-da-subconta-de-mentira-0123456789abcdef';
  const pasta = mkdtempSync(join(tmpdir(), 'subconta-'));
  const arquivo = join(pasta, 'banco.json');
  writeFileSync(arquivo, JSON.stringify({
    tabelas: { subcontas: [{ id: 'sub_existente', nome: 'Sub', api_key: CHAVE_DA_SUBCONTA, wallet_id: 'w1', link_ativacao: null, arquivado_em: null }] },
    falhas: { 'subcontas.insert': 1 }
  }));
  const codigo = `
    const CHAVE = ${JSON.stringify(CHAVE_DA_SUBCONTA)};
    globalThis.fetch = async (url, opcoes = {}) => {
      const u = new URL(String(url));
      if ((opcoes.method ?? 'GET') === 'POST' && u.pathname === '/v3/accounts') {
        return new Response(JSON.stringify({ id: 'acc_1', walletId: 'wal_1', apiKey: CHAVE }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 500 });
    };
    const admin = await import('./src/controllers/adminController.js');
    const res = () => ({ _s: 200, _j: null, status(c) { this._s = c; return this; }, json(o) { this._j = o; return this; } });
    const r1 = res();
    await admin.criarSubconta({ body: { nome: 'Loja Sub', email: 'sub@loja.exemplo', documento: '11144477735', endereco: 'Rua A', enderecoNumero: '1', bairro: 'Centro', cep: '14020260', faturamento: 1000, dataNascimento: '1990-01-01' }, get: () => undefined }, r1);
    const r2 = res();
    await admin.atualizarLinkAtivacaoSubconta({ params: { id: 'sub_existente' }, body: { linkAtivacao: 'javascript:alert(document.cookie)' } }, r2);
    const r3 = res();
    await admin.atualizarLinkAtivacaoSubconta({ params: { id: 'sub_existente' }, body: { linkAtivacao: 'https://www.asaas.com/ativar/abc' } }, r3);
    await new Promise((r) => setTimeout(r, 100));
    console.log(JSON.stringify({ criar: r1._s, js: [r2._s, r2._j], https: [r3._s, r3._j] }));
  `;
  const filho = spawn(process.execPath, ['--import', './tests/banco-falso/loader.mjs', '--input-type=module', '-e', codigo], {
    cwd: RAIZ,
    env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:0', SUPABASE_SERVICE_KEY: 'teste', ASAAS_API_KEY: 'chave-de-teste', ASAAS_AMBIENTE: 'sandbox', BANCO_FALSO_ARQUIVO: arquivo }
  });
  let stdout = ''; let stderr = '';
  filho.stdout.on('data', (c) => { stdout += c; });
  filho.stderr.on('data', (c) => { stderr += c; });
  const [status] = await once(filho, 'close');
  ok(status === 0, `o processo da subconta terminou (${stderr.slice(-300)})`);
  const r = JSON.parse(stdout.trim().split('\n').pop());
  ok(r.criar >= 500, `controle: o insert falhou de verdade depois da Asaas criar (${r.criar})`);
  ok(/Supabase falhou DEPOIS da Asaas/.test(stderr), 'controle: o log de recuperação foi escrito');
  ok(stderr.includes('acc_1'), 'e leva o id da conta, para recuperar à mão');
  ok(!stderr.includes(CHAVE_DA_SUBCONTA) && !stdout.includes(CHAVE_DA_SUBCONTA), 'SEC-016: a chave de API da subconta NÃO vai para o log');
  igual(r.js[0], 400, 'SEC-032: link de ativação `javascript:` é recusado');
  igual(r.https[0], 200, 'controle: link https é aceito');
  ok(r.https[1] && !('api_key' in r.https[1]) && r.https[1].api_key_final === 'cdef', 'SEC-016: a resposta do link vem com a chave mascarada (só os 4 últimos)');
}

console.log(`segredo-nao-sai-do-admin: ${checagens} checagens OK`);
