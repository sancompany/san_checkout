#!/usr/bin/env node
/**
 * tests/total-nao-confiavel-nao-vira-tela-compravel.js
 *
 * UMA invariante, nas três telas que mostram preço:
 *
 *   **total que o servidor não vai cobrar nunca aparece como total
 *   pagável.** Ausência de valor vira estado indisponível (`R$ —`, sem
 *   botão), nunca "R$ 0,00" e nunca um número que só existe porque a
 *   taxa foi somada em cima do nada.
 *
 * POR QUE ISTO MERECE TESTE
 * Porque a classe já apareceu duas vezes, e a segunda passou pelo
 * conserto da primeira sem encostar nele
 * (`docs/erros/2026-09-11-total-ausente-virou-zero-na-tela.md` e
 * `docs/erros/2026-09-13-o-guarda-de-total-olhava-o-numero-errado.md`).
 * As duas entram do mesmo jeito: alguém lê um número que existe, não
 * pergunta se ele é cobrável, e a tela fica comprável.
 *
 * O buraco de 13/09 foi exatamente esse: `calcularTaxa(0, 'pix', …)`
 * devolve `valorCobrado: 1.49` — taxa sobre base zero —, o front lia
 * `valorCobrado` como "o total", e um pedido de R$ 0,00 renderizava
 * botão de pagar. O backend recusava só no clique.
 *
 * A checagem é no texto-fonte, como a do `sem-consulta-repetida.js` e
 * pela mesma razão: exercitar a rota exigiria Supabase e a API de um
 * contratante; provar que o guarda não sumiu não exige nada.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { valorValido } from '../src/utils/validadores.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (caminho) => readFileSync(join(RAIZ, caminho), 'utf8');

let checagens = 0;
const conferir = (condicao, mensagem) => {
  assert.ok(condicao, mensagem);
  checagens += 1;
};

// 1. A régua. É ela que os três guardas espelham, e é o backend que a
//    define — se ela mudar, os guardas do front mudam junto.
conferir(valorValido(0) === false, 'valorValido deve recusar zero');
conferir(valorValido(-1) === false, 'valorValido deve recusar negativo');
conferir(valorValido(0.01) === true, 'valorValido deve aceitar o mínimo cobrável');
conferir(valorValido(100001) === false, 'valorValido deve recusar acima do teto');

// 2. Leitura do pedido: a rota que a tela consulta não pode publicar
//    taxa (e portanto total) para uma base que a cobrança recusaria.
/* Desde 24/09/2026 (C-02) a régua mora em `cotacaoService.montarTotaisPedido`:
   ela devolve `null` quando `valorValido(valorBase)` falha, e o
   controlador publica `taxa: totais?.pix ?? null` — o mesmo `null` que
   derruba a tela para o estado Indisponível. */
const pedidoController = ler('src/controllers/pedidoController.js');
const cotacaoService = ler('src/services/cotacaoService.js');
conferir(
  /import\s*\{[^}]*\bmontarTotaisPedido\b[^}]*\}\s*from\s*'\.\.\/services\/cotacaoService\.js'/.test(pedidoController),
  'pedidoController deve montar os totais pela cotação — é lá que mora a régua do caminho que cobra'
);
conferir(
  /if \(!valorValido\(valorBase\)\) return null;/.test(cotacaoService),
  'montarTotaisPedido devolve null quando valorValido(valorBase) falha — senão anuncia total que a cobrança vai recusar'
);
conferir(
  /const taxa = totais\?\.pix \?\? null;/.test(pedidoController),
  'pedidoController publica taxa: null quando não há totais — é isso que a tela lê como Indisponível'
);

// 3. Tela do pedido: o guarda que derruba o carregamento quando o total
//    não é utilizável. Sem ele, "R$ 0,00" parece compra grátis.
const pedidoHandler = ler('public/js/modules/pedidoHandler.js');
conferir(
  /!Number\.isFinite\(total\)\s*\|\|\s*total\s*<=\s*0/.test(pedidoHandler),
  'pedidoHandler deve recusar total não finito ou menor ou igual a zero'
);

// 4. Tela da assinatura: mesmo guarda, sobre o valor do plano. Aqui o
//    risco é maior porque `formatarMoeda` faz `Number(valor ?? 0)` — sem
//    guarda, plano sem valor vira "R$ 0,00" com botão de assinar ligado.
const assinaturaHandler = ler('public/js/modules/assinaturaHandler.js');
conferir(
  /Number\(plano\?\.valor\)/.test(assinaturaHandler),
  'assinaturaHandler deve ler o valor do plano para conferi-lo antes de resolver'
);
conferir(
  /!Number\.isFinite\(valor\)\s*\|\|\s*valor\s*<=\s*0/.test(assinaturaHandler),
  'assinaturaHandler deve recusar plano sem valor utilizável, em vez de deixar virar R$ 0,00'
);

console.log(`total-nao-confiavel-nao-vira-tela-compravel: ${checagens} checagens OK`);
