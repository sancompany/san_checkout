#!/usr/bin/env node
/**
 * tests/banco-sem-privilegio-publico.js
 *
 * INFO-13 da remediação da Estação 6: os papéis `anon` e `authenticated`
 * do Supabase (os da chave PÚBLICA) tinham tudo em todas as tabelas —
 * inclusive TRUNCATE, que o RLS nem olha — e EXECUTE nas funções. Este
 * backend só usa `service_role`. A migration 0020 tirou os privilégios;
 * esta suíte impede que eles voltem por uma migration nova:
 *
 *   - a 0020 revoga dos dois (e do `PUBLIC`, nas funções) e nunca do
 *     `service_role`;
 *   - toda função criada DEPOIS da 0020 revoga o EXECUTE do `PUBLIC` na
 *     própria migration — o PostgreSQL o concede por padrão global, que
 *     não se revoga por esquema;
 *   - nenhuma migration devolve privilégio ao `anon`/`authenticated`.
 *
 * Checagem de TEXTO sobre `supabase/migrations/`. O que está de fato no
 * banco de produção foi medido na aplicação da 0020 (relatório da
 * Estação 6) e é o que o ensaio de restauração compara.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASTA = join(RAIZ, 'supabase/migrations');
let checagens = 0;
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };

const semComentario = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const migrations = readdirSync(PASTA).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()
  .map((nome) => ({ nome, numero: Number(nome.slice(0, 4)), sql: semComentario(readFileSync(join(PASTA, nome), 'utf8')).toLowerCase() }));
ok(migrations.length >= 20, `controle: achou as migrations (${migrations.length})`);

const a0020 = migrations.find((m) => m.numero === 20);
ok(a0020, 'a migration 0020 existe');
for (const trecho of [
  'revoke all on all tables in schema public from anon, authenticated',
  'revoke all on all sequences in schema public from anon, authenticated',
  'revoke all on all functions in schema public from public, anon, authenticated',
  'alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated',
  'alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated'
]) ok(a0020.sql.includes(trecho), `a 0020 faz: ${trecho}`);

for (const m of migrations) {
  ok(!/\brevoke\b[^;]*\bservice_role\b/.test(m.sql), `${m.nome} não revoga nada do service_role — é o papel do backend`);
  ok(!(m.numero >= 20 && /\bgrant\b[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/.test(m.sql)), `${m.nome} não devolve privilégio à chave pública`);
}

/* Função criada depois da 0020 revoga o EXECUTE do PUBLIC na mesma migration. */
let funcoesNovas = 0;
for (const m of migrations.filter((x) => x.numero > 20)) {
  for (const [, nome] of m.sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_][a-z0-9_]*)/g)) {
    funcoesNovas += 1;
    ok(new RegExp(`revoke\\s+(?:all|execute)\\s+on\\s+function\\s+(?:public\\.)?${nome}\\b[^;]*from[^;]*\\bpublic\\b`).test(m.sql),
      `${m.nome}: a função ${nome} revoga o EXECUTE do PUBLIC na própria migration (o padrão global o concede)`);
  }
}

/* Controle positivo da regex de função: as quatro de antes da 0020 são achadas. */
const antes = migrations.filter((m) => m.numero < 20)
  .flatMap((m) => [...m.sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_][a-z0-9_]*)/g)].map((x) => x[1]));
for (const nome of ['registrar_erro', 'registrar_rejeicoes_webhook', 'resumo_rejeicoes_webhook', 'e_teste_e_de_mao_unica']) {
  ok(antes.includes(nome), `controle: a varredura acha a função ${nome}, criada antes da 0020 (e coberta por ela)`);
}

console.log(`banco-sem-privilegio-publico: ${checagens} checagens OK (${funcoesNovas} função(ões) depois da 0020)`);
