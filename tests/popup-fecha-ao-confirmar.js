#!/usr/bin/env node
/**
 * tests/popup-fecha-ao-confirmar.js
 *
 * RELATADO em 19/09/2026: a pop-up da Asaas ficava aberta pra sempre
 * depois do pagamento, escondendo o "Pagamento Aprovado"/"Assinatura
 * Ativa" e a contagem de volta pra loja (`ativarRetorno`, na janela
 * principal) atrás de uma janela que não fazia mais nada.
 *
 * Já existe um `callback` (successUrl/cancelUrl/expiredUrl,
 * `asaasCheckoutController.montarCallbackPadrao`) que redireciona a
 * pop-up pra `pagamento-popup-fechar.html`, que se fecha sozinha — mas
 * o próprio comentário da função avisa: a Asaas "pode (ou não)
 * redirecionar", e quem manda de verdade é sempre o webhook + polling
 * no NOSSO backend. Depender só do redirect da Asaas é depender de
 * comportamento dela, não do nosso.
 *
 * O que trava: os dois fluxos de pop-up (Cartão avulso e Assinatura
 * por cartão) fecham a pop-up a partir do NOSSO `aoConfirmar` — o
 * callback que só dispara quando o polling confirma `CHECKOUT_PAID` —,
 * nunca só do redirect da Asaas. Sabotagem (remover a linha de
 * qualquer um dos dois arquivos) tem de reprovar.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let checagens = 0;
const ok = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

for (const arquivo of [
  'public/js/modules/cartaoHandler.js',
  'public/js/modules/assinaturaCheckoutHandler.js'
]) {
  const fonte = readFileSync(join(RAIZ, arquivo), 'utf8');

  const inicio = fonte.indexOf('aoConfirmar: () => {');
  ok(inicio !== -1, `${arquivo}: controle positivo — achou o callback aoConfirmar`);

  const fim = fonte.indexOf('aoFalhar:', inicio);
  ok(fim !== -1 && fim > inicio, `${arquivo}: controle positivo — achou o callback aoFalhar depois dele`);

  const corpo = fonte.slice(inicio, fim);

  ok(
    /if\s*\(\s*popup\s*&&\s*!popup\.closed\s*\)\s*popup\.close\(\)/.test(corpo),
    `${arquivo}: aoConfirmar precisa fechar a pop-up (com guarda — ela pode já estar fechada pelo pagador)`
  );
}

console.log(`popup-fecha-ao-confirmar: ${checagens} checagens OK`);
