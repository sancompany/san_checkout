#!/usr/bin/env node
/**
 * tests/retorno-nao-vira-open-redirect.js
 *
 * O `returnUrl` é honrado desde 15/09/2026. Ele é, por natureza, o
 * vetor clássico de OPEN REDIRECT: o valor vem da barra de endereço, de
 * quem montou o link, que não é necessariamente o contratante.
 *
 * `src/utils/retornoSeguro.js` já tem a suíte de bypasses — aquela
 * prova que a REGRA está certa. Esta aqui prova outra coisa, e é a que
 * sobrevive ao tempo: que a regra continua NO CAMINHO.
 *
 * Porque a forma de esta defesa morrer não é alguém descobrir um bypass
 * de parser. É alguém, daqui a três meses, "simplificar":
 *
 *   - lendo `returnUrl` direto no front e navegando com ele, porque
 *     "já está na URL mesmo, por que pedir pro servidor?";
 *   - devolvendo a lista de origens pro navegador pra ele decidir;
 *   - ecoando `requisicao.query.returnUrl` na resposta sem passar pelo
 *     validador.
 *
 * As três compilam, passam em qualquer teste de comportamento feliz, e
 * reabrem o buraco inteiro. Então a checagem é grosseira e no
 * texto-fonte, de propósito — grosseira e presente vale mais que
 * elegante e inexistente, mesmo argumento do guarda de
 * `arquivado_em` em `pedidoService.js`.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { retornoSeguro, origensDeRetorno } from '../src/utils/retornoSeguro.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (caminho) => readFileSync(join(RAIZ, caminho), 'utf8');

let checagens = 0;
const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

/* ====================================================================
   1. O FRONT NÃO DECIDE — ele repassa e obedece
   ==================================================================== */

const retornoFront = ler('public/js/modules/retorno.js');

/* O módulo que navega pode LER o parâmetro (para repassar ao backend),
   mas o valor que vai para `location` tem de ser o que o backend
   aprovou. Se um dia `location.replace`/`assign`/`href` aparecer na
   mesma linha de uma leitura de parâmetro, a decisão voltou para o
   lado que o atacante controla. */
const linhasQueNavegam = retornoFront
  .split('\n')
  .filter((linha) => /location\s*\.\s*(replace|assign|href)/.test(linha) && !linha.trimStart().startsWith('*'));

conferir(linhasQueNavegam.length > 0, 'retorno.js precisa navegar em algum lugar — se não navega, o retorno não existe');

for (const linha of linhasQueNavegam) {
  conferir(
    /destinoAprovado/.test(linha),
    `retorno.js navega para algo que não é \`destinoAprovado\` (o valor que o backend aprovou): ${linha.trim()}`
  );
  conferir(
    !/searchParams|URLSearchParams|location\.search|returnUrl/.test(linha),
    `retorno.js navega usando valor lido da barra de endereço — é exatamente o open redirect: ${linha.trim()}`
  );
}

/* `destinoAprovado` só pode ser escrito por `definirRetorno`, que
   recebe a resposta do backend. Qualquer outra atribuição é uma
   segunda porta de entrada. */
const atribuicoes = retornoFront.match(/^\s*destinoAprovado\s*=/gm) ?? [];
conferir(
  atribuicoes.length === 1,
  `\`destinoAprovado\` deveria ser atribuído em UM lugar só (dentro de definirRetorno); achei ${atribuicoes.length}`
);

/* O front não pode conter a allowlist: se ela estiver aqui, ou está
   sendo usada para decidir no lado errado, ou foi publicada sem
   necessidade. */
conferir(
  !/retorno_dominios|retornoDominios|origensDeRetorno/.test(retornoFront),
  'a lista de origens do contratante não pode aparecer no front — ela nunca sai do servidor'
);

/* ====================================================================
   2. O BACKEND DECIDE — e nunca ecoa o valor cru
   ==================================================================== */

for (const [arquivo, rotulo] of [
  ['src/controllers/pedidoController.js', 'pedido'],
  ['src/controllers/planoController.js', 'plano']
]) {
  const fonte = ler(arquivo);

  conferir(
    /import\s*\{[^}]*retornoSeguro[^}]*\}\s*from\s*'[^']*retornoSeguro\.js'/.test(fonte),
    `${rotulo}Controller precisa importar retornoSeguro — sem ele não há validação nenhuma`
  );

  conferir(
    /retornoSeguro\(\s*requisicao\.query\?\.returnUrl/.test(fonte),
    `${rotulo}Controller precisa passar requisicao.query.returnUrl PELO validador`
  );

  /* O eco cru é o furo silencioso: `retornoUrl: requisicao.query.returnUrl`
     compila, funciona no caminho feliz, e entrega o open redirect
     inteiro. Não pode existir nenhuma leitura de `query...returnUrl`
     que não esteja dentro da chamada do validador. */
  const leiturasCruas = fonte.match(/query\s*\??\.\s*returnUrl/g) ?? [];
  const dentroDoValidador = fonte.match(/retornoSeguro\(\s*requisicao\.query\?\.returnUrl/g) ?? [];
  conferir(
    leiturasCruas.length === dentroDoValidador.length,
    `${rotulo}Controller lê query.returnUrl fora do validador (${leiturasCruas.length} leituras, ${dentroDoValidador.length} validadas) — eco cru é open redirect`
  );

  /* A allowlist não pode viajar na resposta. */
  conferir(
    !/retorno_dominios/.test(fonte),
    `${rotulo}Controller não pode devolver retorno_dominios — publicaria os domínios cadastrados do contratante`
  );
}

/* ====================================================================
   3. A REGRA, de ponta a ponta, com o contratante real do formato
   ==================================================================== */

const CONTRATANTE = {
  api_base_url: 'https://api.loja.com.br/v1',
  retorno_dominios: ['https://www.loja.com.br']
};

conferir(origensDeRetorno(CONTRATANTE).size === 2, 'api_base_url + 1 domínio = 2 origens');

// Uma última varredura de payloads — sobreposta à suíte do validador de
// propósito: se alguém trocar a implementação por outra, este arquivo
// ainda cobra o comportamento.
const DEVEM_PASSAR = [
  'https://www.loja.com.br/obrigado',
  'https://api.loja.com.br/qualquer-coisa'
];

const DEVEM_FALHAR = [
  'https://golpe.tld',
  'https://www.loja.com.br.golpe.tld',
  'https://golpe.tld/?x=https://www.loja.com.br',
  'https://golpe.tld#https://www.loja.com.br',
  'https://www.loja.com.br@golpe.tld',
  'https:/\\golpe.tld',
  'http://www.loja.com.br',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  '//golpe.tld',
  '/interno',
  ''
];

for (const alvo of DEVEM_PASSAR) {
  conferir(retornoSeguro(alvo, CONTRATANTE) !== null, `deveria aceitar: ${alvo}`);
}
for (const alvo of DEVEM_FALHAR) {
  conferir(retornoSeguro(alvo, CONTRATANTE) === null, `OPEN REDIRECT — aceitou: ${alvo}`);
}

/* O status NUNCA vai na URL de volta: query string é escrita por quem
   quiser, e um integrador desavisado daria por paga uma compra que
   ninguém pagou. */
const comPedido = retornoSeguro('https://www.loja.com.br/ok', CONTRATANTE, { pedidoId: 'ped_x9' });
conferir(!/status|pago|paid|confirmed/i.test(comPedido), 'a URL de volta não pode carregar status de pagamento');
conferir(comPedido.includes('pedido=ped_x9'), 'a URL de volta leva o id do pedido');

console.log(`retorno-nao-vira-open-redirect: ${checagens} checagens OK`);
