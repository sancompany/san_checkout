#!/usr/bin/env node
/**
 * tests/saida-nunca-segue-redirecionamento.js
 *
 * CLASSE CR-04 da remediação da Estação 6 (SEC-006, SEC-021): saída para
 * destino de terceiro sem revalidação no envio.
 *
 * O furo: a outbox entregava o aviso ao contratante com o `fetch` padrão,
 * que SEGUE redirecionamento. Um endpoint de contratante que respondesse
 * 307 para a rede interna levava o POST — assinatura HMAC, documento do
 * pagador no corpo — até lá, e a entrega era contada como feita.
 *
 * Aqui o `fetch` é o de VERDADE (undici, o do Node 22) contra dois
 * servidores HTTP locais: o "do contratante", que responde cada 3xx da
 * lista da remediação apontando para o segundo, e o "interno", que conta
 * o que recebe. Para os servidores locais passarem, o teste troca o
 * validador de destino (`aceitarAlvo`) — e prova, à parte, que com o
 * validador de produção um endereço local nem chega a ser chamado.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? 'teste';

const { entregar } = await import('../src/services/outboxService.js');
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

let checagens = 0;
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };
const igual = (a, b, m) => { assert.deepEqual(a, b, m); checagens += 1; };

/* O servidor "interno" — o que não pode receber nada. */
const internas = [];
const interno = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => { corpo += c; });
  req.on('end', () => { internas.push({ metodo: req.method, cabecalhos: req.headers, corpo }); res.end('ok'); });
});
interno.listen(0);
await once(interno, 'listening');
const urlInterna = `http://127.0.0.1:${interno.address().port}/metadata/segredo`;

/* O servidor "do contratante": responde o status do caminho. */
let recebidasContratante = 0;
const contratante = http.createServer((req, res) => {
  recebidasContratante += 1;
  req.resume();
  const status = Number(req.url.split('/').pop());
  if (status >= 300 && status < 400) {
    res.writeHead(status, { Location: urlInterna });
    return res.end();
  }
  res.writeHead(status || 200, { 'content-type': 'application/json' });
  res.end('{"recebido":true}');
});
contratante.listen(0);
await once(contratante, 'listening');
const base = `http://127.0.0.1:${contratante.address().port}`;

const linha = (url) => ({
  id: '11111111-1111-4111-8111-111111111111',
  url,
  chave_idempotencia: 'pay_1|confirmado',
  payload: { versao: 2, pedidoId: 'p', chargeId: 'pay_1', status: 'confirmado', documento: '11144477735' },
  tentativas: 0
});
const depsDeTeste = { fetch: (...a) => globalThis.fetch(...a), agora: () => new Date(), aceitarAlvo: () => true };

try {
  /* ---- controle positivo: 200 é entrega ---- */
  const r200 = await entregar(linha(`${base}/hook/200`), 'segredo', depsDeTeste);
  igual([r200.ok, r200.status], [true, 200], 'controle: 200 é entrega feita (senão "recusou" abaixo poderia recusar tudo)');

  /* ---- cada 3xx: falha de entrega, e NADA vai ao destino do Location ---- */
  for (const status of [301, 302, 303, 307, 308]) {
    const antesInternas = internas.length;
    const r = await entregar(linha(`${base}/hook/${status}`), 'segredo', depsDeTeste);
    igual([r.ok, r.status], [false, status], `${status}: é FALHA de entrega, não "enviada"`);
    ok(/redirecionamento não é seguido/.test(r.erro), `${status}: e o motivo diz que o redirecionamento não foi seguido`);
    igual(internas.length, antesInternas, `${status}: o destino do Location NÃO recebeu nada — nem o POST, nem o corpo, nem a assinatura`);
  }

  /* ---- sabotagem de referência: o fetch PADRÃO (follow) teria levado ---- */
  {
    const antes = internas.length;
    await globalThis.fetch(`${base}/hook/307`, { method: 'POST', body: '{"documento":"11144477735"}', headers: { 'X-Checkout-Signature': 'x' } });
    ok(internas.length === antes + 1 && internas.at(-1).corpo.includes('11144477735'), 'referência: com redirect "follow", o 307 leva o POST com o CPF ao destino interno — é o furo que a correção fecha');
    ok(internas.at(-1).cabecalhos['x-checkout-signature'] === 'x', 'e leva a assinatura junto');
  }

  /* ---- o validador de PRODUÇÃO recusa o destino local sem chamar ---- */
  {
    const antes = recebidasContratante;
    const r = await entregar(linha(`${base}/hook/200`), 'segredo', { fetch: (...a) => globalThis.fetch(...a), agora: () => new Date() });
    igual([r.ok, r.status], [false, null], 'validador de produção: http://127.0.0.1 é recusado');
    igual(recebidasContratante, antes, 'e nenhuma requisição sai');
    for (const url of ['https://[::ffff:127.0.0.1]/hook', 'https://[::ffff:169.254.169.254]/latest', 'https://localhost./hook', 'https://u:s@api.parceiro.com.br/hook', 'https://198.18.0.1/hook']) {
      let chamou = false;
      const rr = await entregar(linha(url), 'segredo', { fetch: async () => { chamou = true; return { ok: true, status: 200 }; }, agora: () => new Date() });
      ok(!rr.ok && !chamou, `revalidação no envio recusa ${url} sem chamar`);
    }
  }
} finally {
  interno.close();
  contratante.close();
}

/* ---- busca transversal: toda chamada de saída de produção decide redirect ----
   O `fetch` padrão segue; num redirecionamento de origem, o Node só
   descarta `Authorization` — o `access_token` da Asaas e a
   `X-Checkout-Key` do contratante iriam junto. Toda chamada de `src/`
   (fora dos autotestes) tem de dizer `redirect:`. */
function arquivosJs(dir) {
  return readdirSync(join(RAIZ, dir), { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? arquivosJs(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []
  ));
}
let chamadas = 0;
for (const arquivo of arquivosJs('src')) {
  const fonte = readFileSync(join(RAIZ, arquivo), 'utf8');
  const producao = fonte.split(/\nif \(process\.argv\[1\]/)[0];
  for (const m of producao.matchAll(/(?<![\w.])(?:deps\.)?fetch\(/g)) {
    const trecho = producao.slice(m.index, m.index + 900);
    const fim = trecho.indexOf('});');
    const chamada = fim === -1 ? trecho : trecho.slice(0, fim);
    chamadas += 1;
    ok(/redirect:\s*'(manual|error)'/.test(chamada), `${arquivo}: fetch( sem redirect: 'manual'|'error' — ${chamada.slice(0, 80).replace(/\s+/g, ' ')}`);
  }
}
ok(chamadas >= 3, `a busca achou as chamadas de saída (outbox, Asaas, pull): ${chamadas}`);

console.log(`saida-nunca-segue-redirecionamento: ${checagens} checagens OK`);
