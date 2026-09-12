#!/usr/bin/env node
/**
 * tests/valor-vem-do-servidor.js
 *
 * UMA invariante, e é a que sustenta o checkout inteiro:
 *
 *   **nenhum controlador aceita valor, preço, desconto, frete ou taxa
 *   vindos do corpo da requisição.**
 *
 * O valor é sempre recalculado a partir do pedido resolvido na fonte
 * (`resolverPedido`/`resolverPlano` — o modelo pull), na hora de cobrar.
 * Se um dia alguém acrescentar `valor` ao `const { ... } =
 * requisicao.body`, o comprador passa a poder escolher quanto paga
 * mexendo no navegador, e nada mais no sistema percebe: a cobrança sai,
 * a Asaas confirma, o webhook chega, o pedido vira pago. Não existe
 * teste de integração que pegue isso — o fluxo funciona perfeitamente,
 * só que pelo preço errado.
 *
 * A checagem é no TEXTO-FONTE, de propósito. Provar a propriedade de
 * verdade exigiria Supabase, Asaas e um contratante real; provar que a
 * porta de entrada continua estreita não exige nada, roda em
 * milissegundos, e pega exatamente o jeito como esse erro entraria —
 * alguém acrescentando um nome à lista da desestruturação.
 *
 * É o mesmo espírito da checagem de `.is('arquivado_em', null)` no
 * `pedidoService.js`: grosseira e presente vale mais que elegante e
 * inexistente.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Todo controlador que pode fazer dinheiro se mover. */
const CONTROLADORES = [
  'src/controllers/checkoutController.js',
  'src/controllers/asaasCheckoutController.js',
  'src/controllers/refundController.js',
  'src/controllers/assinaturaController.js',
  'src/controllers/cobrancaConsultaController.js'
];

/**
 * Nomes que, vindos de fora, mudariam quanto se cobra. `parcelas` NÃO
 * está aqui de propósito: ela vem do comprador mesmo — é escolha dele —
 * e o servidor a valida contra o teto de 12 e recalcula a taxa em cima
 * do valor que ele próprio resolveu.
 */
const PROIBIDOS = [
  'valor', 'valores', 'preco', 'preço', 'total', 'subtotal',
  'desconto', 'frete', 'taxa', 'taxas', 'valorCobrado', 'valorCheio',
  'valorComDesconto', 'valorUnitario', 'valorBase', 'amount', 'price'
];

let checagens = 0;

for (const caminho of CONTROLADORES) {
  const fonte = readFileSync(join(RAIZ, caminho), 'utf8');

  /* Pega toda desestruturação de `requisicao.body`, de uma linha ou de
     várias. O `[^}]*` não atravessa `}`, então cada captura é o miolo
     de UM destes blocos e nada além dele. */
  const blocos = [...fonte.matchAll(/const\s*\{([^}]*)\}\s*=\s*requisicao\.body/g)];

  assert.ok(
    blocos.length > 0,
    `${caminho}: nenhuma leitura de requisicao.body encontrada — ou o arquivo mudou de forma, ou a regex parou de casar. Teste que não casa nada passa calado, e passar calado aqui é o pior desfecho possível.`
  );

  for (const [, miolo] of blocos) {
    const campos = miolo
      .split(',')
      .map((c) => c.split(':')[0].split('=')[0].trim())
      .filter(Boolean);

    for (const campo of campos) {
      assert.ok(
        !PROIBIDOS.includes(campo),
        `${caminho}: o corpo da requisição não pode trazer "${campo}". ` +
        'O valor da cobrança vem SEMPRE do pedido resolvido na fonte ' +
        '(resolverPedido/resolverPlano), nunca do que o navegador manda. ' +
        'Se este campo passou a ser necessário, ele precisa de uma decisão ' +
        'explícita registrada no CONSTRAINTS.md — não de um nome a mais nesta lista.'
      );
      checagens += 1;
    }
  }
}

/* A contraprova: o caminho do dinheiro tem que estar de fato
   recalculando. Um controlador que aceitasse só nome e e-mail e ainda
   assim cobrasse um valor guardado no front passaria na checagem acima
   e estaria igualmente errado. */
for (const caminho of ['src/controllers/checkoutController.js', 'src/controllers/asaasCheckoutController.js']) {
  const fonte = readFileSync(join(RAIZ, caminho), 'utf8');
  assert.ok(
    /resolverPedido\(|resolverPlano\(/.test(fonte),
    `${caminho}: precisa resolver o pedido/plano na fonte antes de cobrar.`
  );
  assert.ok(
    /valorValido\(/.test(fonte),
    `${caminho}: precisa passar o valor resolvido por valorValido() antes de cobrar.`
  );
  checagens += 2;
}

console.log(`valor-vem-do-servidor: ${checagens} checagens OK`);
