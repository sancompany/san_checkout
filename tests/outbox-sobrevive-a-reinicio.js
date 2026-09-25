#!/usr/bin/env node
/**
 * tests/outbox-sobrevive-a-reinicio.js
 *
 * H-01 da auditoria de 24/09/2026 — **a notificação ao contratante é
 * durável**:
 *
 *   o processo que enfileirou o aviso MORRE depois de uma tentativa que
 *   falhou; um processo NOVO, sem nada em memória, encontra o aviso no
 *   banco, entrega, e o contratante recebe o MESMO `eventoId` — o que
 *   permite a ele deduplicar.
 *
 * POR QUE ISTO MERECE TESTE
 * Até 24/09 o retry vivia em `setTimeout().unref()`: reiniciar o
 * processo entre duas tentativas perdia o aviso, e o `API.md` §4.3.6
 * chegava a avisar disso. Provar durabilidade dentro de um processo só
 * não prova nada — por isso aqui são DOIS processos de verdade, com um
 * banco de mentira num ARQUIVO (`tests/banco-falso/`), e um contratante
 * de mentira que cai na primeira e levanta na segunda.
 *
 * Sabotagem verificada: fazer `enviarPendentes` ler de uma lista em
 * memória em vez da tabela reprova ("processo B não entregou"); mudar o
 * `eventoId` no reenvio reprova ("eventoId diferente").
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let checagens = 0;
const igual = (a, b, m) => { assert.deepEqual(a, b, m); checagens += 1; };
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };

/* O contratante de mentira: cai na primeira entrega, levanta depois. */
const recebidas = [];
let quedas = 1;
const contratante = createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => { corpo += c; });
  req.on('end', () => {
    recebidas.push({ headers: req.headers, corpo: JSON.parse(corpo) });
    if (quedas > 0) { quedas -= 1; res.statusCode = 503; res.end('fora do ar'); return; }
    res.statusCode = 200; res.end('{"ok":true}');
  });
});
contratante.listen(0, '127.0.0.1');
await once(contratante, 'listening');
const url = `http://127.0.0.1:${contratante.address().port}/hook`;

const pasta = mkdtempSync(join(tmpdir(), 'outbox-'));
const arquivo = join(pasta, 'banco.json');
writeFileSync(arquivo, JSON.stringify({ tabelas: { contratantes: [{ id: 'c1', api_key: 'segredo-do-teste', webhook_url: url }] } }));

const ambiente = {
  ...process.env,
  SUPABASE_URL: 'http://127.0.0.1:0', SUPABASE_SERVICE_KEY: 'teste',
  BANCO_FALSO_ARQUIVO: arquivo, URL_DO_CONTRATANTE: url
};
/* `spawn` ASSÍNCRONO de propósito: `spawnSync` travaria o event loop
   deste processo, e o contratante de mentira (que vive AQUI) nunca
   atenderia o filho — foi o primeiro modo de falha deste teste. */
async function processo(codigo) {
  const filho = spawn(process.execPath, ['--import', './tests/banco-falso/loader.mjs', '--input-type=module', '-e', codigo], { cwd: RAIZ, env: ambiente });
  let stdout = ''; let stderr = '';
  filho.stdout.on('data', (c) => { stdout += c; });
  filho.stderr.on('data', (c) => { stderr += c; });
  const [status] = await once(filho, 'close');
  if (status !== 0) throw new Error(`processo filho falhou:\n${stderr}`);
  return stdout.trim();
}

/* PROCESSO A: enfileira, tenta uma vez (o contratante está caído), morre. */
const saidaA = await processo(`
  import { enfileirarNotificacao, tentarAgora } from './src/services/outboxService.js';
  const { id, nova } = await enfileirarNotificacao({
    contratanteId: 'c1', url: process.env.URL_DO_CONTRATANTE, tipo: 'pedido', evento: 'confirmado',
    chaveIdempotencia: 'pedido|pay_1|confirmado', payload: { versao: 2, pedidoId: 'ped_1', status: 'confirmado' }
  });
  // O contratante deste teste é um servidor em 127.0.0.1: o validador de
  // destino de produção o recusaria (SEC-006) — o teste o troca, como a
  // suíte de redirecionamento faz; a recusa em si é provada lá.
  tentarAgora(id, { deps: { fetch: (...a) => globalThis.fetch(...a), agora: () => new Date(), aceitarAlvo: () => true } });
  await new Promise((r) => setTimeout(r, 400));
  console.log(JSON.stringify({ id, nova }));
`);
const { id: idA, nova } = JSON.parse(saidaA);
ok(nova, 'processo A enfileirou uma linha nova');
igual(recebidas.length, 1, 'processo A tentou UMA vez e o contratante estava caído');
igual(recebidas[0].headers['x-checkout-event-id'], idA, 'a tentativa levou o eventoId da linha');

const depoisDeA = JSON.parse(readFileSync(arquivo, 'utf8')).tabelas.outbox_notificacoes;
igual(depoisDeA.length, 1);
igual(depoisDeA[0].status, 'falhou', 'a falha ficou GRAVADA — não num timer do processo que morreu');
igual(depoisDeA[0].tentativas, 1);
ok(depoisDeA[0].proxima_tentativa_em > new Date().toISOString(), 'com a próxima tentativa agendada no futuro (recuo)');

/* PROCESSO B: nasce do zero. O worker lê a tabela e entrega. */
const saidaB = await processo(`
  import { enviarPendentes } from './src/services/outboxService.js';
  // o relógio do worker está 5 minutos no futuro: o recuo já venceu
  const agora = () => new Date(Date.now() + 5 * 60_000);
  const relatorio = await enviarPendentes({ deps: { fetch: (...a) => globalThis.fetch(...a), agora, aceitarAlvo: () => true } });
  console.log(JSON.stringify(relatorio));
`);
const relatorioB = JSON.parse(saidaB);
igual(relatorioB.enviadas, 1, `H-01: o processo B, sem nada em memória, entregou o que A deixou (${saidaB})`);
igual(recebidas.length, 2, 'o contratante recebeu a segunda tentativa');
igual(recebidas[1].headers['x-checkout-event-id'], idA, 'com o MESMO eventoId — é assim que ele deduplica');
igual(recebidas[1].corpo.eventoId, idA, 'no corpo também');
igual(recebidas[1].corpo.pedidoId, 'ped_1');
ok(/^sha256=[0-9a-f]{64}$/.test(recebidas[1].headers['x-checkout-signature']), 'assinada com o segredo lido do banco na hora');

const depoisDeB = JSON.parse(readFileSync(arquivo, 'utf8')).tabelas.outbox_notificacoes;
igual(depoisDeB[0].status, 'enviada');
igual(depoisDeB[0].tentativas, 1, 'a contagem de tentativas é a da linha, não do processo');

/* PROCESSO C: uma terceira passada NÃO reentrega (a linha está enviada). */
const saidaC = await processo(`
  import { enviarPendentes } from './src/services/outboxService.js';
  console.log(JSON.stringify(await enviarPendentes({ deps: { fetch: (...a) => globalThis.fetch(...a), agora: () => new Date(Date.now() + 10 * 60_000), aceitarAlvo: () => true } })));
`);
igual(JSON.parse(saidaC).examinadas, 0, 'linha enviada não é reexaminada');
igual(recebidas.length, 2, 'e o contratante não ouviu uma terceira vez');

/* O mesmo fato de novo (retry do webhook da Asaas) NÃO vira segunda linha. */
const saidaD = await processo(`
  import { enfileirarNotificacao } from './src/services/outboxService.js';
  console.log(JSON.stringify(await enfileirarNotificacao({ contratanteId: 'c1', url: process.env.URL_DO_CONTRATANTE, tipo: 'pedido', evento: 'confirmado', chaveIdempotencia: 'pedido|pay_1|confirmado', payload: {} })));
`);
const d = JSON.parse(saidaD);
igual(d.nova, false, 'mesma chave do fato: não é linha nova');
igual(d.id, idA, 'e devolve o id da linha que já existe');

contratante.close();
console.log(`outbox-sobrevive-a-reinicio: ${checagens} checagens OK`);
