#!/usr/bin/env node
/**
 * tests/renovacao-exige-token-nao-so-documento.js
 *
 * `POST /api/checkout/assinatura/:contratanteId/:planoId` é pública. Até
 * 16/09/2026, `renovar: true` bastava sozinho pra achar e depois
 * cancelar (`encerrarAssinaturaSubstituida`, webhookController.js) a
 * assinatura de outra pessoa — só era preciso saber o `documento` dela,
 * que não é segredo. Isso violava o `API.md` §5.5 ("cancelamento: só o
 * projeto aciona").
 *
 * A correção real é o HMAC de `utils/tokenRenovacao.js` (autoteste
 * próprio, cobre o algoritmo). Este arquivo cobre só a FIAÇÃO — que
 * `asaasCheckoutController.criarCheckoutAssinatura` de fato usa
 * `tokenRenovacaoValido` como guarda antes de chamar
 * `buscarAssinaturaAtiva`, em vez de confiar em `renovar` sozinho.
 *
 * Checagem no texto-fonte (mesmo argumento do guarda de `arquivado_em`
 * em `pedidoService.js` e do de `statusAceitos` em
 * `assinatura-pausada-continua-cancelavel.js`): o controller usa import
 * direto, não injeção de dependência, e forjar uma requisição HTTP de
 * verdade pra exercitar isto pediria banco e Asaas de sandbox — grosseira
 * e presente vale mais que elegante e inexistente.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const fonte = readFileSync(join(RAIZ, 'src/controllers/asaasCheckoutController.js'), 'utf8');

let checagens = 0;
const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

conferir(
  fonte.includes("import { tokenRenovacaoValido } from '../utils/tokenRenovacao.js';"),
  'criarCheckoutAssinatura precisa importar tokenRenovacaoValido'
);

const corpoDaFuncao = /export async function criarCheckoutAssinatura[\s\S]*?\n\}/.exec(fonte);
conferir(corpoDaFuncao !== null, 'não achei o corpo de criarCheckoutAssinatura');

const trechoRenovacao = /const assinaturaSubstituida = ([\s\S]*?);/.exec(corpoDaFuncao[0]);
conferir(trechoRenovacao !== null, 'não achei a atribuição de assinaturaSubstituida');

conferir(
  trechoRenovacao[1].includes('tokenRenovacaoValido('),
  'assinaturaSubstituida precisa depender de tokenRenovacaoValido — sem isso, ' +
  '"renovar" sozinho (um booleano vindo do body, não autenticado) bastava pra achar ' +
  'e depois cancelar a assinatura de outra pessoa'
);

conferir(
  !/const assinaturaSubstituida = renovar\s*\?/.test(corpoDaFuncao[0]),
  'PORTA ABERTA: assinaturaSubstituida não pode depender só de "renovar" ser truthy — ' +
  'isso é exatamente o furo do cancelamento cross-pagador'
);

// A chamada precisa levar o `api_key` do CONTRATANTE (o segredo que só
// ele e o San Checkout têm) — sem ele, qualquer token "válido" passaria.
conferir(
  /tokenRenovacaoValido\(\s*renovar\s*,\s*contratante\??\.\s*api_key/.test(corpoDaFuncao[0]),
  'tokenRenovacaoValido precisa ser chamado com renovar e contratante.api_key, nessa ordem — ' +
  'sem o api_key do contratante como segredo, o token não prova nada'
);

console.log(`renovacao-exige-token-nao-so-documento: ${checagens} checagens OK`);
