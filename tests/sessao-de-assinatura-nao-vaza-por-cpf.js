#!/usr/bin/env node
/**
 * tests/sessao-de-assinatura-nao-vaza-por-cpf.js
 *
 * NEW-02 da remediação da Estação 6 (achado na busca transversal de
 * 25/09/2026): a sessão de assinatura pendente de uma pessoa saía para
 * qualquer um que soubesse o CPF dela.
 *
 * A reserva da pop-up de assinatura é chaveada por contratante + plano +
 * documento (`reservarCobrancaPopup`) — o que impede duas assinaturas no
 * mesmo cartão (C-04, SEC-012). Mas quem esbarrava na reserva recebia o
 * `checkoutUrl` da sessão que ela tinha: `POST /assinatura/:c/:p` é
 * pública, o plano é público, e o CPF não é segredo. A página da Asaas
 * dessa sessão vem PREENCHIDA com o que a vítima digitou — nome, e-mail,
 * telefone, endereço. Com um CPF, levava-se o resto.
 *
 * A regra agora: a sessão pendente só é reaproveitada para quem mandou o
 * MESMO e-mail e o MESMO telefone de quem a abriu (a linha da reserva já
 * guarda os dois). Diferente, ela é substituída — cancelada na Asaas e
 * aberta de novo com os dados de quem pediu —, e a sessão concluída não
 * devolve o id dela a quem não é o pagador.
 *
 * Handler REAL, banco falso, API do contratante e Asaas roteirizadas.
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
const VITIMA = { nome: 'Maria Teste', email: 'maria@exemplo.com', telefone: '16987654321' };
const ATACANTE = { nome: 'Outra Pessoa', email: 'atacante@exemplo.net', telefone: '11912345678' };

const pasta = mkdtempSync(join(tmpdir(), 'sessao-por-cpf-'));
const arquivo = join(pasta, 'banco.json');
writeFileSync(arquivo, JSON.stringify({ tabelas: { contratantes: [LOJA], assinaturas: [], cobrancas: [], cotacoes: [] } }));

const passos = [
  { quem: 'VITIMA' },
  { quem: 'ATACANTE' },
  { quem: 'VITIMA' },
  { quem: 'VITIMA_DE_NOVO' },
  { concluir: true },
  { quem: 'ATACANTE' },
  { quem: 'VITIMA' }
];

const codigo = `
  const { readFileSync, writeFileSync } = await import('node:fs');
  const pessoas = ${JSON.stringify({ VITIMA, ATACANTE, VITIMA_DE_NOVO: { ...VITIMA, email: ' Maria@Exemplo.com ', telefone: '+55 (16) 98765-4321' } })};
  const chamadas = [];
  let sessoes = 0;
  globalThis.fetch = async (url, opcoes = {}) => {
    const u = new URL(String(url));
    if (u.hostname === 'loja.exemplo') {
      return new Response(JSON.stringify({ nome: 'Pro', valor: 50, ciclo: 'MONTHLY' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const chave = (opcoes.method ?? 'GET') + ' ' + u.pathname;
    chamadas.push(chave);
    if (chave === 'POST /v3/checkouts') { sessoes += 1; return new Response(JSON.stringify({ id: 'chk_' + sessoes }), { status: 200, headers: { 'content-type': 'application/json' } }); }
    if (/^POST \\/v3\\/checkouts\\/chk_\\d+\\/cancel$/.test(chave)) return new Response(JSON.stringify({ status: 'CANCELED' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 500 });
  };
  const { criarCotacao, montarTotaisPlano } = await import('./src/services/cotacaoService.js');
  const { criarCheckoutAssinatura } = await import('./src/controllers/asaasCheckoutController.js');
  const plano = { nome: 'Pro', valor: 50, ciclo: 'MONTHLY' };
  const resultados = [];
  for (const passo of ${JSON.stringify(passos)}) {
    if (passo.concluir) {
      const estado = JSON.parse(readFileSync(process.env.BANCO_FALSO_ARQUIVO, 'utf8'));
      const viva = estado.tabelas.cobrancas.find((c) => c.status === 'pendente' && c.asaas_checkout_id);
      viva.sessao_concluida_em = new Date().toISOString();
      writeFileSync(process.env.BANCO_FALSO_ARQUIVO, JSON.stringify(estado));
      resultados.push({ concluida: viva.asaas_checkout_id });
      continue;
    }
    const p = pessoas[passo.quem];
    const cotacao = await criarCotacao({ contratanteId: 'loja', tipo: 'plano', referenciaId: 'plano_pro', origem: plano, totais: montarTotaisPlano(plano) });
    const corpo = {
      nome: p.nome, email: p.email, documento: ${JSON.stringify(DOCUMENTO)}, telefone: p.telefone,
      endereco: 'Rua A', enderecoNumero: '10', bairro: 'Centro', cep: '14000000', cidade: 'Ribeirão Preto', uf: 'SP', cidadeIbge: '3543402',
      cotacaoId: cotacao.id
    };
    const antes = chamadas.length;
    const res = { _status: 200, _json: null, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } };
    await criarCheckoutAssinatura({ params: { contratanteId: 'loja', planoId: 'plano_pro' }, body: corpo, get: () => undefined }, res);
    resultados.push({ quem: passo.quem, status: res._status, sessao: res._json?.asaasCheckoutId ?? null, url: res._json?.checkoutUrl ?? null, codigo: res._json?.codigo ?? null, reaproveitada: res._json?.reaproveitada ?? false, chamadas: chamadas.slice(antes) });
  }
  console.log(JSON.stringify(resultados));
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
const resultadosDosPassos = JSON.parse(stdout.trim().split('\n').pop());
const [vitima1, atacante1, vitima2, vitimaDeNovo, concluida, atacante2, vitima3] = resultadosDosPassos;

igual([vitima1.status, vitima1.sessao], [200, 'chk_1'], 'controle: a vítima abre a sessão dela');

ok(atacante1.sessao !== 'chk_1' && !String(atacante1.url ?? '').includes('chk_1'), `NEW-02: com o CPF da vítima e OUTRO e-mail/telefone, a sessão da vítima não sai (veio ${atacante1.sessao})`);
igual(atacante1.chamadas, ['POST /v3/checkouts/chk_1/cancel', 'POST /v3/checkouts'], 'a sessão pendente da vítima é cancelada na Asaas e a de quem pediu nasce com os dados dele');
igual([atacante1.status, atacante1.sessao], [200, 'chk_2'], 'quem pediu recebe uma sessão NOVA — com o que ele mesmo digitou');

igual([vitima2.status, vitima2.sessao], [200, 'chk_3'], 'a vítima que volta recebe uma sessão dela de novo (a do outro é substituída)');
igual([vitimaDeNovo.status, vitimaDeNovo.sessao, vitimaDeNovo.reaproveitada], [200, 'chk_3', true], 'controle: o MESMO pagador (e-mail em outra caixa, telefone com +55) reaproveita a sessão dele — o duplo clique não abre outra');
igual(vitimaDeNovo.chamadas, [], 'e nenhuma chamada à Asaas');

ok(Boolean(concluida.concluida), 'a sessão foi concluída pelo pagador');
igual([atacante2.status, atacante2.codigo], [409, 'pagamento_em_processamento'], 'concluída: ninguém abre uma segunda assinatura no mesmo CPF (RN-47/SEC-012 mantidos)');
igual(atacante2.sessao, null, 'NEW-02: e o id da sessão concluída NÃO sai para quem não é o pagador');
igual(atacante2.chamadas, [], 'sem cancelar nada: sessão concluída não se substitui');
igual([vitima3.status, vitima3.codigo, vitima3.sessao], [409, 'pagamento_em_processamento', concluida.concluida], 'controle: o pagador recebe o id para acompanhar a dele');

const banco = JSON.parse(readFileSync(arquivo, 'utf8')).tabelas;
const vivas = banco.cobrancas.filter((c) => c.status === 'pendente');
igual(vivas.length, 1, 'uma reserva viva só, do começo ao fim');

console.log(`sessao-de-assinatura-nao-vaza-por-cpf: ${checagens} checagens OK`);
