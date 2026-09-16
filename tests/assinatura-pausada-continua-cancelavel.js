#!/usr/bin/env node
/**
 * tests/assinatura-pausada-continua-cancelavel.js
 *
 * A regra: **todo estado que o `/pausar-assinatura` consegue alcançar, o
 * `/cancelar-assinatura` também tem que alcançar.** Se dá para pausar,
 * tem que dar para cancelar — senão pausar vira porta de mão única.
 *
 * ── O que aconteceu em 15/09/2026 ───────────────────────────────────
 *
 * `cancelarAssinatura` chamava `buscarAssinaturaAtiva` sem passar
 * `statusAceitos`, caindo no default `['ativa']`. `pausarAssinatura`
 * passava `['ativa', 'pausada']`. Consequência, medida ao vivo contra a
 * produção (sandbox), com UMA linha em `assinaturas` de status
 * `pausada`, o mesmo contratante, o mesmo plano e o mesmo documento nas
 * duas chamadas:
 *
 *   POST /pausar-assinatura   → 200 {"status":"pausada","jaEstava":true}
 *   POST /cancelar-assinatura → 404 "Nenhuma assinatura ativa encontrada"
 *
 * A linha existia e era alcançável; só o filtro de status a escondia.
 * Quem pausasse não conseguia mais cancelar por lugar nenhum — a
 * assinatura ficava `INACTIVE` na Asaas para sempre, e o único caminho
 * restante era mexer no painel na mão.
 *
 * ── Por que a checagem é no texto-fonte ─────────────────────────────
 *
 * `assinaturaController` usa import direto (não injeção de dependência),
 * então exercitar `cancelarAssinatura` de verdade exigiria refatorar o
 * módulo inteiro só para testá-lo. Grosseira e presente vale mais que
 * elegante e inexistente — mesmo argumento do guarda de `arquivado_em`
 * em `pedidoService.js`.
 *
 * `cancelada` NÃO precisa estar na lista, e é de propósito: a busca
 * ordena por `criado_em` desc e devolve uma só, então numa renovação
 * (duas linhas para o mesmo plano+documento) aceitar `cancelada` poderia
 * fazer a antiga mascarar uma ativa mais nova.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const fonte = readFileSync(join(RAIZ, 'src/controllers/assinaturaController.js'), 'utf8');

let checagens = 0;
const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

/** Os status dentro de um literal de array, na ordem em que aparecem. */
function statusDoLiteral(trecho) {
  return [...trecho.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
}

/* ---------- o que o CANCELAR alcança ---------- */

const chamadaDoCancelar = /buscarAssinaturaAtiva\(\s*[^)]*?\[([^\]]*)\]\s*\)/s.exec(fonte);
conferir(
  chamadaDoCancelar !== null,
  'cancelarAssinatura precisa passar `statusAceitos` EXPLÍCITO para buscarAssinaturaAtiva — ' +
  'omitir cai no default `[\'ativa\']`, e foi exatamente assim que a assinatura pausada virou incancelável'
);

const aceitosNoCancelar = statusDoLiteral(chamadaDoCancelar[1]);

/* ---------- o que o PAUSAR alcança ---------- */

const fabricaDoPausar = /pausarAssinatura\s*=\s*criarHandlerDeStatus\(\{(.*?)\}\)/s.exec(fonte);
conferir(fabricaDoPausar !== null, 'não achei a declaração de pausarAssinatura — o teste está olhando o lugar errado');

const listaDoPausar = /statusAceitos:\s*\[([^\]]*)\]/.exec(fabricaDoPausar[1]);
conferir(listaDoPausar !== null, 'não achei statusAceitos de pausarAssinatura');

const aceitosNoPausar = statusDoLiteral(listaDoPausar[1]);

/* ---------- A REGRA ---------- */

const inalcancaveis = aceitosNoPausar.filter((status) => !aceitosNoCancelar.includes(status));

assert.deepEqual(
  inalcancaveis, [],
  'PORTA DE MÃO ÚNICA: o /pausar-assinatura alcança estado que o /cancelar-assinatura não alcança ' +
  `(${inalcancaveis.join(', ')}).\n` +
  '        Quem pausar não vai conseguir cancelar, e a assinatura fica INACTIVE na Asaas sem saída pela API.\n' +
  `        cancelar aceita: [${aceitosNoCancelar.join(', ')}]\n` +
  `        pausar   aceita: [${aceitosNoPausar.join(', ')}]`
);
checagens += 1;

conferir(aceitosNoCancelar.includes('pausada'), 'cancelar precisa alcançar `pausada` — é o caso que quebrou ao vivo');
conferir(aceitosNoCancelar.includes('ativa'), 'cancelar precisa continuar alcançando `ativa`');

/* ---------- a mensagem de 404 não pode mentir sobre o que procurou ---------- */

const msg404 = /erro:\s*'Nenhuma assinatura ([^']*?) encontrada/.exec(fonte);
conferir(msg404 !== null, 'cancelarAssinatura precisa de uma mensagem de 404 própria');

for (const status of aceitosNoCancelar) {
  conferir(
    msg404[1].includes(status),
    `a mensagem de 404 do cancelar diz "${msg404[1]}" mas a busca também aceita "${status}" — ` +
    'mensagem que não descreve o que foi procurado manda o integrador investigar a coisa errada'
  );
}

/* ---------- cancelar precisa notificar o contratante ----------
   Até 16/09/2026, `cancelarAssinatura` só respondia síncrono — nenhum
   webhook `evento: 'cancelada'` saía, quebrando a seta que o `API.md`
   §7.4 desenha para este endpoint (achado testando uma assinatura real
   de ponta a ponta). */
const corpoDoCancelar = /export async function cancelarAssinatura[\s\S]*?\n\}/.exec(fonte);
conferir(corpoDoCancelar !== null, 'não achei o corpo de cancelarAssinatura');
conferir(
  /notificarAssinaturaCancelada\(/.test(corpoDoCancelar[0]),
  'cancelarAssinatura precisa chamar notificarAssinaturaCancelada — sem isso, quem chama /cancelar-assinatura ' +
  'só sabe que funcionou pela resposta síncrona, e o `API.md` §7.4 promete um webhook que nunca sai'
);

console.log(`assinatura-pausada-continua-cancelavel: ${checagens} checagens OK`);
