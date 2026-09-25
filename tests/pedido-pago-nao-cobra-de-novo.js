#!/usr/bin/env node
/**
 * tests/pedido-pago-nao-cobra-de-novo.js
 *
 * Pedido que o NOSSO banco sabe que foi pago não abre para pagar de novo,
 * diga o contratante o que disser.
 *
 * ── O caso real (25/09/2026, primeiro dia de produção) ──────────────
 * O contratante de teste guardava os pedidos pagos na memória de cada
 * instância da Cloudflare. O aviso de "pago" caiu numa instância, o pull
 * seguinte noutra — e `ped_isento` (Pix pago) e `ped_dez_cartao` (cartão
 * pago) voltaram a abrir como PAGÁVEIS. A única guarda era o `status` que
 * o contratante devolve; o nosso banco, que registrou o `confirmado`,
 * nunca era perguntado. Contratante que perde ou atrasa o registro de
 * pago é falha comum, e o comprador pagaria duas vezes.
 *
 * O teste roda o `resolverPedido` REAL num processo filho, com o banco
 * falso (`tests/banco-falso/`) e o contratante substituído por um `fetch`
 * que responde "pendente" — exatamente o que o worker respondeu.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

let checagens = 0;
const igual = (a, b, m) => { assert.equal(a, b, m); checagens += 1; };
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };

const CONTRATANTE = {
  id: 'testemaster', nome: 'TesteMaster', api_base_url: 'https://contratante-teste.exemplo.com',
  api_key: 'chave-de-teste', webhook_url: 'https://contratante-teste.exemplo.com/webhook',
  metodos_habilitados: ['pix', 'boleto', 'cartao', 'assinatura'], arquivado_em: null, retorno_dominios: null
};

/** Um cenário: as linhas de `cobrancas` do pedido, e o que o contratante diz. */
async function resolver({ cobrancas, statusNoContratante = 'pendente', bancoFora = false }) {
  const pasta = mkdtempSync(join(tmpdir(), 'pedido-pago-'));
  const arquivo = join(pasta, 'banco.json');
  writeFileSync(arquivo, JSON.stringify({ tabelas: { contratantes: [CONTRATANTE], cobrancas } }));
  const codigo = `
    const statusNoContratante = ${JSON.stringify(statusNoContratante)};
    globalThis.fetch = async (url) => new Response(JSON.stringify({
      pedidoId: String(url).split('/').pop(), tipo: 'compra_unica', status: statusNoContratante,
      descricao: 'Teste R$ 10', itens: [{ nome: 'Item', quantidade: 1, valorUnitario: 10 }],
      valorCheio: 10, desconto: 0, valorComDesconto: 10, frete: 0, isentarTaxa: true
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    ${bancoFora ? `
    const { supabase } = await import('./src/config/supabase.js');
    const original = supabase.from;
    supabase.from = (t) => t === 'cobrancas' ? { select: () => ({ eq: () => ({ eq: async () => ({ data: null, error: new Error('banco fora') }) }) }) } : original(t);
    ` : ''}
    const { resolverPedido } = await import('./src/services/pedidoService.js');
    try {
      const r = await resolverPedido('testemaster', 'ped_dez_cartao', { metodoRequerido: 'pix' });
      console.log(JSON.stringify({ liberou: true, status: r.pedido.status }));
    } catch (e) {
      console.log(JSON.stringify({ liberou: false, http: e.status, codigo: e.codigo ?? null, mensagem: e.message }));
    }
  `;
  const filho = spawn(process.execPath, ['--import', './tests/banco-falso/loader.mjs', '--input-type=module', '-e', codigo], {
    cwd: RAIZ, env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:0', SUPABASE_SERVICE_KEY: 'teste', BANCO_FALSO_ARQUIVO: arquivo }
  });
  let stdout = ''; let stderr = '';
  filho.stdout.on('data', (c) => { stdout += c; });
  filho.stderr.on('data', (c) => { stderr += c; });
  const [status] = await once(filho, 'close');
  if (status !== 0) throw new Error(`processo filho falhou:\n${stderr}`);
  return JSON.parse(stdout.trim().split('\n').pop());
}

const linha = (extra) => ({ id: `c_${Math.random()}`, contratante_id: 'testemaster', pedido_id: 'ped_dez_cartao', ...extra });

/* 1. O INCIDENTE: contratante diz "pendente", nosso banco diz "confirmado" */
let r = await resolver({ cobrancas: [linha({ metodo_pagamento: 'cartao_credito', status: 'confirmado', sessao_concluida_em: '2026-09-25T02:39:11Z' })] });
igual(r.liberou, false, 'INCIDENTE: o pedido pago no cartão NÃO abre de novo, mesmo com o contratante dizendo "pendente"');
igual(r.http, 409);
igual(r.codigo, 'pedido_ja_pago');
r = await resolver({ cobrancas: [linha({ metodo_pagamento: 'pix', status: 'confirmado' })] });
igual(r.codigo, 'pedido_ja_pago', 'INCIDENTE ped_isento: Pix pago também bloqueia (qualquer método novo)');

/* 2. Pop-up concluída, dinheiro a caminho */
r = await resolver({ cobrancas: [linha({ metodo_pagamento: 'cartao_credito', status: 'pendente', sessao_concluida_em: '2026-09-25T02:39:11Z' })] });
igual(r.codigo, 'pagamento_em_processamento', 'cartão enviado e ainda não confirmado: não abre um Pix por cima');

/* 3. Controles: o que PODE ser pago de novo continua podendo */
r = await resolver({ cobrancas: [] });
igual(r.liberou, true, 'controle: pedido sem cobrança abre');
r = await resolver({ cobrancas: [linha({ metodo_pagamento: 'pix', status: 'estornado' })] });
igual(r.liberou, true, 'estorno TOTAL: o dinheiro voltou, pagar de novo é legítimo');
r = await resolver({ cobrancas: [linha({ metodo_pagamento: 'cartao_credito', status: 'recusado' })] });
igual(r.liberou, true, 'cartão recusado: tentar de novo é legítimo');
r = await resolver({ cobrancas: [linha({ metodo_pagamento: 'pix', status: 'pendente' })] });
igual(r.liberou, true, 'Pix pendente: segue para o RN-04, que devolve o mesmo Pix');
r = await resolver({ cobrancas: [{ ...linha({ status: 'confirmado' }), pedido_id: 'outro_pedido' }] });
igual(r.liberou, true, 'o pago de OUTRO pedido não bloqueia este');
r = await resolver({ cobrancas: [{ ...linha({ status: 'confirmado' }), contratante_id: 'outro_contratante' }] });
igual(r.liberou, true, 'o mesmo pedidoId de OUTRO contratante não bloqueia este');

/* 4. O contratante continua podendo bloquear sozinho */
r = await resolver({ cobrancas: [], statusNoContratante: 'pago' });
igual(r.liberou, false, 'controle: o contratante dizendo "pago" continua bloqueando');

/* 5. Sem resposta do banco, FECHA */
r = await resolver({ cobrancas: [], bancoFora: true });
igual(r.liberou, false, 'banco fora: não saber se já foi pago não autoriza cobrar');
igual(r.http, 503);

/* 6. Toda porta de cobrança avulsa passa pelo resolverPedido */
const fiacao = {
  'src/controllers/checkoutController.js': /deps\.resolverPedido\(contratanteId, pedidoId, \{ metodoRequerido: metodo \}\)/, // Pix e Boleto
  'src/controllers/asaasCheckoutController.js': /await resolverPedido\(contratanteId, pedidoId, \{ metodoRequerido: 'cartao' \}\)/,
  'src/controllers/pedidoController.js': /await resolver\(contratanteId, pedidoId\)/ // a tela
};
for (const [arquivo, padrao] of Object.entries(fiacao)) {
  ok(padrao.test(readFileSync(join(RAIZ, arquivo), 'utf8')), `${arquivo} passa pelo resolverPedido`);
}

console.log(`pedido-pago-nao-cobra-de-novo: ${checagens} checagens OK`);
