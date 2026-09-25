#!/usr/bin/env node
/**
 * tests/identificador-canonico-em-toda-fronteira.js
 *
 * CLASSE CR-01 da remediação da Estação 6 (SEC-001, SEC-003, SEC-017,
 * SEC-026): identificador não canônico atravessando fronteira.
 *
 * O que quebrava: o Express decodifica `%2F`/`%3F` num parâmetro de rota e
 * `new URL()` resolve `..` — um `pedidoId` adulterado virava OUTRO caminho
 * de uma requisição autenticada (com a `X-Checkout-Key` do contratante, ou
 * com a chave da conta-mãe na Asaas), e `./ped_1` era o mesmo pedido no
 * contratante e outra chave no nosso banco.
 *
 * Esta suíte ataca a PILHA MONTADA de verdade (`src/server.js`) com cada
 * grafia da lista da remediação, crua e codificada, em todas as rotas que
 * recebem id — e confere duas coisas por requisição: a resposta é recusa
 * (400/404, nunca 2xx nem 5xx) e NENHUMA chamada de saída aconteceu
 * (nem banco, nem contratante, nem Asaas). O `fetch` global é trocado
 * por um que só anota: tudo que o app manda para fora passa por ele.
 *
 * Controle positivo: o id canônico CHEGA até a camada de dados (uma
 * chamada de saída é anotada). Sem ele, "nenhuma saída" poderia ser uma
 * guarda que recusa tudo.
 *
 * E a parte que protege o futuro: checagens sobre o código-fonte de que
 * todo roteiro com parâmetro de id registra o guarda, todo caminho da
 * Asaas passa por `segmentoAsaas`, todo pull codifica o segmento e todo
 * caminho de API montado no front usa `encodeURIComponent`.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

let checagens = 0;
const ok = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

process.env.CHECKOUT_SEM_LISTEN = '1';
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? 'teste';

/* Tudo que o app manda para fora é anotado e FALHA como rede fora do ar.
   Trocado ANTES de importar o app: o cliente do Supabase guarda a
   referência do `fetch` quando é construído. */
const saidas = [];
globalThis.fetch = async (url) => {
  saidas.push(String(url?.url ?? url));
  throw new TypeError('fetch failed (rede desligada neste teste)');
};

const { app } = await import('../src/server.js');
const servidor = app.listen(0);
await once(servidor, 'listening');
const porta = servidor.address().port;

/* `http.request` e não `fetch`: o caminho vai CRU, sem a normalização que
   `URL` faria no cliente (`./` e `../` sumiriam antes de sair).

   Cada requisição leva um `X-Forwarded-For` próprio: sem proxy de verdade
   na frente, o `trust proxy 1` do app lê o IP do cliente dali, e cada
   uma cai num balde novo do limitador. Sem isto, a 61ª requisição da
   suíte viria 429 — recusa também, mas do limitador, não do guarda que
   esta suíte existe para provar. */
let ipDeTeste = 0;
function chamar(caminho, { metodo = 'GET', corpo } = {}) {
  ipDeTeste += 1;
  const ip = `10.${(ipDeTeste >> 16) & 255}.${(ipDeTeste >> 8) & 255}.${ipDeTeste & 255}`;
  return new Promise((resolver) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const req = http.request({
      host: '127.0.0.1', port: porta, method: metodo, path: caminho,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(dados ? { 'content-length': Buffer.byteLength(dados) } : {}) }
    }, (res) => {
      let texto = '';
      res.on('data', (c) => { texto += c; });
      res.on('end', () => resolver({ http: res.statusCode, texto }));
    });
    req.on('error', (erro) => resolver({ http: 0, texto: String(erro) }));
    if (dados) req.write(dados);
    req.end();
  });
}

const CORPO_COMPRADOR = {
  nome: 'Comprador de Teste', email: 'comprador@teste.com', documento: '11144477735', telefone: '16987654321',
  endereco: 'Rua A', enderecoNumero: '1', bairro: 'Centro', cep: '01310100', cidadeIbge: '3550308', parcelas: 1, cotacaoId: 'cot_1'
};

/* As grafias da remediação, na forma em que chegam pela rede. `cru` é o
   texto literal no caminho; `cod` é a forma codificada, que o Express
   decodifica no parâmetro. */
const GRAFIAS = [
  ['./ped_1', '.%2Fped_1'], ['../ped_1', '..%2Fped_1'], ['a/../ped_1', 'a%2F..%2Fped_1'],
  ['//ped_1', '%2F%2Fped_1'], [null, 'ped_1%2F'], [null, '%2e'], [null, '%2E%2E'], [null, '%2f'],
  [null, '%252e'], [null, '%255c'], [null, '%5C'], [null, 'ped_1%5C..%5Cx'],
  [null, 'ped%E2%88%95x'], [null, 'ped%EF%BC%8Fx'], [null, 'ped%E2%81%84x'],
  [null, 'ped_1%3Fx%3D1'], [null, 'ped_1%23x'], [null, 'ped%00'], [null, 'ped%0A1'], [null, 'ped%091'],
  [null, 'ped%7F'], [null, 'ped%20x'], [null, 'p%C3%A9d'], [null, 'ped%7C1'], [null, '..'], [null, '.'],
  [null, 'x'.repeat(129)], [null, 'ped%'], [null, '%E0%A4%A']
].flatMap(([cru, cod]) => [cru, cod].filter(Boolean));

/* Rotas com id, com o id na posição do PEDIDO/PLANO e na do CONTRATANTE. */
const ROTAS = [
  ['GET', (c, p) => `/api/checkout/pedido/${c}/${p}`],
  ['GET', (c, p) => `/api/checkout/plano/${c}/${p}`],
  ['POST', (c, p) => `/api/checkout/pix/${c}/${p}`],
  ['POST', (c, p) => `/api/checkout/boleto/${c}/${p}`],
  ['POST', (c, p) => `/api/checkout/cartao/${c}/${p}`],
  ['POST', (c, p) => `/api/checkout/assinatura/${c}/${p}`],
  ['POST', (c, p) => `/api/checkout/assinatura-pix/${c}/${p}`],
  ['GET', (c, p) => `/api/checkout/status/${c}/${p}`],
  ['GET', (c, p) => `/api/checkout/cobranca/${c}/${p}`]
];
const ROTAS_DE_UM_ID = [
  ['GET', (id) => `/api/checkout/pix/status/${id}`],
  ['GET', (id) => `/api/checkout/boleto/status/${id}`],
  ['GET', (id) => `/api/checkout/asaas-checkout/status/${id}`]
];

async function recusaSemSaida(metodo, caminho) {
  const antes = saidas.length;
  const r = await chamar(caminho, { metodo, corpo: metodo === 'POST' ? CORPO_COMPRADOR : undefined });
  ok(r.http === 400 || r.http === 404, `${metodo} ${caminho.slice(0, 90)} → recusa (400/404), veio ${r.http} ${r.texto.slice(0, 120)}`);
  ok(saidas.length === antes, `${metodo} ${caminho.slice(0, 90)} → NENHUMA chamada de saída (banco, contratante ou Asaas); saíram ${saidas.slice(antes).join(', ')}`);
  ok(!/\bat [\w.]+ \(|node_modules|stack/i.test(r.texto), `${metodo} ${caminho.slice(0, 60)} → sem rastro de pilha na resposta`);
}

try {
  let recusadas = 0;
  for (const [metodo, montar] of ROTAS) {
    for (const g of GRAFIAS) {
      await recusaSemSaida(metodo, montar('testemaster', g)); recusadas += 1;
      await recusaSemSaida(metodo, montar(g, 'ped_valido_123')); recusadas += 1;
    }
  }
  for (const [metodo, montar] of ROTAS_DE_UM_ID) {
    for (const g of GRAFIAS) { await recusaSemSaida(metodo, montar(g)); recusadas += 1; }
  }

  /* A recusa é a do NOSSO guarda, com a mensagem do contrato — não um
     404 qualquer do roteador (que provaria só que a rota não casou). */
  const r400 = await chamar('/api/checkout/pedido/testemaster/..%2Fadmin%2Fsegredos%3Fx%3D');
  ok(r400.http === 400 && /pedidoId é inválido/.test(r400.texto), `o ataque do achado SEC-001 é recusado pelo guarda canônico; veio ${r400.http} ${r400.texto}`);
  const r400c = await chamar('/api/checkout/pedido/test%2Fmaster/ped_1');
  ok(r400c.http === 400 && /contratanteId é inválido/.test(r400c.texto), `contratanteId adulterado idem; veio ${r400c.http} ${r400c.texto}`);

  /* ---- CONTROLE POSITIVO: o id canônico chega à camada de dados ---- */
  for (const [metodo, caminho] of [
    ['GET', '/api/checkout/pedido/testemaster/ped_valido_123'],
    ['GET', '/api/checkout/plano/testemaster/plano_anual'],
    ['GET', '/api/checkout/status/testemaster/ped_valido_123'],
    ['GET', '/api/checkout/pix/status/pay_4b4o86s675b7sw5n'],
    ['POST', '/api/checkout/pix/testemaster/ped_valido_123'],
    ['GET', '/api/checkout/pedido/testemaster/550e8400-e29b-41d4-a716-446655440000']
  ]) {
    const antes = saidas.length;
    await chamar(caminho, { metodo, corpo: metodo === 'POST' ? CORPO_COMPRADOR : undefined });
    ok(saidas.length > antes, `controle positivo: ${metodo} ${caminho} CHEGA à camada de dados (a guarda não recusa tudo)`);
  }
  ok(recusadas > 500, `cobertura: ${recusadas} requisições adulteradas`);
} finally {
  servidor.close();
}

/* ---- O CÓDIGO-FONTE: rota nova, caminho novo e tela nova nascem cobertos ---- */
const ler = (rel) => readFileSync(join(RAIZ, rel), 'utf8');
const { PARAMETROS_DE_ID } = await import('../src/middlewares/idsCanonicos.js');

for (const arquivo of readdirSync(join(RAIZ, 'src/routes'))) {
  const fonte = ler(`src/routes/${arquivo}`);
  const parametros = [...fonte.matchAll(/router\.\w+\(\s*'[^']*'/g)].flatMap((m) => [...m[0].matchAll(/:(\w+)/g)].map((x) => x[1]));
  for (const p of parametros) {
    ok(PARAMETROS_DE_ID.includes(p), `${arquivo}: o parâmetro :${p} está na lista do guarda canônico (senão nasceria sem guarda)`);
  }
  if (parametros.length) {
    ok(/exigirParametrosCanonicos\((?:Router|roteador)\(\)\)/.test(fonte), `${arquivo}: declara :${[...new Set(parametros)].join(', :')} e registra o guarda canônico`);
  }
}

const asaas = ler('src/services/asaasService.js');
const caminhosAsaas = [...asaas.matchAll(/`\/v3\/[^`]*`/g)].map((m) => m[0]);
ok(caminhosAsaas.length >= 15, `achou os caminhos da Asaas (${caminhosAsaas.length}) — senão a checagem abaixo não conferiria nada`);
for (const caminho of caminhosAsaas) {
  for (const [, expr] of caminho.matchAll(/\$\{([^}]+)\}/g)) {
    ok(/^(segmentoAsaas|encodeURIComponent)\(/.test(expr), `asaasService: ${caminho} interpola "${expr}" sem segmentoAsaas/encodeURIComponent`);
  }
}

const pedidoService = ler('src/services/pedidoService.js');
const pulls = [...pedidoService.matchAll(/puxarDoContratante\(`([^`]*)`/g)].map((m) => m[1]);
ok(pulls.length === 2, `os dois pulls (pedido e plano) foram achados, vieram ${pulls.length}`);
for (const url of pulls) {
  for (const [, expr] of url.matchAll(/\$\{([^}]+)\}/g)) {
    ok(expr === 'contratante.api_base_url' || /^encodeURIComponent\(/.test(expr), `pedidoService: o pull ${url} interpola "${expr}" sem codificar`);
  }
}

function arquivosJs(dir) {
  return readdirSync(join(RAIZ, dir), { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? arquivosJs(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []
  ));
}
let caminhosFront = 0;
for (const arquivo of arquivosJs('public/js')) {
  for (const [modelo] of ler(arquivo).matchAll(/`\/(api\/[a-z-]+|contratantes|subcontas|filas)\/[^`]*`/g)) {
    for (const [, expr] of modelo.matchAll(/\$\{([^}]+)\}/g)) {
      caminhosFront += 1;
      ok(/^(encodeURIComponent\(|montarRetornoNaQuery\(\))/.test(expr), `${arquivo}: ${modelo} interpola "${expr}" sem encodeURIComponent`);
    }
  }
}
ok(caminhosFront >= 20, `achou os segmentos montados no front (${caminhosFront})`);

console.log(`identificador-canonico-em-toda-fronteira: ${checagens} checagens OK`);
process.exit(0);
