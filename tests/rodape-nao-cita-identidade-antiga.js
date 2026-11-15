#!/usr/bin/env node
/**
 * tests/rodape-nao-cita-identidade-antiga.js
 *
 * O NOME DO ARQUIVO É HISTÓRICO e foi mantido de propósito, porque o
 * runner e o CLAUDE.md apontam para ele. O que ele trava mudou duas vezes:
 *
 *   19/09/2026 — o rodapé do checkout e da tela de status ainda citavam
 *   "SAN & CO. — CNPJ 68.949.029/0001-58", a identidade ANTERIOR, depois
 *   de os documentos legais terem passado ao CPF. Documento de identidade
 *   incorreto no ar é a mesma classe de "documento falso é pior que
 *   ausente", só que em texto de identidade, não em número de contagem.
 *
 *   11/11/2026 — o dono formalizou a operação no MEI e decidiu que a
 *   identificação passa a ser a do empresário individual. A "identidade
 *   antiga" agora é a do CPF.
 *
 * O que trava, hoje:
 *
 *   1. Termos e Política dizem a MESMA identificação (nome empresarial e
 *      CNPJ), e o CNPJ tem dígitos verificadores válidos.
 *   2. As três telas que afirmam a identidade no rodapé (checkout, status,
 *      troca de plano) citam esse nome empresarial e esse CNPJ — lidos
 *      dos Termos, não chumbados aqui, para o teste não envelhecer
 *      sozinho se a identificação mudar de novo.
 *   3. NENHUM HTML público vivo publica um CPF. O CPF do operador não é
 *      mais a inscrição exigida (Decreto 7.962/2013, art. 2º, I: CPF
 *      OU CNPJ), e CPF em página pública é identificador de alto valor.
 *      O campo de CPF/CNPJ do formulário usa só máscara de exemplo.
 *
 * `docs/legal-arquivado/` fica fora de propósito: são as cópias exatas do
 * que esteve publicado, inclusive as que citam CPF.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentoValido } from '../src/utils/validadores.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLICO = join(RAIZ, 'public');
let checagens = 0;
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };

const ler = (arquivo) => readFileSync(join(PUBLICO, arquivo), 'utf8');
const decodificar = (s) => s.replace(/&amp;/g, '&');

/* --- A fonte: o que os Termos afirmam como identificação do Operador --- */
const TERMOS = ler('termos.html');
const POLITICA = ler('privacidade.html');

const casamentoNome = TERMOS.match(/operada por <strong>([^<]+)<\/strong>/);
ok(casamentoNome, 'controle positivo: termos.html afirma o nome empresarial do Operador no item 1.1');
const NOME_EMPRESARIAL = decodificar(casamentoNome[1]);

const casamentoCnpj = TERMOS.match(/inscrito no CNPJ sob nº <strong>(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})<\/strong>/);
ok(casamentoCnpj, 'controle positivo: termos.html afirma o CNPJ do Operador no item 1.1');
const CNPJ = casamentoCnpj[1];

ok(
  documentoValido(CNPJ.replace(/\D/g, '')),
  `o CNPJ que os Termos afirmam (${CNPJ}) tem dígitos verificadores inválidos`
);
ok(NOME_EMPRESARIAL.includes(CNPJ.slice(0, 10)), 'o nome empresarial do MEI começa pelos oito dígitos-base do CNPJ');

/* --- 1. A Política diz a mesma coisa que os Termos --- */
for (const [rotulo, trecho] of [['nome empresarial', NOME_EMPRESARIAL], ['CNPJ', CNPJ]]) {
  ok(
    decodificar(POLITICA).includes(trecho),
    `privacidade.html não afirma o mesmo ${rotulo} dos Termos (${trecho})`
  );
}

/* --- 2. As telas que afirmam a identidade batem com a fonte --- */
for (const arquivo of ['index.html', 'status.html', 'troca.html']) {
  const conteudo = decodificar(ler(arquivo));
  ok(
    conteudo.includes(NOME_EMPRESARIAL),
    `${arquivo}: o rodapé não cita o nome empresarial do Operador (${NOME_EMPRESARIAL})`
  );
  ok(
    conteudo.includes(`CNPJ ${CNPJ}`),
    `${arquivo}: o rodapé não cita o CNPJ do Operador (${CNPJ})`
  );
}

/* --- 3. Nenhum HTML público vivo publica um CPF --- */
const arquivosHtml = readdirSync(PUBLICO).filter((n) => n.endsWith('.html'));
ok(arquivosHtml.length >= 5, 'controle positivo: achou os HTML de public/');

const FORMATO_CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
for (const arquivo of arquivosHtml) {
  const achados = (ler(arquivo).match(FORMATO_CPF) ?? []).filter((c) => c !== '000.000.000-00');
  ok(
    achados.length === 0,
    `${arquivo}: publica um CPF (${achados.join(', ')}) — o Operador se identifica pelo CNPJ`
  );
}

/* Controle positivo da própria regra 3: o detector acha um CPF de verdade,
   e a máscara de exemplo do formulário é a ÚNICA coisa que ele deixa passar. */
ok('x 123.456.789-09 y'.match(FORMATO_CPF)?.length === 1, 'controle positivo: o detector de CPF acha um CPF formatado');
ok(ler('index.html').includes('placeholder="000.000.000-00"'), 'controle positivo: a máscara de exemplo do formulário existe e é a exceção deliberada');

console.log(`rodape-nao-cita-identidade-antiga: ${checagens} checagens OK`);
