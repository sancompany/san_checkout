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

import { criarObterPedido, obterPedido } from '../src/controllers/pedidoController.js';
import { criarObterPlano, obterPlano } from '../src/controllers/planoController.js';
import { PISO_ASAAS, MAXIMO_DE_PARCELAS_DO_CHECKOUT } from '../src/utils/validadores.js';
import { arquivosJs, argumentosDe } from './ajudantes.js';

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
/* A cotação (C-02) é gravada no banco pela rota real; aqui um dublê
   devolve o id sem tocar em nada — o que este teste mede é o piso. */
const criarCotacaoFalsa = async ({ totais }) => ({ id: '11111111-1111-4111-8111-111111111111', expiraEm: new Date(Date.now() + 60_000).toISOString(), totais });

const app = express();
app.get('/pedido/:contratanteId/:pedidoId', criarObterPedido({
  resolverPedido: async (_c, pedidoId) => ({
    contratante: contratanteFalso,
    pedido: pedidoDe(Number(pedidoId))
  }),
  criarCotacao: criarCotacaoFalsa
}));
app.get('/plano/:contratanteId/:planoId', criarObterPlano({
  resolverPlano: async (_c, planoId) => ({
    contratante: contratanteFalso,
    plano: { nome: 'Plano de teste', valor: Number(planoId), ciclo: 'MONTHLY' }
  }),
  criarCotacao: criarCotacaoFalsa
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
     checagem, trocar `>=` por `>` no validador passaria despercebido.

     ⚠️ O `2.49` é preso à TABELA DE TAXA: é a base que, com a taxa de
     hoje, fecha em R$ 5,00 cravados. Mudando a taxa, esta checagem
     falha — e falhar é o comportamento certo, porque a fronteira deixou
     de ser exercitada. Ao ver este teste vermelho depois de mexer em
     taxa: recalcule a base, não apague a checagem. */
  const piso = await pegar('/pedido/c1/2.49');
  igual(piso.corpo.taxa.valorCobrado, 5, 'controle: este pedido fecha em R$ 5,00 cravado');
  ok(piso.corpo.bloqueio === undefined, 'R$ 5,00 exato passa — é o valor que a Asaas aceitou');

  /* QUANTAS PARCELAS A TELA PODE OFERECER.

     O piso vale POR PARCELA, e a tela oferecia 1x a 12x fixo. Num pedido
     de R$ 24,00 o comprador escolhia 12x aqui e a pop-up abria com
     menos — duas telas discordando sobre a mesma compra. Quem decide é o
     servidor, e ele manda o número. */
  const parcelavel = await pegar('/pedido/c1/1000');
  igual(parcelavel.corpo.maxParcelas, 12, 'pedido caro pode oferecer as 12 parcelas');

  const poucoParcelavel = await pegar('/pedido/c1/24');
  ok(
    poucoParcelavel.corpo.maxParcelas < 12 && poucoParcelavel.corpo.maxParcelas >= 1,
    `pedido de R$ 24,00 oferece menos que 12 (ofereceu ${poucoParcelavel.corpo.maxParcelas})`
  );
  ok(
    poucoParcelavel.corpo.taxa.valorCobrado / poucoParcelavel.corpo.maxParcelas >= PISO_ASAAS,
    'e nenhuma parcela ofertada fica abaixo do piso'
  );
  ok(
    poucoParcelavel.corpo.taxa.valorCobrado / (poucoParcelavel.corpo.maxParcelas + 1) < PISO_ASAAS,
    'nem sobra parcela: uma a mais já cairia abaixo do piso — o corte é o MÁXIMO que cabe, não um número tímido'
  );

  /* Pedido bloqueado pelo piso do total não anuncia parcelamento
     nenhum — o `taxa` existe, mas a compra não acontece. */
  ok(barato.corpo.maxParcelas === 1 || barato.corpo.maxParcelas === undefined,
    'pedido abaixo do piso não oferece parcelamento');

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
   3.1 O QUE VAI PARA A POP-UP É O NÚMERO CAPADO, NÃO O PEDIDO

   A pop-up recebe `installment.maxInstallmentCount`, e é ele que limita
   o que o comprador pode escolher lá dentro. Mandar o número PEDIDO
   desfaz a correção inteira em silêncio: a tela mostra 5x, a pop-up
   oferece 12x, e a Asaas recusa no fim. Nenhuma suíte exercita esta
   rota (ela exige Supabase e Asaas no ar), então o que se trava é a
   fonte — e o controle positivo garante que a varredura leu a função
   certa, em vez de não achar nada e passar calada.
------------------------------------------------------------------ */

{
  const fonte = readFileSync(join(DIR_CONTROLLERS, 'asaasCheckoutController.js'), 'utf8');
  const inicio = fonte.indexOf('export async function criarCheckoutCartao');
  const fim = fonte.indexOf('export async function', inicio + 10);
  const corpo = fonte.slice(inicio, fim === -1 ? undefined : fim);

  ok(inicio !== -1 && corpo.length > 500, 'controle positivo: a varredura achou o corpo de criarCheckoutCartao');

  /* Desde 24/09/2026 (C-02) o cap mora na COTAÇÃO: `cotacaoService.
     montarTotaisPedido` chama `taxaComParcelasQueCabem` e publica
     `maxParcelas`; o controlador só escolhe dentro do que a tela já
     recebeu. O que se trava: o serviço capa, e o controlador capa pelo
     número da cotação (nunca pelo pedido cru). */
  const cotacaoFonte = readFileSync(join(RAIZ, 'src', 'services', 'cotacaoService.js'), 'utf8');
  ok(cotacaoFonte.includes('taxaComParcelasQueCabem('), 'a cotação capa as parcelas pelo piso por parcela');
  ok(/parcelasOfertadas\s*=\s*Math\.min\([\s\S]{0,80}?totais\.maxParcelas/.test(corpo), 'o cartão capa pelo maxParcelas da cotação');

  /* Fatia depois do cap: `numeroParcelas` é legitimamente o argumento
     dele. Depois disso, o número PEDIDO não pode mais aparecer. */
  const abertura = corpo.indexOf('parcelasOfertadas = Math.min(');
  const depoisDoCap = corpo.slice(corpo.indexOf(';', abertura) + 1);
  ok(
    abertura !== -1 && depoisDoCap.length > 200,
    'controle positivo: há corpo depois da chamada para varrer'
  );
  ok(
    !/\bnumeroParcelas\b/.test(depoisDoCap),
    'depois de capar, `numeroParcelas` (o número PEDIDO) não é mais usado — mandá-lo à pop-up desfaz a correção em silêncio'
  );
  ok(
    /maxInstallmentCount:\s*parcelasOfertadas/.test(corpo),
    'e o que vai em maxInstallmentCount é o número ofertado'
  );
}

/* ------------------------------------------------------------------
   3.2 NENHUM CHAMADOR DE PRODUÇÃO BAIXA O TETO DO PONTO FIXO

   `taxaComParcelasQueCabem` ganhou um quarto parâmetro — o teto de
   voltas — porque sem ele o autoteste não alcançava nem a bandeira de
   convergência nem a rede de segurança (as duas sabotagens passavam).
   É válvula de teste, e válvula de teste usada em produção é a guarda
   virando decoração: com o teto em 2 o resultado continua certo e o
   laço para de convergir, em silêncio.
------------------------------------------------------------------ */

{
  /* O `src/` INTEIRO, não só os controladores: a função é exportada de
     um serviço e pode ser chamada de qualquer lugar. Varredura com
     alcance menor que o risco é a que aprova o que ela não olhou — e a
     primeira versão desta seção olhava uma pasta só. */
  let chamadores = 0;
  const infratores = [];
  for (const caminho of arquivosJs(join(RAIZ, 'src'))) {
    const arquivo = caminho.slice(RAIZ.length + 1);
    const fonte = readFileSync(caminho, 'utf8');
    // A própria declaração não é chamada.
    if (fonte.includes('export function taxaComParcelasQueCabem')) continue;
    const NOME = 'taxaComParcelasQueCabem(';
    for (let i = fonte.indexOf(NOME); i !== -1; i = fonte.indexOf(NOME, i + 1)) {
      chamadores += 1;
      const quantos = argumentosDe(fonte, i + NOME.length - 1);
      // Três é o uso normal (base, parcelas, isenção); o quarto é o teto.
      if (quantos > 3 || quantos === -1) {
        infratores.push(`${arquivo}: chamada com ${quantos} argumentos`);
      }
    }
  }
  ok(chamadores >= 1, `controle positivo: a varredura achou chamadores (achou ${chamadores})`);
  igual(infratores, [], 'nenhum controlador passa o teto de voltas — ele é válvula do autoteste');

  /* O contador tem autoteste próprio em `tests/ajudantes.js`, com a
     armadilha de parênteses que o gerou. Não se repete aqui. */
}

/* ------------------------------------------------------------------
   4. O FRONT HONRA O BLOQUEIO, e não reescreve o número do piso
------------------------------------------------------------------ */

const TELAS = [
  ['public/js/modules/pedidoHandler.js', 'bloqueio?.mensagem'],
  ['public/js/modules/assinaturaHandler.js', 'bloqueio?.mensagem']
];

/* E a tela CORTA a lista com o número que o servidor mandou, em vez de
   confiar nas opções escritas no HTML. */
{
  const fonte = readFileSync(join(RAIZ, 'public/js/modules/pedidoHandler.js'), 'utf8');

  /* A CHAMADA, não a definição. `includes('cortarParcelas(maxParcelas)')`
     casava `function cortarParcelas(maxParcelas) {` — então apagar a
     chamada e deixar a função morta passava no teste. É a mesma
     armadilha do teste de impressão digital de 16/09: exercitar o nome
     em vez do caminho. Pego por sabotagem. */
  ok(
    /^\s+cortarParcelas\(maxParcelas\);\s*$/m.test(fonte),
    'o resumo CHAMA cortarParcelas com o máximo do servidor (não só declara a função)'
  );
  ok(
    /opcao\.remove\(\)/.test(fonte) && !/appendChild|new Option|innerHTML\s*=/.test(fonte.slice(fonte.indexOf('function cortarParcelas'), fonte.indexOf('function aplicarNoResumo'))),
    'e só REMOVE opções, nunca acrescenta — o HTML é o teto e o servidor só aperta'
  );
}

/* A TERCEIRA CÓPIA DO TETO: o `<select>` do HTML.

   O número tem um dono (`MAXIMO_DE_PARCELAS_DO_CHECKOUT`), mas markup
   não importa constante — a lista continua escrita à mão. Como o front
   só REMOVE opções, uma lista mais CURTA que o teto é um limite que o
   servidor nunca alcança: subir o teto para 18 e esquecer o HTML deixaria
   o comprador preso em 12 sem erro nenhum. E uma lista mais longa
   ofereceria o que o backend recusa com 400.

   O comentário no HTML admite essa cópia; este teste é o que impede que
   ela divirja calada. */
{
  const html = readFileSync(join(RAIZ, 'public/index.html'), 'utf8');
  const bloco = html.slice(html.indexOf('id="cartao-parcelas"'));
  const fimDoSelect = bloco.indexOf('</select>');
  ok(fimDoSelect > 0, 'controle positivo: o `<select>` de parcelas existe e foi encontrado');

  const valores = [...bloco.slice(0, fimDoSelect).matchAll(/<option value="(\d+)"/g)].map((m) => Number(m[1]));
  ok(valores.length > 1, `controle positivo: a lista tem opções para conferir (achou ${valores.length})`);
  igual(Math.min(...valores), 1, 'a lista começa em 1x');
  igual(
    Math.max(...valores), MAXIMO_DE_PARCELAS_DO_CHECKOUT,
    'e termina exatamente no teto do checkout — lista mais curta prende o comprador, mais longa oferece o que o backend recusa'
  );
  igual(
    valores, Array.from({ length: MAXIMO_DE_PARCELAS_DO_CHECKOUT }, (_, i) => i + 1),
    'e não tem buraco nem repetição no meio'
  );
}
for (const [caminho, trecho] of TELAS) {
  const fonte = readFileSync(join(RAIZ, caminho), 'utf8');
  ok(fonte.includes(trecho), `${caminho} lê a mensagem de bloqueio que o servidor manda`);
  ok(
    !/R\$\s*5,00/.test(fonte),
    `${caminho} NÃO repete o número do piso — se ele mudar no servidor, a tela não pode mentir`
  );
}

console.log(`piso-de-valor-recusa-antes-de-cobrar: ${checagens} checagens OK`);
