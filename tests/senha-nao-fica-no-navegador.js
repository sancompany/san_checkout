#!/usr/bin/env node
/**
 * tests/senha-nao-fica-no-navegador.js
 *
 * UMA invariante, e ela é de segurança:
 *
 *   **a senha do admin entra em UM ponto do painel — a troca por token
 *   em `POST /api/admin/sessao` — e não sobrevive a ele.**
 *
 * Não vai em cabeçalho de requisição, não é gravada no `sessionStorage`,
 * não fica no campo da tela depois do login. O que circula depois é o
 * token, e só ele.
 *
 * POR QUE ISTO MERECE TESTE
 * Porque o estado errado é confortável e funciona igual. Até 12/09/2026
 * o painel guardava `{usuario, senha}` no `sessionStorage` e mandava
 * `X-Admin-User`/`X-Admin-Pass` em toda chamada: a tela se comportava
 * exatamente como se comporta hoje, e o custo era invisível de dois
 * jeitos — qualquer XSS ou extensão que lesse storage levava a senha
 * embora, e cada requisição pagava ~830 ms de scrypt no servidor.
 *
 * Voltar atrás é fácil e silencioso: basta alguém precisar de uma rota
 * nova e copiar o `headersAuth` de um exemplo antigo. A checagem é no
 * texto-fonte, como a do `sem-consulta-repetida.js`, e pela mesma razão:
 * provar isso de verdade exigiria navegador; provar que o padrão errado
 * não voltou não exige nada.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (caminho) => readFileSync(join(RAIZ, caminho), 'utf8');

let checagens = 0;
const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

/* ------------------------------------------------------------------
   1. O painel (public/js/admin.js)
------------------------------------------------------------------ */
const painel = ler('public/js/admin.js');

conferir(!/X-Admin-Pass/.test(painel), 'o painel NÃO manda a senha em cabeçalho (X-Admin-Pass)');
conferir(!/X-Admin-User/.test(painel), 'o painel NÃO manda o usuário em cabeçalho (X-Admin-User)');
conferir(/X-Admin-Token/.test(painel), 'o painel manda o token (X-Admin-Token)');

/* A senha só pode aparecer no corpo da chamada que a troca por token.
   Qualquer outra menção a `senha` junto de `sessionStorage` é o padrão
   antigo voltando. */
const guardaSenha = /sessionStorage\.setItem\([^)]*senha/.test(painel)
  || /JSON\.stringify\(\{\s*usuario\s*,\s*senha\s*\}\)\s*\)\s*;?\s*\}\s*catch/.test(painel);
conferir(!guardaSenha, 'a senha NÃO é gravada no sessionStorage');

conferir(
  /\/api\/admin\/sessao/.test(painel),
  'existe a chamada que troca senha por token (POST /api/admin/sessao)'
);
conferir(
  /\$\('admin-pass'\)\.value\s*=\s*''/.test(painel),
  'o campo da senha é limpo depois do login'
);

/* ------------------------------------------------------------------
   2. A guarda do servidor (adminController.js)
------------------------------------------------------------------ */
const controlador = ler('src/controllers/adminController.js');

const guarda = controlador.slice(
  controlador.indexOf('export function verificarAdminKey'),
  controlador.indexOf('export async function abrirSessao')
);
conferir(guarda.length > 100, 'achei o corpo de verificarAdminKey');
conferir(
  !/senhaConfere/.test(guarda),
  'a guarda de TODA rota do admin não confere senha — quem faz isso é só abrirSessao'
);
conferir(/verificarToken/.test(guarda), 'a guarda confere o token');

/* `senhaConfere` é caro (~830 ms). Ele pode aparecer em UM lugar só do
   controlador inteiro: dentro de `abrirSessao`. */
const vezes = (controlador.match(/await senhaConfere\(/g) ?? []).length;
conferir(vezes === 1, `senhaConfere é chamado uma vez só no controlador (achei ${vezes})`);

const sessao = controlador.slice(controlador.indexOf('export async function abrirSessao'));
conferir(/await senhaConfere\(/.test(sessao), 'e a única chamada está dentro de abrirSessao');

/* ------------------------------------------------------------------
   3. As rotas (adminRoutes.js)
------------------------------------------------------------------ */
const rotas = ler('src/routes/adminRoutes.js');
const posSessao = rotas.indexOf("router.post('/sessao'");
const posGuarda = rotas.indexOf('router.use(verificarAdminKey)');

conferir(posSessao !== -1, 'a rota /sessao existe');
conferir(posGuarda !== -1, 'a guarda é montada com router.use');
conferir(
  posSessao < posGuarda,
  '/sessao vem ANTES da guarda — é a única rota que não pode exigir token'
);

/* ------------------------------------------------------------------
   4. O limite de força bruta (server.js)
------------------------------------------------------------------ */
const servidor = ler('src/server.js');
const posLimiteSessao = servidor.indexOf("app.use('/api/admin/sessao'");
const posLimiteAdmin = servidor.indexOf("app.use('/api/admin'");

conferir(posLimiteSessao !== -1, '/api/admin/sessao tem limitador próprio');
conferir(
  posLimiteSessao < posLimiteAdmin,
  'o limitador da sessão é montado ANTES do de /api/admin, senão o mais largo casa primeiro'
);

console.log(`senha-nao-fica-no-navegador: ${checagens} checagens OK`);
