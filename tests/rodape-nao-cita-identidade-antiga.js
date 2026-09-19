#!/usr/bin/env node
/**
 * tests/rodape-nao-cita-identidade-antiga.js
 *
 * MEDIDO em 19/09/2026: o rodapé do checkout (`index.html`) e da tela
 * de status (`status.html`) ainda citavam "SAN & CO. — CNPJ
 * 68.949.029/0001-58" — a identidade ANTIGA do operador. A
 * reidentificação para pessoa física (CPF 552.085.198-01) aconteceu em
 * 17/09/2026 e tocou `termos.html`/`privacidade.html` (a "assinatura"
 * no fim dos dois documentos legais), mas ninguém pensou em conferir o
 * rodapé das telas — ele não é parte do texto legal, mas afirma a
 * mesma identidade, e ficou pra trás.
 *
 * O dano não é teórico: cobrança acontece no CPF do operador, e uma
 * tela dizendo CNPJ é documento incorreto no ar, na mesma classe do
 * "documento falso é pior que ausente" que `o-que-os-documentos-
 * afirmam.js` já trava para números de contagem. Aqui é texto de
 * identidade, não número — mesma regra, checagem diferente.
 *
 * O que trava: NENHUM HTML público vivo pode citar o CNPJ antigo (fora
 * `docs/legal-arquivado/`, que é histórico deliberado), e as duas telas
 * que afirmam a identidade do operador batem com o que os documentos
 * legais (a fonte) afirmam.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLICO = join(RAIZ, 'public');
let checagens = 0;
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };

const CNPJ_ANTIGO = '68.949.029/0001-58';

/* A fonte: o CPF que os documentos legais (termos, privacidade) afirmam
   como identidade do operador — lido deles, não chumbado aqui, senão
   este teste também poderia envelhecer sozinho se o CPF mudar de novo. */
const TERMOS = readFileSync(join(PUBLICO, 'termos.html'), 'utf8');
const casamentoCpf = TERMOS.match(/CPF\s+(\d{3}\.\d{3}\.\d{3}-\d{2})/);
ok(casamentoCpf, 'controle positivo: termos.html afirma um CPF no formato esperado');
const CPF_OPERADOR = casamentoCpf[1];

/* --- 1. Nenhum HTML público vivo cita o CNPJ antigo --- */
const arquivosHtml = readdirSync(PUBLICO).filter((n) => n.endsWith('.html'));
ok(arquivosHtml.length >= 5, 'controle positivo: achou os HTML de public/');

for (const arquivo of arquivosHtml) {
  const conteudo = readFileSync(join(PUBLICO, arquivo), 'utf8');
  ok(
    !conteudo.includes(CNPJ_ANTIGO),
    `${arquivo}: ainda cita o CNPJ antigo do operador (${CNPJ_ANTIGO}) — a identidade em vigor é o CPF`
  );
}

/* --- 2. As duas telas que afirmam a identidade batem com a fonte --- */
for (const arquivo of ['index.html', 'status.html']) {
  const conteudo = readFileSync(join(PUBLICO, arquivo), 'utf8');
  ok(
    conteudo.includes(CPF_OPERADOR),
    `${arquivo}: não afirma o CPF do operador (${CPF_OPERADOR}) que termos.html afirma como fonte`
  );
}

console.log(`rodape-nao-cita-identidade-antiga: ${checagens} checagens OK`);
