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
  const EXCECOES = ['criarContratante', 'rotacionarChaveContratante'];
  for (const nome of EXCECOES) ok(fonte.includes(`export async function ${nome}(`), `a exceção "${nome}" precisa existir no arquivo — lista de exceções não pode envelhecer calada`);

  // Fatia o arquivo por função exportada.
  const partes = fonte.split(/(?=^export async function |^export function |^async function |^function )/m);
  let selectsComChave = 0;
  let funcoesConferidas = 0;
  for (const parte of partes) {
    const nome = parte.match(/^(?:export )?(?:async )?function (\w+)/)?.[1];
    if (!nome) continue;
    const selects = [...parte.matchAll(/\.select\(\s*'([^']*)'/g)].map((m) => m[1]);
    const traz = selects.some((s) => /\bapi_key\b/.test(s));
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

console.log(`segredo-nao-sai-do-admin: ${checagens} checagens OK`);
