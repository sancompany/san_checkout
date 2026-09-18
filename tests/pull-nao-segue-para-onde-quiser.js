#!/usr/bin/env node
/**
 * tests/pull-nao-segue-para-onde-quiser.js
 *
 * O residual de SSRF que o ciclo de segurança da Estação 6 deixou
 * DECLARADO e não corrigido (`docs/pendencias.md`): a entrada estava
 * fechada — `api_base_url` exige https e host público (RN-14) — mas a
 * RESPOSTA do contratante não estava.
 *
 * Os dois caminhos que sobravam, e que esta suíte fecha:
 *
 *   1. `fetch` segue redirect sozinho. O contratante responde `302` para
 *      `http://169.254.169.254/…` e o checkout busca a credencial da
 *      nuvem. A checagem de CADASTRO não vê isso: o endereço cadastrado
 *      continua público e https — quem trocou o alvo foi a resposta.
 *      Pior: a requisição leva a `X-Checkout-Key` do contratante, que é
 *      a credencial de consulta e ESTORNO dele; um redirect para outra
 *      origem entregaria essa chave a quem respondeu o `Location`.
 *
 *   2. `resposta.json()` lê até o fim. A instância tem 512 MiB; um corpo
 *      de alguns giga derruba o processo — e com ele a confirmação de
 *      pagamento de TODOS os contratantes, o mesmo dano do `fetch` sem
 *      timeout de 15/09 (`CONSTRAINTS.md` §2.7.1).
 *
 * Os ataques aqui são exercitados por HTTP de verdade, contra um servidor
 * que responde como um contratante malicioso responderia — não conferindo
 * texto-fonte. O `aceitarAlvo` injetado existe só porque o validador de
 * verdade exige https com host público e um servidor de teste vive em
 * `http://127.0.0.1`; a última seção varre o `src/` e falha se algum
 * chamador de produção passar esse parâmetro.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  puxarDoContratante,
  RespostaRecusada,
  TETO_CORPO_BYTES,
  MAXIMO_DE_SALTOS
} from '../src/utils/puxarDoContratante.js';
import { arquivosJs } from './ajudantes.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let checagens = 0;
const ok = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };
const igual = (a, b, mensagem) => { assert.deepEqual(a, b, mensagem); checagens += 1; };

/* Para o teste, todo alvo http local é aceitável — a regra sob teste é a
   do REDIRECT, e ela precisa ser medida separada da regra de host. */
const aceitarAlvo = (alvo) => /^http:\/\/127\.0\.0\.1:/.test(String(alvo));

/** Guarda o que o "contratante" recebeu, para provar que a chave NÃO
 *  viajou para onde não devia. */
const recebidas = [];

const servidor = http.createServer((requisicao, resposta) => {
  recebidas.push({ url: requisicao.url, chave: requisicao.headers['x-checkout-key'] });
  const caminho = requisicao.url;

  if (caminho === '/ok') {
    resposta.writeHead(200, { 'content-type': 'application/json' });
    return resposta.end(JSON.stringify({ descricao: 'Pedido de teste', valorComDesconto: 40 }));
  }
  if (caminho === '/redirect-mesma-origem') {
    return resposta.writeHead(302, { location: '/ok' }).end();
  }
  if (caminho === '/redirect-absoluto-mesma-origem') {
    return resposta.writeHead(301, { location: `http://127.0.0.1:${porta}/ok` }).end();
  }
  if (caminho === '/redirect-metadata') {
    return resposta.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
  }
  if (caminho === '/redirect-loopback') {
    return resposta.writeHead(302, { location: 'http://127.0.0.1:1/segredo' }).end();
  }
  if (caminho === '/redirect-outro-publico') {
    return resposta.writeHead(302, { location: 'https://atacante.exemplo/coleta' }).end();
  }
  if (caminho === '/redirect-sem-destino') {
    return resposta.writeHead(302).end();
  }
  if (caminho === '/redirect-em-laco') {
    return resposta.writeHead(302, { location: '/redirect-em-laco' }).end();
  }
  if (caminho === '/corpo-gigante') {
    resposta.writeHead(200, { 'content-type': 'application/json' });
    // Sem `content-length`: o teto tem de valer pelo que CHEGA, não pelo
    // que o outro lado declara.
    const pedaco = 'x'.repeat(64 * 1024);
    let enviados = 0;
    const empurrar = () => {
      while (enviados < TETO_CORPO_BYTES * 4) {
        enviados += pedaco.length;
        if (!resposta.write(pedaco)) return resposta.once('drain', empurrar);
      }
      resposta.end();
    };
    return empurrar();
  }
  if (caminho === '/content-length-mentiroso') {
    resposta.writeHead(200, { 'content-type': 'application/json', 'content-length': String(TETO_CORPO_BYTES * 10) });
    return resposta.end('{"ok":true}');
  }
  if (caminho === '/nao-json') {
    resposta.writeHead(200, { 'content-type': 'text/html' });
    return resposta.end('<html>erro interno do parceiro</html>');
  }
  resposta.writeHead(404, { 'content-type': 'application/json' });
  return resposta.end('{"erro":"nao encontrado"}');
});

servidor.listen(0);
await new Promise((pronto) => servidor.once('listening', pronto));
const porta = servidor.address().port;
const base = `http://127.0.0.1:${porta}`;

function puxar(caminho, extras = {}) {
  const cancelador = new AbortController();
  const relogio = setTimeout(() => cancelador.abort(), 5000);
  return puxarDoContratante(base + caminho, {
    chave: 'chave-de-teste-nao-e-credencial-real',
    signal: cancelador.signal,
    aceitarAlvo,
    ...extras
  }).finally(() => clearTimeout(relogio));
}

async function recusa(caminho, motivoEsperado, rotulo, extras) {
  try {
    await puxar(caminho, extras);
    assert.fail(`${rotulo}: NÃO recusou`);
  } catch (erro) {
    ok(erro instanceof RespostaRecusada, `${rotulo}: recusa como RespostaRecusada (veio ${erro.name}: ${erro.message})`);
    igual(erro.motivo, motivoEsperado, `${rotulo}: o motivo é "${motivoEsperado}"`);
  }
}

try {
  /* ---- CONTROLE POSITIVO -------------------------------------------
     Sem isto a suíte inteira não significa nada: se o caminho honesto
     também estivesse recusando, todo "recusou" abaixo seria um falso
     acerto. Foi exatamente assim que a primeira rodada do `returnUrl`
     quase passou por prova em 15/09. */
  const bom = await puxar('/ok');
  igual(bom.status, 200, 'controle positivo: resposta honesta passa');
  igual(bom.corpo.valorComDesconto, 40, 'e o corpo chega inteiro e decodificado');
  igual(recebidas.at(-1).chave, 'chave-de-teste-nao-e-credencial-real', 'a chave vai no cabeçalho, como o contrato pede');

  /* ---- REDIRECT HONESTO CONTINUA FUNCIONANDO ---------------------- */
  recebidas.length = 0;
  const relativo = await puxar('/redirect-mesma-origem');
  igual(relativo.status, 200, 'redirect relativo na mesma origem é seguido');
  igual(recebidas.map((r) => r.url), ['/redirect-mesma-origem', '/ok'], 'e os dois saltos foram na mesma origem');

  const absoluto = await puxar('/redirect-absoluto-mesma-origem');
  igual(absoluto.status, 200, 'redirect absoluto na mesma origem é seguido');

  /* ---- O SSRF PELA RESPOSTA ---------------------------------------- */
  recebidas.length = 0;
  await recusa('/redirect-metadata', 'redirect para outra origem', 'metadata da nuvem');
  await recusa('/redirect-loopback', 'redirect para outra origem', 'loopback em outra porta');
  await recusa('/redirect-sem-destino', 'redirect sem destino', 'redirect sem Location');
  await recusa('/redirect-em-laco', 'redirect demais', 'laço de redirect');

  /* ---- O VAZAMENTO DA CHAVE ---------------------------------------- */
  recebidas.length = 0;
  await recusa('/redirect-outro-publico', 'redirect para outra origem', 'outra origem, pública e https');
  igual(
    recebidas.map((r) => r.url), ['/redirect-outro-publico'],
    'só a primeira requisição saiu — a chave do contratante NÃO foi para a origem do Location'
  );

  /* ---- O CORPO SEM TETO -------------------------------------------- */
  await recusa('/corpo-gigante', 'corpo grande demais', 'corpo de 4 MiB sem content-length');

  /* O `content-length` NUNCA é acreditado para deixar passar — só para
     recusar cedo. Um servidor que declara 10 MiB e manda 11 bytes é
     quebrado ou malicioso; recusá-lo é correto, e é a decisão que sobra
     depois de o corpo sem `content-length` nenhum (o caso acima) já ser
     contado byte a byte. Acreditar no cabeçalho na direção contrária —
     "declarou pequeno, então leio sem contar" — é o furo que o teste de
     cima fecha. */
  await recusa('/content-length-mentiroso', 'corpo grande demais', 'content-length declarando acima do teto');

  /* ---- CORPO QUE NÃO É JSON --------------------------------------- */
  const html = await puxar('/nao-json');
  igual(html.status, 200, 'resposta não-JSON não explode');
  igual(html.corpo, null, 'e chega como corpo nulo, para quem chama decidir (502)');

  /* ---- 404 CONTINUA DISTINGUÍVEL ---------------------------------- */
  const ausente = await puxar('/nao-existe');
  igual(ausente.status, 404, '404 do contratante chega como 404, não como recusa');

  /* ---- TETO DE TEMPO É OBRIGATÓRIO -------------------------------- */
  await assert.rejects(
    () => puxarDoContratante(`${base}/ok`, { chave: 'x', aceitarAlvo }),
    /sem teto de tempo/,
    'chamar sem AbortSignal é erro, não uma chamada que espera para sempre'
  );
  checagens += 1;

  /* ---- E O VALIDADOR DE VERDADE AINDA MANDA ----------------------- */
  await assert.rejects(
    () => puxar('/ok', { aceitarAlvo: undefined }),
    (erro) => erro instanceof RespostaRecusada && erro.motivo === 'alvo inseguro',
    'sem a injeção do teste, o alvo http local é recusado pelo validador de produção'
  );
  checagens += 1;
} finally {
  servidor.close();
}

/* ------------------------------------------------------------------
   NENHUM CHAMADOR DE PRODUÇÃO AFROUXA A REGRA

   `aceitarAlvo` é a válvula que este teste abre. Se um dia ela aparecer
   no `src/`, o guarda vira decoração — e é justamente o tipo de coisa
   que passa numa revisão de diff grande.
------------------------------------------------------------------ */


const infratores = [];
let chamadores = 0;
for (const caminho of arquivosJs(join(RAIZ, 'src'))) {
  const fonte = readFileSync(caminho, 'utf8');
  if (caminho.endsWith('puxarDoContratante.js')) continue;
  if (!fonte.includes('puxarDoContratante(')) continue;
  chamadores += 1;
  if (/aceitarAlvo/.test(fonte)) infratores.push(relative(RAIZ, caminho));
}

ok(chamadores >= 1, `controle positivo: a varredura precisa ACHAR chamadores (achou ${chamadores})`);
igual(infratores, [], 'nenhum chamador de produção passa `aceitarAlvo` — a válvula é só do teste');

/* E os dois pulls do modelo passam por aqui, não por `fetch` cru. */
const fonteDoPull = readFileSync(join(RAIZ, 'src/services/pedidoService.js'), 'utf8');
igual(
  (fonteDoPull.match(/puxarDoContratante\(/g) ?? []).length, 2,
  'resolverPedido e resolverPlano usam o pull seguro'
);
ok(
  !/=\s*await fetch\(/.test(fonteDoPull),
  'e nenhum dos dois voltou a chamar `fetch` cru — era por ali que o redirect passava'
);
ok(MAXIMO_DE_SALTOS >= 1 && MAXIMO_DE_SALTOS <= 5, 'a cadeia de redirect tem teto pequeno e explícito');

console.log(`pull-nao-segue-para-onde-quiser: ${checagens} checagens OK`);
