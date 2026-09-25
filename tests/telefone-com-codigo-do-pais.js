#!/usr/bin/env node
/**
 * tests/telefone-com-codigo-do-pais.js
 *
 * O autopreenchimento do navegador entrega `+55 16 98765-4321`, e o
 * checkout lia o `55` como DDD (relatado pelo dono no primeiro teste
 * real em produção, 25/09/2026). Duas causas, uma em cada ponta:
 *
 *   - a máscara cortava os 11 PRIMEIROS dígitos — `55169876543`;
 *   - o campo tinha `maxlength="15"`, e `+55 16 98765-4321` tem 17: o
 *     navegador truncava antes de a máscara ver qualquer coisa.
 *
 * A regra é uma só, escrita duas vezes (front e servidor, porque o
 * servidor nunca confia no navegador): só dígitos; 12 ou 13 começando
 * por 55 → o 55 é o país e sai. Esta suíte roda o MESMO corpus pelas
 * duas implementações e exige que concordem — é assim que elas não
 * divergem com o tempo.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const servidor = await import('../src/utils/validadores.js');
const mascaras = await import('../public/js/utils/masks.js');
const validadoresTela = await import('../public/js/utils/validators.js');

let checagens = 0;
const igual = (a, b, m) => { assert.equal(a, b, m); checagens += 1; };
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };

/* 1. As formas equivalentes do enunciado — celular realista (o
      `99999-9999` do exemplo tem a parte local toda de 9, que a Asaas
      recusa; ele está no bloco 3, como inválido). */
const EQUIVALENTES = [
  '16987654321',
  '(16) 98765-4321',
  '+55 16 98765-4321',
  '55 16 98765-4321',
  '+55 (16) 98765-4321',
  '+55-16-98765-4321',
  '  16 98765 4321  ',
  '+5516987654321'
];
for (const forma of EQUIVALENTES) {
  igual(servidor.normalizarTelefone(forma), '16987654321', `servidor: "${forma}" → 16987654321`);
  igual(mascaras.normalizarTelefone(forma), '16987654321', `tela: "${forma}" → 16987654321`);
  igual(mascaras.mascararTelefone(forma), '(16) 98765-4321', `máscara: "${forma}" → (16) 98765-4321 — o 55 nunca vira DDD`);
  ok(servidor.telefoneValido(forma), `servidor aceita "${forma}"`);
  ok(validadoresTela.validarTelefone(forma), `tela aceita "${forma}"`);
}

/* 2. Fixo, e o DDD 55 de verdade (Rio Grande do Sul) — o comprimento
      decide, e o 55 que é DDD fica. */
const CASOS = [
  ['+55 16 3333-4444', '1633334444'],
  ['(55) 3333-4444', '5533334444'],
  ['55987654321', '55987654321'],
  ['+55 55 98765-4321', '55987654321']
];
for (const [forma, esperado] of CASOS) {
  igual(servidor.normalizarTelefone(forma), esperado, `servidor: "${forma}" → ${esperado}`);
  igual(mascaras.normalizarTelefone(forma), esperado, `tela: "${forma}" → ${esperado}`);
}

/* 3. Inválidos continuam inválidos no servidor (a tela só confere
      comprimento; quem recusa o que a Asaas recusa é o servidor). */
for (const forma of ['+55 16 99999-9999', '16 99999-9999', '+1 415 555 0100', '+55 16 9876', '55 16 98765-43210', '', 'abc']) {
  ok(!servidor.telefoneValido(forma), `servidor recusa "${forma}"`);
}

/* 4. As duas implementações concordam num corpus maior */
for (const forma of [...EQUIVALENTES, ...CASOS.map((c) => c[0]), '+55 11 91234-5678', '11 1234-5678', '5511912345678', '551112345678']) {
  igual(mascaras.normalizarTelefone(forma), servidor.normalizarTelefone(forma), `tela e servidor divergem em "${forma}"`);
}

/* 5. O campo não corta o autopreenchimento, e a tela manda a forma normalizada */
const html = readFileSync(join(RAIZ, 'public/index.html'), 'utf8');
const campo = html.match(/<input[^>]*id="customer-phone"[^>]*>/)?.[0] ?? '';
ok(campo.length > 0, 'o campo de telefone existe');
const maxlength = Number(campo.match(/maxlength="(\d+)"/)?.[1] ?? Infinity);
ok(maxlength >= '+55 (16) 98765-4321'.length, `maxlength ${maxlength} cortaria "+55 (16) 98765-4321" antes da máscara — foi a 2ª metade do bug`);
const app = readFileSync(join(RAIZ, 'public/js/app.js'), 'utf8');
ok(/telefone: normalizarTelefone\(document\.getElementById\('customer-phone'\)\.value\)/.test(app), 'a tela envia o telefone normalizado, não os dígitos crus');
ok(/addEventListener\('change', aplicar\)/.test(app), 'a máscara também roda no `change` (autopreenchimento que não dispara `input`)');

/* 6. Toda rota que recebe telefone normaliza DEPOIS de validar — o que
      vai para a Asaas e para o banco é uma forma só. */
const rotas = {
  'src/controllers/checkoutController.js': 2,        // Pix, Boleto
  'src/controllers/asaasCheckoutController.js': 3    // Cartão, Assinatura, Pix Automático
};
for (const [arquivo, esperado] of Object.entries(rotas)) {
  const fonte = readFileSync(join(RAIZ, arquivo), 'utf8');
  const validacoes = (fonte.match(/telefoneValido\(telefone\)\) return resposta\.status\(400\)/g) ?? []).length;
  const normalizacoes = (fonte.match(/if \(telefone\) telefone = normalizarTelefone\(telefone\);/g) ?? []).length;
  igual(validacoes, esperado, `${arquivo}: ${esperado} rotas validam telefone`);
  igual(normalizacoes, validacoes, `${arquivo}: toda rota que valida telefone também normaliza`);
}

console.log(`telefone-com-codigo-do-pais: ${checagens} checagens OK`);
