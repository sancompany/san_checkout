#!/usr/bin/env node
/**
 * tests/uma-assinatura-viva-por-plano.js
 *
 * CLASSE CR-08 da remediação da Estação 6 (SEC-012): ciclo de vida e
 * unicidade da assinatura.
 *
 * O furo: `POST /assinatura` só consultava a assinatura ativa quando
 * vinha um token de renovação válido, e o índice da 0015 só barrava
 * reserva `pendente`. O assinante que abrisse de novo o link do plano e
 * pagasse ficava com DUAS assinaturas cobrando o mesmo cartão — e o
 * `/cancelar-assinatura` cancelava só a mais recente.
 *
 * Roda o handler REAL (`criarCheckoutAssinatura`) num processo filho, com
 * o banco falso, a API do contratante e a Asaas roteirizadas, e a
 * cotação criada pelo serviço de verdade — nada injetado.
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
const igual = (a, b, m) => { assert.deepEqual(a, b, m); checagens += 1; };
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };

const LOJA = { id: 'loja', nome: 'Loja', api_key: 'segredo-da-loja-0123456789', webhook_url: 'https://loja.exemplo/hook', api_base_url: 'https://loja.exemplo/api', metodos_habilitados: null };
const DOCUMENTO = '11144477735';
const assinatura = (extra) => ({ id: 'sub_viva', contratante_id: 'loja', plano_id: 'plano_pro', documento: DOCUMENTO, valor: 50, ciclo: 'MONTHLY', status: 'ativa', mutation_version: 1, criado_em: new Date(Date.now() - 864e5).toISOString(), ...extra });

async function comprar({ assinaturas = [], renovar = false }) {
  const pasta = mkdtempSync(join(tmpdir(), 'assinatura-unica-'));
  const arquivo = join(pasta, 'banco.json');
  writeFileSync(arquivo, JSON.stringify({ tabelas: { contratantes: [LOJA], assinaturas, cobrancas: [], cotacoes: [] } }));
  const codigo = `
    const chamadas = [];
    globalThis.fetch = async (url, opcoes = {}) => {
      const u = new URL(String(url));
      if (u.hostname === 'loja.exemplo') {
        return new Response(JSON.stringify({ nome: 'Pro', valor: 50, ciclo: 'MONTHLY' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      chamadas.push((opcoes.method ?? 'GET') + ' ' + u.pathname);
      if (u.pathname === '/v3/checkouts') return new Response(JSON.stringify({ id: 'chk_novo' }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 500 });
    };
    const { criarCotacao, montarTotaisPlano } = await import('./src/services/cotacaoService.js');
    const { gerarTokenRenovacao } = await import('./src/utils/tokenRenovacao.js');
    const { criarCheckoutAssinatura } = await import('./src/controllers/asaasCheckoutController.js');
    const plano = { nome: 'Pro', valor: 50, ciclo: 'MONTHLY' };
    const cotacao = await criarCotacao({ contratanteId: 'loja', tipo: 'plano', referenciaId: 'plano_pro', origem: plano, totais: montarTotaisPlano(plano) });
    const corpo = {
      nome: 'Maria Teste', email: 'maria@exemplo.com', documento: ${JSON.stringify(DOCUMENTO)}, telefone: '16987654321',
      endereco: 'Rua A', enderecoNumero: '10', bairro: 'Centro', cep: '14000000', cidade: 'Ribeirão Preto', uf: 'SP', cidadeIbge: '3543402',
      cotacaoId: cotacao.id,
      ...(${renovar} ? { renovar: gerarTokenRenovacao(${JSON.stringify(LOJA.api_key)}, { contratanteId: 'loja', planoId: 'plano_pro', documento: ${JSON.stringify(DOCUMENTO)} }) } : {})
    };
    const res = { _status: 200, _json: null, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } };
    await criarCheckoutAssinatura({ params: { contratanteId: 'loja', planoId: 'plano_pro' }, body: corpo, get: () => undefined }, res);
    console.log(JSON.stringify({ status: res._status, json: res._json, chamadas }));
  `;
  const filho = spawn(process.execPath, ['--import', './tests/banco-falso/loader.mjs', '--input-type=module', '-e', codigo], {
    cwd: RAIZ,
    env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:0', SUPABASE_SERVICE_KEY: 'teste', ASAAS_API_KEY: 'chave-de-teste', ASAAS_AMBIENTE: 'sandbox', BANCO_FALSO_ARQUIVO: arquivo }
  });
  let stdout = ''; let stderr = '';
  filho.stdout.on('data', (c) => { stdout += c; });
  filho.stderr.on('data', (c) => { stderr += c; });
  const [status] = await once(filho, 'close');
  if (status !== 0) throw new Error(`processo filho falhou:\n${stderr}`);
  const saida = JSON.parse(stdout.trim().split('\n').pop());
  return { ...saida, banco: JSON.parse(readFileSync(arquivo, 'utf8')).tabelas, stderr };
}

const sessoes = (r) => r.chamadas.filter((c) => c === 'POST /v3/checkouts').length;

/* ── controle positivo: sem assinatura viva, a compra segue ─────────── */
let r = await comprar({});
igual(r.status, 200, `controle: sem assinatura viva, a sessão é aberta (${JSON.stringify(r.json)})`);
igual(sessoes(r), 1, 'controle: uma sessão na Asaas');

/* ── SEC-012: já existe uma VIVA do mesmo plano e documento ─────────── */
for (const status of ['ativa', 'pausada']) {
  r = await comprar({ assinaturas: [assinatura({ status })] });
  igual([r.status, r.json?.codigo], [409, 'assinatura_ja_existe'], `SEC-012: com uma assinatura ${status} do mesmo plano, a segunda é recusada`);
  igual(sessoes(r), 0, `SEC-012 (${status}): e nenhuma sessão nasce na Asaas — nenhum segundo débito recorrente no mesmo cartão`);
  ok(/renovação/.test(r.json?.erro ?? ''), 'e a resposta diz qual é a porta certa (o link de renovação)');
}

/* ── o que NÃO é duplicidade continua passando ───────────────────────── */
r = await comprar({ assinaturas: [assinatura({ status: 'cancelada' })] });
igual([r.status, sessoes(r)], [200, 1], 'a cancelada não conta: o assinante pode voltar');
r = await comprar({ assinaturas: [assinatura({ plano_id: 'outro_plano' })] });
igual([r.status, sessoes(r)], [200, 1], 'outro plano não conta');

/* ── a renovação (token do contratante) é a porta de troca de cartão ─── */
r = await comprar({ assinaturas: [assinatura({ status: 'ativa' })], renovar: true });
igual([r.status, sessoes(r)], [200, 1], 'com o token de renovação, a assinatura nova é aberta');
igual(r.banco.cobrancas.find((c) => c.asaas_checkout_id === 'chk_novo')?.substitui_assinatura_id, 'sub_viva', 'e fica marcada para substituir a antiga quando pagar');

console.log(`uma-assinatura-viva-por-plano: ${checagens} checagens OK`);
