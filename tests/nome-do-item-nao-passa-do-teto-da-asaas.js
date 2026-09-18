#!/usr/bin/env node
/**
 * tests/nome-do-item-nao-passa-do-teto-da-asaas.js
 *
 * MEDIDO ao vivo em 18/09/2026, verificando se os métodos de pagamento
 * continuavam funcionais depois dos dois ciclos de `revisar` do dia:
 * `POST /v3/checkouts` (Cartão avulso e Assinatura por cartão) recusa
 * `items[0].name` acima de 30 caracteres com 400 "O campo name só pode
 * conter no máximo 30 caracteres." — e `pedido.descricao`/`plano.nome`
 * (dado do CONTRATANTE, nunca do pagador) iam pra lá sem teto nenhum.
 * `ped_completo`, um pedido de teste já existente, tem 41 caracteres na
 * descrição e quebrava Cartão avulso por inteiro.
 *
 * Esta suíte trava duas coisas:
 *   1. A REGRA — `nomeItemAsaas()` corta em 30 e nunca perde o texto:
 *      o original inteiro vai em `description`, que a Asaas aceita sem
 *      teto (medido: 100+ caracteres passaram).
 *   2. O ALCANCE — os dois lugares que montam `items[].name` para o
 *      Checkout da Asaas passam pela função, em vez de usar o campo
 *      cru — sabotagem (reverter para o campo cru) tem de reprovar.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nomeItemAsaas } from '../src/controllers/asaasCheckoutController.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let checagens = 0;
const ok = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };
const igual = (a, b, mensagem) => { assert.deepEqual(a, b, mensagem); checagens += 1; };

/* --- 1. A REGRA --- */
igual(nomeItemAsaas('Camiseta preta'), 'Camiseta preta', 'texto curto passa intacto');
igual(nomeItemAsaas('A'.repeat(30)), 'A'.repeat(30), 'exatamente 30 passa intacto — é o teto medido, não 29');
ok(nomeItemAsaas('A'.repeat(31)).length === 30, 'acima do teto, o resultado tem exatamente 30 caracteres');
igual(
  nomeItemAsaas('Pedido completo — desconto, cupom e frete'), // 41 chars, o caso real medido
  'Pedido completo — desconto, c…',
  'o caso real (ped_completo, 41 caracteres) corta pro exato texto esperado'
);
ok(
  nomeItemAsaas('Pedido completo — desconto, cupom e frete').endsWith('…'),
  'corte leva reticências — sinaliza pro operador que o nome não é o completo'
);
igual(nomeItemAsaas(null), '', 'nulo não quebra — vira vazio, não "null"');
igual(nomeItemAsaas(undefined), '', 'ausente idem');
ok(nomeItemAsaas(undefined).length <= 30, 'e o vazio também respeita o teto, trivialmente');

/* --- 2. O ALCANCE --- */
const fonte = readFileSync(join(RAIZ, 'src', 'controllers', 'asaasCheckoutController.js'), 'utf8');

for (const [funcao, campo] of [
  ['criarCheckoutCartao', 'pedido.descricao'],
  ['criarCheckoutAssinatura', 'plano.nome']
]) {
  const inicio = fonte.indexOf(`export async function ${funcao}`);
  const fim = fonte.indexOf('export async function', inicio + 10);
  const corpo = fonte.slice(inicio, fim === -1 ? undefined : fim);

  ok(inicio !== -1 && corpo.length > 300, `controle positivo: achou o corpo de ${funcao}`);
  ok(
    corpo.includes(`name: nomeItemAsaas(${campo}`),
    `${funcao}: o \`name\` do item vai pela função que respeita o teto de 30 caracteres da Asaas`
  );
  ok(
    !new RegExp(`name:\\s*${campo.replace('.', '\\.')}\\s*\\?\\?`).test(corpo),
    `${funcao}: \`name\` não usa mais ${campo} cru (sem passar pelo teto)`
  );
  ok(
    corpo.includes(`description: ${campo} ?? undefined`),
    `${funcao}: o texto INTEIRO vai em \`description\`, que a Asaas aceita sem teto — cortar não é perder informação`
  );
}

console.log(`nome-do-item-nao-passa-do-teto-da-asaas: ${checagens} checagens OK`);
