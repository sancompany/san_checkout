#!/usr/bin/env node
/**
 * tests/pagamento-de-um-pedido-invalida-as-irmas.js
 *
 * RN-51 e RN-52 (25/09/2026). O PR #47 fechou a porta da frente (pedido
 * pago não abre para cobrança NOVA); esta suíte trava a de trás:
 *
 *   o comprador gera um Pix/boleto, não paga, paga no cartão — e o Pix/
 *   boleto já emitido continuava pagável fora do Checkout, no app do
 *   banco. Um segundo débito pelo mesmo pedido.
 *
 * Roda o CÓDIGO REAL — o receptor do webhook (`processarWebhook`) e o
 * cancelador (`cancelarIrmasUmaVez`), com a máquina de estados, a outbox
 * e o registro de erro de verdade — num processo filho, com o banco
 * falso (`tests/banco-falso/`) e a Asaas substituída por um `fetch` que
 * segue um roteiro e registra cada chamada. Nada de dependência injetada
 * aqui: se a fiação entre os módulos quebrar, esta suíte quebra.
 *
 * As regressões pedidas pelo dono:
 *   A) Pix pendente → cartão confirmado: o Pix deixa de ser pagável;
 *   B) boleto pendente → cartão confirmado: idem, quando a Asaas deixa;
 *   C) cartão pendente → Pix recebido: a sessão da pop-up é encerrada;
 *   D) duas confirmações quase simultâneas: as duas ficam, e a
 *      duplicidade é marcada nas duas;
 *   E) retry do mesmo webhook: nenhuma segunda chamada destrutiva;
 *   F) a Asaas falha ao cancelar: o pedido continua pago e a irmã entra
 *      em reconciliação, com recuo e teto — sem chamar para sempre.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? 'teste';
const { MAX_TENTATIVAS } = await import('../src/services/irmasObsoletasService.js');

let checagens = 0;
const igual = (a, b, m) => { assert.deepEqual(a, b, m); checagens += 1; };
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };

const LOJA = { webhook_url: 'https://loja.exemplo/hook', api_key: 'segredo-da-loja', nome: 'Loja' };
const agoraMenos = (min) => new Date(Date.now() - min * 60_000).toISOString();

/** Uma linha de `cobrancas` do pedido `ped_1` da `loja`. */
const linha = (extra) => ({
  contratante_id: 'loja', pedido_id: 'ped_1', ambiente: 'sandbox', e_teste: false,
  valor_cobrado: 10, cancelamento_tentativas: 0, criado_em: agoraMenos(10),
  contratantes: LOJA, // o banco falso não faz join: a linha já traz o que o `select('*, contratantes(...)')` traria
  ...extra
});

const evento = (tipo, chargeId, extra = {}) => ({ id: `evt_${tipo}_${chargeId}_${Math.random()}`, event: tipo, dateCreated: '2026-09-25 10:00:00', payment: { id: chargeId, ...extra } });

/**
 * Roda os `passos` num processo filho e devolve o banco final e as
 * chamadas feitas à Asaas.
 *   { webhook: corpo }       — processarWebhook(corpo)
 *   { paralelo: [c1, c2] }   — os dois webhooks ao mesmo tempo
 *   { cancelar: true }       — uma passada do cancelador
 *   { cancelarParalelo: n }  — n passadas do cancelador ao mesmo tempo
 *   { juntos: corpo }        — uma passada do cancelador e, no meio dela, este webhook
 *   { vencer: true }         — traz todo `cancelamento_proxima_em` para o passado (o relógio andou)
 *   { esperar: ms }          — deixa o disparo fora do fluxo terminar
 * `asaas`: `{ 'GET /v3/payments/pay_x': [resp, resp…] }` — uma resposta
 * por chamada, a última se repete. resp = { status, corpo, atraso? } | { timeout: true }.
 */
async function rodar({ cobrancas, asaas = {}, passos }) {
  const pasta = mkdtempSync(join(tmpdir(), 'irmas-'));
  const arquivo = join(pasta, 'banco.json');
  writeFileSync(arquivo, JSON.stringify({ tabelas: { contratantes: [{ id: 'loja', ...LOJA }], cobrancas: cobrancas.map((c, i) => ({ id: `row_${i}`, ...c })) } }));

  const codigo = `
    const roteiro = ${JSON.stringify(asaas)};
    const usadas = {};
    const chamadas = [];
    globalThis.fetch = async (url, opcoes = {}) => {
      const u = new URL(String(url));
      if (u.hostname !== 'api-sandbox.asaas.com') {
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }); // o contratante
      }
      const chave = (opcoes.method ?? 'GET') + ' ' + u.pathname;
      chamadas.push(chave);
      const lista = roteiro[chave];
      if (!lista) return new Response(JSON.stringify({ errors: [{ description: 'rota fora do roteiro: ' + chave }] }), { status: 500 });
      const i = Math.min(usadas[chave] ?? 0, lista.length - 1);
      usadas[chave] = (usadas[chave] ?? 0) + 1;
      const r = lista[i];
      if (r.atraso) await new Promise((ok) => setTimeout(ok, r.atraso));
      if (r.timeout) { const e = new Error('abortado'); e.name = 'AbortError'; throw e; }
      return new Response(JSON.stringify(r.corpo ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    };
    const { processarWebhook } = await import('./src/controllers/webhookController.js');
    const { cancelarIrmasUmaVez } = await import('./src/services/irmasObsoletasService.js');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const erros = [];
    for (const passo of ${JSON.stringify(passos)}) {
      try {
        if (passo.webhook) await processarWebhook(passo.webhook);
        if (passo.paralelo) await Promise.all(passo.paralelo.map((c) => processarWebhook(c)));
        if (passo.cancelar) await cancelarIrmasUmaVez();
        if (passo.juntos) await Promise.all([cancelarIrmasUmaVez(), new Promise((ok) => setTimeout(ok, 20)).then(() => processarWebhook(passo.juntos))]);
        if (passo.cancelarParalelo) await Promise.all(Array.from({ length: passo.cancelarParalelo }, () => cancelarIrmasUmaVez()));
        if (passo.esperar) await new Promise((r) => setTimeout(r, passo.esperar));
        if (passo.vencer) {
          const estado = JSON.parse(readFileSync(process.env.BANCO_FALSO_ARQUIVO, 'utf8'));
          for (const l of estado.tabelas.cobrancas) if (l.cancelamento_proxima_em) l.cancelamento_proxima_em = new Date(Date.now() - 1000).toISOString();
          writeFileSync(process.env.BANCO_FALSO_ARQUIVO, JSON.stringify(estado));
        }
      } catch (e) { erros.push(e.message); }
    }
    await new Promise((r) => setTimeout(r, 150)); // o disparo fora do fluxo e a outbox terminam
    console.log(JSON.stringify({ chamadas, erros }));
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
  const banco = JSON.parse(readFileSync(arquivo, 'utf8')).tabelas;
  const porCharge = (id) => banco.cobrancas.find((l) => l.charge_id === id || l.asaas_checkout_id === id);
  return { ...saida, banco, porCharge, stderr };
}

const PENDENTE = { status: 200, corpo: { id: 'x', status: 'PENDING', deleted: false } };
const EXCLUIDA = { status: 200, corpo: { id: 'x', deleted: true } };
const CANCELADA = { status: 200, corpo: { id: 'chk', status: 'CANCELED' } };
const destrutivas = (chamadas) => chamadas.filter((c) => c.startsWith('DELETE') || c.endsWith('/cancel'));
const avisos = (banco, chargeId) => (banco.outbox_notificacoes ?? []).filter((o) => o.payload?.chargeId === chargeId);

/* ── A) Pix pendente → cartão confirmado ─────────────────────────── */
{
  const r = await rodar({
    cobrancas: [
      linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_pix', criado_em: agoraMenos(20) }),
      linha({ metodo_pagamento: 'cartao_credito', status: 'pendente', charge_id: 'pay_cartao', asaas_checkout_id: 'chk_cartao', sessao_concluida_em: agoraMenos(1), criado_em: agoraMenos(5) }),
      // controles: o MESMO pedidoId de outro contratante, e outro pedido da mesma loja
      linha({ contratante_id: 'outra_loja', metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_outra_loja' }),
      linha({ pedido_id: 'ped_2', metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_outro_pedido' })
    ],
    asaas: { 'GET /v3/payments/pay_pix': [PENDENTE], 'DELETE /v3/payments/pay_pix': [EXCLUIDA] },
    passos: [{ webhook: evento('PAYMENT_CONFIRMED', 'pay_cartao') }, { esperar: 100 }]
  });
  igual(r.porCharge('pay_cartao').status, 'confirmado', 'A: o cartão fica pago');
  igual(r.porCharge('pay_pix').status, 'cancelado_por_outro_pagamento', 'A: o Pix deixa de ser pagável — sem ninguém rodar nada além do webhook');
  igual(r.porCharge('pay_pix').obsoleta_por_charge_id, 'pay_cartao', 'A: e diz quem o tornou obsoleto');
  igual(r.chamadas, ['GET /v3/payments/pay_pix', 'DELETE /v3/payments/pay_pix'], 'A: leu a Asaas ANTES de excluir, e só o Pix deste pedido');
  igual(r.porCharge('pay_outra_loja').status, 'pendente', 'A: o mesmo pedidoId de OUTRO contratante não é tocado');
  igual(r.porCharge('pay_outra_loja').obsoleta_desde ?? null, null);
  igual(r.porCharge('pay_outro_pedido').status, 'pendente', 'A: outro pedido da mesma loja não é tocado');
  igual(r.banco.cobrancas.length, 4, 'A: nenhuma linha apagada — o histórico fica');
  const aviso = avisos(r.banco, 'pay_cartao');
  igual(aviso.length, 1, 'A: o contratante é avisado do pagamento');
  igual(aviso[0].payload.pagamentoDuplicado, false);
  igual(avisos(r.banco, 'pay_pix').length, 0, 'A: e NÃO recebe aviso nenhum sobre o Pix cancelado (o pedido está pago)');
  igual(r.erros, []);
}

/* ── B) Boleto pendente → cartão confirmado ──────────────────────── */
{
  const cobrancas = [
    linha({ metodo_pagamento: 'boleto', status: 'pendente', charge_id: 'pay_boleto' }),
    linha({ metodo_pagamento: 'cartao_credito', status: 'pendente', charge_id: 'pay_cartao', asaas_checkout_id: 'chk_cartao', sessao_concluida_em: agoraMenos(1) })
  ];
  let r = await rodar({
    cobrancas,
    asaas: { 'GET /v3/payments/pay_boleto': [PENDENTE], 'DELETE /v3/payments/pay_boleto': [EXCLUIDA] },
    passos: [{ webhook: evento('PAYMENT_CONFIRMED', 'pay_cartao') }, { esperar: 100 }]
  });
  igual(r.porCharge('pay_boleto').status, 'cancelado_por_outro_pagamento', 'B: o boleto é excluído na Asaas');

  // boleto VENCIDO (a Asaas ainda aceita pagar com juros) também sai
  r = await rodar({
    cobrancas: [{ ...cobrancas[0], status: 'vencido' }, cobrancas[1]],
    asaas: { 'GET /v3/payments/pay_boleto': [{ status: 200, corpo: { status: 'OVERDUE', deleted: false } }], 'DELETE /v3/payments/pay_boleto': [EXCLUIDA] },
    passos: [{ webhook: evento('PAYMENT_CONFIRMED', 'pay_cartao') }, { esperar: 100 }]
  });
  igual(r.porCharge('pay_boleto').status, 'cancelado_por_outro_pagamento', 'B: boleto vencido também — ele ainda pode ser pago');

  // a Asaas NÃO deixa excluir: o boleto não vira "cancelado" por palpite
  r = await rodar({
    cobrancas,
    asaas: { 'GET /v3/payments/pay_boleto': [PENDENTE], 'DELETE /v3/payments/pay_boleto': [{ status: 400, corpo: { errors: [{ code: 'invalid_action', description: 'Não é possível remover esta cobrança.' }] } }] },
    passos: [{ webhook: evento('PAYMENT_CONFIRMED', 'pay_cartao') }, { esperar: 100 }]
  });
  const boleto = r.porCharge('pay_boleto');
  igual(boleto.status, 'pendente', 'B: recusa da Asaas não é cancelamento — o status só muda com a Asaas confirmando');
  igual(boleto.cancelamento_tentativas, 1, 'B: a tentativa fica gravada');
  ok(/Não é possível remover/.test(boleto.cancelamento_ultimo_erro), 'B: com o motivo da Asaas');
  ok(new Date(boleto.cancelamento_proxima_em) > new Date(), 'B: e a próxima com recuo, não na hora');
  igual(r.porCharge('pay_cartao').status, 'confirmado', 'B: o pedido continua pago');
}

/* ── C) cartão pendente → Pix recebido ───────────────────────────── */
{
  // a pop-up ainda aberta (sessão não concluída, sem pagamento): a sessão é encerrada
  let r = await rodar({
    cobrancas: [
      linha({ metodo_pagamento: 'cartao_credito', status: 'pendente', asaas_checkout_id: 'chk_aberta', criado_em: agoraMenos(5) }),
      linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_pix' })
    ],
    asaas: { 'POST /v3/checkouts/chk_aberta/cancel': [CANCELADA] },
    passos: [{ webhook: evento('PAYMENT_RECEIVED', 'pay_pix') }, { esperar: 100 }]
  });
  igual(r.porCharge('pay_pix').status, 'confirmado');
  igual(r.porCharge('chk_aberta').status, 'cancelado_por_outro_pagamento', 'C: a sessão da pop-up deixa de ser válida');
  igual(r.chamadas, ['POST /v3/checkouts/chk_aberta/cancel']);

  // pop-up com o cartão RECUSADO (a sessão ainda aceita outro cartão): sessão encerrada, tentativa excluída
  const rr = await rodar({
    cobrancas: [
      linha({ metodo_pagamento: 'cartao_credito', status: 'recusado', asaas_checkout_id: 'chk_recusada', charge_id: 'pay_recusado', criado_em: agoraMenos(5) }),
      linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_pix' })
    ],
    asaas: { 'POST /v3/checkouts/chk_recusada/cancel': [CANCELADA], 'GET /v3/payments/pay_recusado': [PENDENTE], 'DELETE /v3/payments/pay_recusado': [EXCLUIDA] },
    passos: [{ webhook: evento('PAYMENT_RECEIVED', 'pay_pix') }, { esperar: 100 }]
  });
  igual(rr.porCharge('chk_recusada').status, 'cancelado_por_outro_pagamento', 'C: pop-up recusada não aceita mais um segundo cartão');
  igual(rr.chamadas[0], 'POST /v3/checkouts/chk_recusada/cancel', 'C: a SESSÃO primeiro — é por ela que o comprador tentaria de novo');

  // um CHECKOUT_CANCELED atrasado depois disso não troca o motivo nem avisa ninguém
  r = await rodar({
    cobrancas: r.banco.cobrancas.map(({ id, ...resto }) => resto),
    passos: [{ webhook: { id: 'evt_cc', event: 'CHECKOUT_CANCELED', checkout: { id: 'chk_aberta' } } }]
  });
  igual(r.porCharge('chk_aberta').status, 'cancelado_por_outro_pagamento', 'C: CHECKOUT_CANCELED atrasado não sobrescreve');

  // pop-up CONCLUÍDA com o cartão ainda na operadora: o pagamento é excluído pelo id
  r = await rodar({
    cobrancas: [
      linha({ metodo_pagamento: 'cartao_credito', status: 'pendente', asaas_checkout_id: 'chk_c', charge_id: 'pay_cartao', sessao_concluida_em: agoraMenos(2) }),
      linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_pix' })
    ],
    asaas: { 'GET /v3/payments/pay_cartao': [PENDENTE], 'DELETE /v3/payments/pay_cartao': [EXCLUIDA] },
    passos: [{ webhook: evento('PAYMENT_RECEIVED', 'pay_pix') }, { esperar: 100 }]
  });
  igual(r.porCharge('pay_cartao').status, 'cancelado_por_outro_pagamento', 'C: cartão ainda não capturado deixa de ser cobrável');
  igual(destrutivas(r.chamadas), ['DELETE /v3/payments/pay_cartao'], 'C: pelo pagamento, não pela sessão (já concluída)');

  // controle: cartão que a Asaas JÁ capturou (nosso webhook atrasado) — nunca se exclui
  r = await rodar({
    cobrancas: [
      linha({ metodo_pagamento: 'cartao_credito', status: 'pendente', asaas_checkout_id: 'chk_c', charge_id: 'pay_cartao', sessao_concluida_em: agoraMenos(2) }),
      linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_pix' })
    ],
    asaas: { 'GET /v3/payments/pay_cartao': [{ status: 200, corpo: { status: 'CONFIRMED', deleted: false } }] },
    passos: [{ webhook: evento('PAYMENT_RECEIVED', 'pay_pix') }, { esperar: 100 }]
  });
  igual(destrutivas(r.chamadas), [], 'NUNCA se cancela cobrança que a Asaas diz paga');
  igual(r.porCharge('pay_cartao').status, 'pendente', 'e o status local espera o webhook dela (que traz a duplicidade)');

  // pop-up concluída SEM o id do pagamento ainda: espera, não chuta
  r = await rodar({
    cobrancas: [
      linha({ metodo_pagamento: 'cartao_credito', status: 'pendente', asaas_checkout_id: 'chk_c', sessao_concluida_em: agoraMenos(1) }),
      linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_pix' })
    ],
    passos: [{ webhook: evento('PAYMENT_RECEIVED', 'pay_pix') }, { esperar: 100 }]
  });
  igual(r.chamadas, [], 'pop-up concluída sem id de pagamento: nenhuma chamada à Asaas');
  igual(r.porCharge('chk_c').status, 'pendente');
  ok(r.porCharge('chk_c').obsoleta_desde, 'mas fica marcada — quando o id chegar, o cancelador resolve');

  // em análise NÃO liquida: o Pix pendente não é cancelado por causa de um cartão que ainda pode ser recusado
  r = await rodar({
    cobrancas: [
      linha({ metodo_pagamento: 'cartao_credito', status: 'pendente', charge_id: 'pay_cartao', asaas_checkout_id: 'chk_c', sessao_concluida_em: agoraMenos(1) }),
      linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_pix' })
    ],
    passos: [{ webhook: evento('PAYMENT_AWAITING_RISK_ANALYSIS', 'pay_cartao') }, { cancelar: true }]
  });
  igual(r.porCharge('pay_pix').obsoleta_desde ?? null, null, 'cartão em análise não torna o Pix obsoleto');
  igual(r.chamadas, []);
}

/* ── D) duas confirmações quase simultâneas ──────────────────────── */
for (const ordem of ['paralelo', 'pix-antes', 'cartao-antes']) {
  const cobrancas = [
    linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_pix', criado_em: agoraMenos(20) }),
    linha({ metodo_pagamento: 'cartao_credito', status: 'pendente', charge_id: 'pay_cartao', asaas_checkout_id: 'chk_cartao', sessao_concluida_em: agoraMenos(1), criado_em: agoraMenos(5) })
  ];
  const pix = evento('PAYMENT_RECEIVED', 'pay_pix');
  const cartao = evento('PAYMENT_CONFIRMED', 'pay_cartao');
  const passos = ordem === 'paralelo' ? [{ paralelo: [pix, cartao] }] : ordem === 'pix-antes' ? [{ webhook: pix }, { webhook: cartao }] : [{ webhook: cartao }, { webhook: pix }];
  const r = await rodar({
    cobrancas,
    // o PSP já liquidou os dois: qualquer leitura da Asaas diz "pago"
    asaas: { 'GET /v3/payments/pay_pix': [{ status: 200, corpo: { status: 'RECEIVED', deleted: false } }], 'GET /v3/payments/pay_cartao': [{ status: 200, corpo: { status: 'CONFIRMED', deleted: false } }] },
    passos: [...passos, { vencer: true }, { cancelar: true }]
  });
  igual(r.porCharge('pay_pix').status, 'confirmado', `D/${ordem}: o Pix fica — é dinheiro real`);
  igual(r.porCharge('pay_cartao').status, 'confirmado', `D/${ordem}: o cartão fica — é dinheiro real`);
  igual(r.porCharge('pay_pix').pagamento_duplicado_com, ['pay_cartao'], `D/${ordem}: a duplicidade é marcada no Pix`);
  igual(r.porCharge('pay_cartao').pagamento_duplicado_com, ['pay_pix'], `D/${ordem}: e no cartão`);
  igual(destrutivas(r.chamadas), [], `D/${ordem}: nenhuma tentativa de excluir/cancelar um pagamento liquidado`);
  const duplicados = [...avisos(r.banco, 'pay_pix'), ...avisos(r.banco, 'pay_cartao')];
  igual(duplicados.length, 2, `D/${ordem}: o contratante ouve os DOIS pagamentos — nenhum evento perdido`);
  ok(duplicados.some((a) => a.payload.pagamentoDuplicado === true), `D/${ordem}: e pelo menos um aviso diz que é duplicado`);
  const alertas = (r.banco.erros ?? []).filter((e) => /PAGAMENTO DUPLICADO/.test(e.mensagem));
  /* Em sequência, UM aviso (quem detecta é a segunda confirmação). Em
     paralelo os dois processos podem detectar ao mesmo tempo, cada um
     marcando a PRÓPRIA linha — dois avisos, que no banco real caem na
     mesma impressão digital de `erros` (uma linha, `ocorrencias` 2). O
     que não pode é ZERO. */
  if (ordem === 'paralelo') ok(alertas.length >= 1 && alertas.length <= 2, `D/${ordem}: o operador é avisado (${alertas.length})`);
  else igual(alertas.length, 1, `D/${ordem}: o operador é avisado UMA vez para estornar pelo fluxo de estorno`);
  ok(/estorn/i.test(alertas[0].mensagem), `D/${ordem}: e o aviso diz o que fazer`);
  igual(r.erros, []);
}

/* ── E) retry do mesmo webhook ───────────────────────────────────── */
{
  const cobrancas = [
    linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_pix' }),
    linha({ metodo_pagamento: 'cartao_credito', status: 'pendente', charge_id: 'pay_cartao', asaas_checkout_id: 'chk_cartao', sessao_concluida_em: agoraMenos(1) })
  ];
  const cartao = evento('PAYMENT_CONFIRMED', 'pay_cartao');
  let r = await rodar({
    cobrancas,
    asaas: { 'GET /v3/payments/pay_pix': [PENDENTE, EXCLUIDA], 'DELETE /v3/payments/pay_pix': [EXCLUIDA] },
    passos: [{ webhook: cartao }, { webhook: cartao }, { webhook: { ...cartao, event: 'PAYMENT_RECEIVED', id: 'evt_rec' } }, { esperar: 100 }, { cancelar: true }, { vencer: true }, { cancelar: true }]
  });
  igual(destrutivas(r.chamadas), ['DELETE /v3/payments/pay_pix'], 'E: um DELETE só, por mais que o evento se repita e o cancelador passe');
  igual(r.porCharge('pay_pix').status, 'cancelado_por_outro_pagamento');
  igual(avisos(r.banco, 'pay_cartao').length, 1, 'E: e um aviso só ao contratante');

  // a resposta do DELETE se perdeu (timeout) mas a Asaas excluiu: a próxima tentativa LÊ e só grava
  r = await rodar({
    cobrancas,
    asaas: { 'GET /v3/payments/pay_pix': [PENDENTE, EXCLUIDA], 'DELETE /v3/payments/pay_pix': [{ timeout: true }] },
    passos: [{ webhook: cartao }, { esperar: 100 }, { vencer: true }, { cancelar: true }, { vencer: true }, { cancelar: true }]
  });
  igual(destrutivas(r.chamadas), ['DELETE /v3/payments/pay_pix'], 'E: DELETE ambíguo não é repetido — a releitura mostra que já foi');
  igual(r.porCharge('pay_pix').status, 'cancelado_por_outro_pagamento');
  igual(r.porCharge('pay_pix').cancelamento_tentativas, 2);

  // três passadas do cancelador AO MESMO TEMPO sobre a mesma irmã (o
  // disparo do webhook cruzando com a passada de minuto): uma só reivindica
  r = await rodar({
    cobrancas: [cobrancas[0], { ...cobrancas[1], status: 'confirmado', confirmado_em: agoraMenos(1) }],
    asaas: { 'GET /v3/payments/pay_pix': [PENDENTE], 'DELETE /v3/payments/pay_pix': [EXCLUIDA] },
    passos: [{ cancelarParalelo: 3 }]
  });
  igual(destrutivas(r.chamadas), ['DELETE /v3/payments/pay_pix'], 'E: passadas concorrentes — o CAS da reivindicação deixa UMA chamar a Asaas');
  igual(r.porCharge('pay_pix').status, 'cancelado_por_outro_pagamento');
}

/* ── F) a Asaas falha durante o cancelamento ─────────────────────── */
{
  const cobrancas = [
    linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_pix' }),
    linha({ metodo_pagamento: 'cartao_credito', status: 'pendente', charge_id: 'pay_cartao', asaas_checkout_id: 'chk_cartao', sessao_concluida_em: agoraMenos(1) })
  ];
  const passadas = [];
  for (let i = 0; i < MAX_TENTATIVAS + 3; i += 1) passadas.push({ vencer: true }, { cancelar: true });
  const r = await rodar({
    cobrancas,
    asaas: { 'GET /v3/payments/pay_pix': [{ status: 503, corpo: { errors: [{ description: 'Serviço indisponível' }] } }] },
    passos: [{ webhook: evento('PAYMENT_CONFIRMED', 'pay_cartao') }, { esperar: 100 }, ...passadas]
  });
  igual(r.porCharge('pay_cartao').status, 'confirmado', 'F: o pedido continua pago');
  const pix = r.porCharge('pay_pix');
  igual(pix.status, 'pendente', 'F: a irmã não vira "cancelada" sem a Asaas confirmar');
  igual(pix.cancelamento_tentativas, MAX_TENTATIVAS, `F: tenta ${MAX_TENTATIVAS} vezes e PARA — não chama para sempre`);
  igual(r.chamadas.length, MAX_TENTATIVAS, 'F: uma chamada por tentativa, nenhuma a mais depois do teto');
  igual(pix.cancelamento_proxima_em, null, 'F: esgotada, sai da fila');
  ok(/Serviço indisponível/.test(pix.cancelamento_ultimo_erro), 'F: com o último motivo gravado');
  const esgotado = (r.banco.erros ?? []).filter((e) => /ESGOTADO/.test(e.mensagem));
  igual(esgotado.length, 1, 'F: e o operador é avisado, uma vez');
  ok(/pay_pix/.test(esgotado[0].mensagem) && /pay_cartao/.test(esgotado[0].mensagem), 'F: com a irmã e quem pagou');
}

/* ── A irmã é paga ENQUANTO o cancelador espera a Asaas ─────────── */
{
  // o cancelador leu PENDING e mandou o DELETE; antes da resposta, o
  // PAYMENT_RECEIVED do próprio Pix chega. Mesmo que a Asaas responda
  // `deleted: true`, o dinheiro entrou — o status gravado não pode ser
  // "cancelada" (é o CAS no status LIDO que segura isso).
  const r = await rodar({
    cobrancas: [
      linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_pix', obsoleta_desde: agoraMenos(1), obsoleta_por_charge_id: 'pay_cartao', cancelamento_proxima_em: agoraMenos(1) }),
      linha({ metodo_pagamento: 'cartao_credito', status: 'confirmado', charge_id: 'pay_cartao', asaas_checkout_id: 'chk_cartao' })
    ],
    asaas: { 'GET /v3/payments/pay_pix': [PENDENTE], 'DELETE /v3/payments/pay_pix': [{ ...EXCLUIDA, atraso: 150 }] },
    passos: [{ juntos: evento('PAYMENT_RECEIVED', 'pay_pix') }]
  });
  igual(r.porCharge('pay_pix').status, 'confirmado', 'o pagamento que chegou no meio do cancelamento vale — nunca vira "cancelada" por cima');
  igual(r.porCharge('pay_pix').pagamento_duplicado_com, ['pay_cartao'], 'e entra como duplicidade');
}

/* ── A liquidação que NÃO veio pelo webhook também invalida ─────── */
{
  // a consulta de status (ou o reconciliador) gravou o `confirmado`; o
  // webhook não chegou. E, no mesmo banco, 250 boletos vencidos de OUTROS
  // pedidos, nunca pagos — o tipo de linha que se acumula para sempre e
  // que cegava a primeira versão (varria "toda pagável", com teto de 200).
  const velhos = Array.from({ length: 250 }, (_, i) => linha({ pedido_id: `ped_velho_${i}`, metodo_pagamento: 'boleto', status: 'vencido', charge_id: `pay_velho_${i}`, criado_em: agoraMenos(60 * 24 * 30) }));
  const r = await rodar({
    cobrancas: [
      ...velhos,
      linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_pix' }),
      linha({ metodo_pagamento: 'cartao_credito', status: 'confirmado', confirmado_em: agoraMenos(2), charge_id: 'pay_cartao', asaas_checkout_id: 'chk_cartao' })
    ],
    asaas: { 'GET /v3/payments/pay_pix': [PENDENTE], 'DELETE /v3/payments/pay_pix': [EXCLUIDA] },
    passos: [{ cancelar: true }]
  });
  igual(r.porCharge('pay_pix').status, 'cancelado_por_outro_pagamento', 'a passada periódica marca pelo ESTADO e cancela — mesmo com 250 pagáveis alheias no banco');
  igual(r.chamadas, ['GET /v3/payments/pay_pix', 'DELETE /v3/payments/pay_pix'], 'e só a irmã do pedido pago é tocada');
  igual(r.banco.cobrancas.filter((l) => l.obsoleta_desde).length, 1, 'nenhum boleto alheio marcado');
}

/* ── Estorno TOTAL devolve o pedido: nada a invalidar ────────────── */
{
  const r = await rodar({
    cobrancas: [
      linha({ metodo_pagamento: 'pix', status: 'pendente', charge_id: 'pay_pix' }),
      linha({ metodo_pagamento: 'cartao_credito', status: 'estornado', charge_id: 'pay_cartao' })
    ],
    passos: [{ cancelar: true }]
  });
  igual(r.porCharge('pay_pix').obsoleta_desde ?? null, null, 'pedido estornado por inteiro pode ser pago de novo — o Pix fica');
  igual(r.chamadas, []);
}

/* ── A cobrança do pedido, para quem consulta, é a que PAGOU ────── */
{
  const fonte = readFileSync(join(RAIZ, 'src/services/cobrancaService.js'), 'utf8');
  const trecho = fonte.slice(fonte.indexOf('export async function buscarCobrancaPorPedido'), fonte.indexOf('export async function atualizarStatusCobranca'));
  ok(/\.neq\('status', 'cancelado_por_outro_pagamento'\)/.test(trecho), 'status/consulta/estorno por pedido nunca escolhem a irmã cancelada');
  const servidor = readFileSync(join(RAIZ, 'src/server.js'), 'utf8');
  ok(/setInterval\(rodarCanceladorDeIrmas, UM_MINUTO_MS\)/.test(servidor), 'o cancelador roda sozinho, de minuto em minuto');
}

console.log(`pagamento-de-um-pedido-invalida-as-irmas: ${checagens} checagens OK`);
