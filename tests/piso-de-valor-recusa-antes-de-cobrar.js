#!/usr/bin/env node
/**
 * tests/piso-de-valor-recusa-antes-de-cobrar.js
 *
 * A Asaas recusa toda cobrança abaixo de R$ 5,00 no valor cobrado —
 * medido em 17/09/2026 de dentro do contêiner de produção, nos seis
 * caminhos, com controle positivo em R$ 5,00 exato (a tabela está em
 * `src/utils/validadores.js`). Antes desta correção o comprador
 * descobria isso DEPOIS de preencher nome, e-mail, CPF, telefone e —
 * no cartão — endereço inteiro, porque quem recusava era a Asaas, no
 * clique, em linguagem de provedor.
 *
 * Esta suíte trava três coisas diferentes, e as três são necessárias:
 *
 *   1. COMPORTAMENTO — a rota que abre a tela devolve `bloqueio` abaixo
 *      do piso e não devolve em cima dele, exercitada por HTTP de
 *      verdade (Express no ar, `fetch` na porta), não chamando a função.
 *   2. ALCANCE — nenhuma criação de cobrança na Asaas escapa do guarda.
 *      Varredura sobre os controllers em vez de uma lista escrita à mão:
 *      rota nova amanhã entra na conta sozinha. É a mesma forma de
 *      `nenhuma-chamada-de-saida-sem-teto.js`, pelo mesmo motivo — a
 *      regra já era conhecida em um lugar e não foi aplicada nos outros.
 *   3. A ARMADILHA DO EXPRESS — os dois resolvers ganharam injeção para
 *      poderem ser testados. Se alguém a transformar num terceiro
 *      parâmetro do handler, o Express passa `next` ali e a rota quebra
 *      em produção com o teste verde. O teste mede a aridade.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { criarObterPedido } from '../src/controllers/pedidoController.js';
import { criarObterPlano, obterPlano } from '../src/controllers/planoController.js';
import { obterPedido } from '../src/controllers/pedidoController.js';
import { PISO_ASAAS } from '../src/utils/validadores.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let checagens = 0;
const ok = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };
const igual = (a, b, mensagem) => { assert.deepEqual(a, b, mensagem); checagens += 1; };

/* ------------------------------------------------------------------
   1. COMPORTAMENTO — Express de verdade, `fetch` de verdade
------------------------------------------------------------------ */

const contratanteFalso = { nome: 'Loja de Teste', metodos_habilitados: null, api_base_url: 'https://loja.exemplo' };

function pedidoDe(valor) {
  return { descricao: 'Pedido de teste', valorComDesconto: valor, frete: 0, itens: [] };
}

const { default: express } = await import('express');
const app = express();
app.get('/pedido/:contratanteId/:pedidoId', criarObterPedido({
  resolverPedido: async (_c, pedidoId) => ({
    contratante: contratanteFalso,
    pedido: pedidoDe(Number(pedidoId))
  })
}));
app.get('/plano/:contratanteId/:planoId', criarObterPlano({
  resolverPlano: async (_c, planoId) => ({
    contratante: contratanteFalso,
    plano: { nome: 'Plano de teste', valor: Number(planoId), ciclo: 'MONTHLY' }
  })
}));

const servidor = app.listen(0);
await new Promise((pronto) => servidor.once('listening', pronto));
const base = `http://127.0.0.1:${servidor.address().port}`;

/** Nenhuma chamada de saída sem teto — inclusive a daqui
 *  (`tests/nenhuma-chamada-de-saida-sem-teto.js` varre este arquivo). */
async function pegar(caminho) {
  const cancelador = new AbortController();
  const relogio = setTimeout(() => cancelador.abort(), 5000);
  try {
    const resposta = await fetch(base + caminho, { signal: cancelador.signal });
    return { http: resposta.status, corpo: await resposta.json() };
  } finally { clearTimeout(relogio); }
}

try {
  /* PEDIDO. O piso é sobre o valor COBRADO, não sobre o do pedido: com
     a taxa padrão (0,9% + R$ 0,50 nossa, R$ 1,99 fixa da Asaas), um
     pedido de R$ 2,00 fecha abaixo de R$ 5,00 e um de R$ 4,00 fecha
     acima. Por isso os dois lados são conferidos pelo TOTAL que a
     resposta traz, e não pelo número que eu digitei aqui — se a tabela
     de taxa mudar, o teste continua medindo a regra certa. */
  const barato = await pegar('/pedido/c1/2');
  ok(barato.http === 200, 'pedido abaixo do piso ainda responde 200 (a tela existe, só não é comprável)');
  ok(barato.corpo.taxa?.valorCobrado < PISO_ASAAS, 'controle: o total deste pedido está mesmo abaixo do piso');
  ok(barato.corpo.bloqueio?.codigo === 'valor_abaixo_do_piso', 'e a resposta traz o bloqueio');
  ok(/R\$ 5,00/.test(barato.corpo.bloqueio.mensagem), 'a mensagem diz o valor mínimo ao comprador');
  ok(barato.corpo.taxa !== null, 'o total continua vindo — o valor é aquele mesmo, o que muda é a tela');

  const caro = await pegar('/pedido/c1/40');
  ok(caro.corpo.taxa.valorCobrado >= PISO_ASAAS, 'controle positivo: o total deste pedido está acima do piso');
  ok(caro.corpo.bloqueio === undefined, 'pedido acima do piso NÃO traz bloqueio');

  /* A fronteira exata. Um pedido cujo total dá exatamente R$ 5,00 tem
     de PASSAR — foi o controle positivo da medição na Asaas. Sem esta
     checagem, trocar `>=` por `>` no validador passaria despercebido. */
  const piso = await pegar('/pedido/c1/2.49');
  igual(piso.corpo.taxa.valorCobrado, 5, 'controle: este pedido fecha em R$ 5,00 cravado');
  ok(piso.corpo.bloqueio === undefined, 'R$ 5,00 exato passa — é o valor que a Asaas aceitou');

  /* PLANO. Assinatura não leva taxa nossa: o piso bate direto no valor
     do plano. */
  const planoBarato = await pegar('/plano/c1/3');
  ok(planoBarato.corpo._checkout?.bloqueio?.codigo === 'valor_abaixo_do_piso', 'plano de R$ 3,00 traz bloqueio');
  const planoNoPiso = await pegar('/plano/c1/5');
  ok(planoNoPiso.corpo._checkout?.bloqueio === undefined, 'plano de R$ 5,00 exato passa');
  const planoCaro = await pegar('/plano/c1/267.30');
  ok(planoCaro.corpo._checkout?.bloqueio === undefined, 'plano real da MostrAí passa');
  ok(planoCaro.corpo.valor === 267.3, 'e o plano continua indo cru, como o API.md §4.2 promete');
} finally {
  servidor.close();
}

/* ------------------------------------------------------------------
   2. A ARMADILHA DO EXPRESS
------------------------------------------------------------------ */

/* `app.get(rota, handler)` chama `handler(req, res, next)`. Um terceiro
   parâmetro com valor padrão receberia `next` — uma função — e
   `next.resolverPedido` seria `undefined`: o autoteste, que chama a
   função com dois argumentos, continuaria verde enquanto a rota
   quebrava em produção. A aridade é o que impede isso de voltar. */
igual(obterPedido.length, 2, 'o handler de pedido tem exatamente 2 parâmetros (req, res)');
igual(obterPlano.length, 2, 'o handler de plano tem exatamente 2 parâmetros (req, res)');

/* ------------------------------------------------------------------
   3. ALCANCE — nenhuma criação de cobrança escapa do guarda
------------------------------------------------------------------ */

/* Lista de quem CRIA cobrança na Asaas. Tudo que aparecer no `src/`
   chamando uma destas e não estiver protegido pelo piso é um caminho
   novo pelo qual o comprador volta a descobrir a recusa no clique. */
const CRIAM_COBRANCA = [
  'criarCobrancaPix',
  'criarCobrancaBoleto',
  'criarSessaoAsaasCheckout',
  'criarAutorizacaoPixAutomatico'
];

const DIR_CONTROLLERS = join(RAIZ, 'src', 'controllers');
const arquivos = readdirSync(DIR_CONTROLLERS).filter((n) => n.endsWith('.js'));

/** Recorta o corpo de cada função de nível superior do arquivo. Basta
 *  para o que se quer saber: "dentro da MESMA função, o guarda vem
 *  antes da chamada?". */
function funcoesDe(fonte) {
  const marcas = [...fonte.matchAll(/^(?:export )?(?:async )?function \w+|^\s*return async function \w+/gm)];
  return marcas.map((m, i) => fonte.slice(m.index, marcas[i + 1]?.index ?? fonte.length));
}

let chamadasEncontradas = 0;
for (const arquivo of arquivos) {
  const fonte = readFileSync(join(DIR_CONTROLLERS, arquivo), 'utf8');
  for (const corpo of funcoesDe(fonte)) {
    for (const criadora of CRIAM_COBRANCA) {
      const chamada = corpo.indexOf(`${criadora}({`);
      if (chamada === -1) continue;
      chamadasEncontradas += 1;
      const guarda = corpo.indexOf('valorCobradoAceitavel');
      ok(
        guarda !== -1 && guarda < chamada,
        `${arquivo}: ${criadora} é chamada sem o guarda do piso antes — o comprador descobre a recusa no clique`
      );
    }
  }
}

ok(
  chamadasEncontradas >= 4,
  `controle positivo: a varredura precisa ACHAR as criadoras para significar algo (achou ${chamadasEncontradas})`
);

/* ------------------------------------------------------------------
   4. O FRONT HONRA O BLOQUEIO, e não reescreve o número do piso
------------------------------------------------------------------ */

const TELAS = [
  ['public/js/modules/pedidoHandler.js', 'bloqueio?.mensagem'],
  ['public/js/modules/assinaturaHandler.js', 'bloqueio?.mensagem']
];
for (const [caminho, trecho] of TELAS) {
  const fonte = readFileSync(join(RAIZ, caminho), 'utf8');
  ok(fonte.includes(trecho), `${caminho} lê a mensagem de bloqueio que o servidor manda`);
  ok(
    !/R\$\s*5,00/.test(fonte),
    `${caminho} NÃO repete o número do piso — se ele mudar no servidor, a tela não pode mentir`
  );
}

console.log(`piso-de-valor-recusa-antes-de-cobrar: ${checagens} checagens OK`);
