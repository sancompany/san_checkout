#!/usr/bin/env node
/**
 * tests/sem-consulta-repetida.js
 *
 * UMA invariante, e ela é de latência, não de correção:
 *
 *   **nenhum controlador busca o contratante de novo depois de
 *   `resolverPedido`/`resolverPlano` já terem devolvido ele.**
 *
 * Os dois resolvedores vão ao banco buscar o contratante para validar o
 * método habilitado, e devolvem o registro inteiro em
 * `{ contratante, pedido }`. Um `await buscarContratante(...)` depois
 * disso é uma segunda ida ao mesmo banco, pela mesma linha, no caminho
 * do dinheiro.
 *
 * POR QUE ISTO MERECE TESTE
 * Porque o desperdício é invisível: o código funciona perfeitamente, a
 * resposta é idêntica, e nenhum teste de comportamento acusa. O que
 * acusa é o relógio — e em 12/09/2026, com o backend em Oregon e o
 * Supabase em São Paulo, **cada ida ao banco custava 213 ms medidos**.
 * O caminho do Pix fazia quatro; passou a fazer três.
 *
 * O erro entra do jeito mais natural do mundo: alguém precisa do
 * `wallet_id` mais abaixo na função, não lembra que o contratante já
 * está em escopo, e escreve a linha que busca. Era exatamente assim que
 * estava.
 *
 * A checagem é no texto-fonte, como a do `valor-vem-do-servidor.js`, e
 * pela mesma razão: provar a contagem de idas ao banco de verdade
 * exigiria Supabase; provar que a chamada extra não voltou não exige
 * nada.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

const CONTROLADORES = [
  'src/controllers/checkoutController.js',
  'src/controllers/asaasCheckoutController.js'
];

let checagens = 0;

for (const caminho of CONTROLADORES) {
  const fonte = readFileSync(join(RAIZ, caminho), 'utf8');

  /* Nenhuma busca solta. O resolvedor é a única porta. */
  const soltas = [...fonte.matchAll(/await\s+buscarContratante\s*\(/g)];
  assert.equal(
    soltas.length, 0,
    `${caminho}: ${soltas.length} chamada(s) a buscarContratante fora do resolvedor. ` +
    'O contratante já vem de resolverPedido/resolverPlano — cada busca extra é uma ida ' +
    'ao banco a mais no caminho do dinheiro (213 ms medidos em 12/09/2026). ' +
    'Desestruture `const { contratante, pedido } = await resolverPedido(...)`.'
  );
  checagens += 1;

  /* A contraprova, e ela é o que impede o teste de virar teatro: se
     alguém "resolver" o aviso acima apagando a busca E o uso do
     contratante, o split para de ser montado e o contratante para de
     receber — falha silenciosa e cara. Então onde há split, tem que
     haver contratante desestruturado do resolvedor. */
  const usaSplit = /wallet_id/.test(fonte);
  if (usaSplit) {
    /* `cotarParaCobrar` (24/09/2026, C-02) é o portão da cotação de
       Pix/Boleto e é ELE quem chama `deps.resolverPedido` uma vez —
       o contratante desestruturado dele vem do mesmo resolvedor. */
    const vindoDoResolvedor = [...fonte.matchAll(
      /const\s*\{[^}]*\bcontratante\b[^}]*\}\s*=\s*await\s+(?:deps\.)?(?:resolver(?:Pedido|Plano)|cotarParaCobrar)\s*\(/g
    )];
    assert.ok(
      vindoDoResolvedor.length > 0,
      `${caminho}: usa wallet_id para montar split, mas não pega o contratante de ` +
      'nenhum resolvedor. Ou o split está sendo montado com dado que não existe, ' +
      'ou o contratante voltou a ser buscado de um jeito que esta checagem não vê.'
    );
    checagens += 1;

    /* `deps.resolverPedido`/`deps.resolverPlano` conta igual —
       checkoutController.js passou pro padrão de fábrica com deps
       injetáveis em 22/09/2026 (fechando AUD-001), e o contratante
       continua vindo do MESMO resolvedor, só que via injeção. */

    /* Toda função que MONTA split precisa ter o contratante vindo do
       resolvedor — não basta uma no arquivo inteiro.

       Conta a ATRIBUIÇÃO (`const split(s) = contratante?.wallet_id`),
       não a string `wallet_id`: ela aparece três vezes por bloco (a
       condição, o objeto e, às vezes, um comentário), e contar
       ocorrência de texto fazia esta checagem reprovar código correto.
       Erro meu, pego pelo próprio teste na primeira execução. */
    const montamSplit = [...fonte.matchAll(
      /const\s+splits?\s*=\s*contratante\?\.wallet_id/g
    )];
    assert.ok(
      vindoDoResolvedor.length >= montamSplit.length,
      `${caminho}: ${montamSplit.length} lugar(es) montam split, mas só ${vindoDoResolvedor.length} ` +
      'pegam o contratante do resolvedor. Algum split está usando um contratante que ' +
      'veio de outro lugar — confira antes de seguir.'
    );
    checagens += 1;
  }
}

console.log(`sem-consulta-repetida: ${checagens} checagens OK`);
