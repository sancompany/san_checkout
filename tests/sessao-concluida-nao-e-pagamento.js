#!/usr/bin/env node
/**
 * tests/sessao-concluida-nao-e-pagamento.js
 *
 * O cenário REAL do primeiro pagamento de assinatura em produção
 * (25/09/2026, 01:26 UTC): a pop-up da Asaas fechou com sucesso,
 * `CHECKOUT_PAID` chegou — e a primeira cobrança ficou `PENDING`, com o
 * cartão sem débito. O sistema gravou `confirmado`, a tela disse
 * "Assinatura Ativa ✓" e a métrica contaria R$ 10,00 que não entraram.
 *
 * A regra que isto trava: **sessão concluída sem confirmação financeira
 * nunca vira "pago" — nem no banco, nem na tela, nem no contratante.**
 *
 *   1. o que a tela pode afirmar (`statusDaSessaoParaTela`): só
 *      `status = confirmado` vira `CHECKOUT_PAID`; sessão concluída
 *      pendente é `PROCESSANDO`; recusa é recusa;
 *   2. uma sessão concluída nunca é reaberta nem substituída por outra
 *      (seria a segunda assinatura no mesmo cartão), e nunca é tratada
 *      como reserva travada, por mais velha que seja;
 *   3. as duas telas de pop-up: `CHECKOUT_PAID` é o ÚNICO status que
 *      dispara o sucesso; `PROCESSANDO` mostra processamento;
 *      `PAGAMENTO_RECUSADO` é falha; e o 409 `pagamento_em_processamento`
 *      acompanha a sessão existente em vez de abrir outra.
 *
 * O receptor do webhook (o `CHECKOUT_PAID` que não muda status, e a
 * sequência real SUBSCRIPTION_CREATED → CHECKOUT_PAID → 1º ciclo
 * recusado/confirmado) está no autoteste de `webhookController.js`,
 * seção 16b, com os payloads reais redigidos.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? 'teste';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const { statusDaSessaoParaTela, abrirSessaoComReserva } = await import('../src/controllers/asaasCheckoutController.js');

let checagens = 0;
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };
const igual = (a, b, m) => { assert.equal(a, b, m); checagens += 1; };

/* 1. O que a tela pode afirmar */
{
  // a linha real do incidente, como ficou depois do reparo
  const incidente = { status: 'pendente', sessao_concluida_em: '2026-09-25T01:26:34Z' };
  igual(statusDaSessaoParaTela(incidente), 'PROCESSANDO', 'INCIDENTE: sessão concluída com o 1º ciclo PENDING é "processando", nunca pago');
  igual(statusDaSessaoParaTela({ status: 'confirmado' }), 'CHECKOUT_PAID', 'só dinheiro confirmado vira sucesso na tela');
  igual(statusDaSessaoParaTela({ status: 'pendente', sessao_concluida_em: null }), 'PENDING', 'pop-up ainda aberta');
  igual(statusDaSessaoParaTela({ status: 'recusado', sessao_concluida_em: '2026-09-25T01:26:34Z' }), 'PAGAMENTO_RECUSADO', 'cartão recusado é falha — sem isto a tela esperava para sempre');
  igual(statusDaSessaoParaTela({ status: 'em_analise' }), 'PROCESSANDO');
  igual(statusDaSessaoParaTela({ status: 'cancelado' }), 'CHECKOUT_CANCELED');
  igual(statusDaSessaoParaTela({ status: 'expirado' }), 'CHECKOUT_EXPIRED');
  for (const status of ['vencido', 'estornado', 'chargeback', 'inventado', undefined]) {
    ok(statusDaSessaoParaTela({ status, sessao_concluida_em: '2026-09-25T01:26:34Z' }) !== 'CHECKOUT_PAID', `"${status}" nunca é afirmado como pago`);
  }
}

/* 2. Sessão concluída nunca é reaberta nem substituída */
{
  let sessoesCriadas = 0;
  const deps = {
    reservarCobrancaPopup: async () => ({ reservada: false, existente: { id: 'bda7f6e9', asaas_checkout_id: '842e6f11', status: 'pendente', sessao_concluida_em: '2026-09-25T01:26:34Z' } }),
    liberarReservaCobranca: async () => { throw new Error('não pode liberar'); },
    registrarErro: async () => {},
    foiRecusaLimpaDaAsaas: () => false
  };
  const r = await abrirSessaoComReserva({
    reserva: { contratanteId: 'testemaster', planoId: 'plano_anual', documento: '52998224725', metodoPagamento: 'assinatura' },
    criarSessao: async () => { sessoesCriadas += 1; return { asaasCheckoutId: 'segunda' }; },
    completar: async () => {},
    contexto: 'assinatura'
  }, deps);
  igual(r.tipo, 'em_processamento', 'o pagador que volta e clica de novo acompanha o pagamento que já fez');
  igual(r.asaasCheckoutId, '842e6f11', 'a sessão acompanhada é a EXISTENTE');
  igual(sessoesCriadas, 0, 'e nenhuma segunda sessão (segunda assinatura no mesmo cartão) é aberta');

  // sessão NÃO concluída continua sendo reaproveitada como antes
  const r2 = await abrirSessaoComReserva({
    reserva: { contratanteId: 'testemaster', planoId: 'plano_anual', documento: '52998224725', metodoPagamento: 'assinatura' },
    criarSessao: async () => { sessoesCriadas += 1; return { asaasCheckoutId: 'x' }; },
    completar: async () => {},
    contexto: 'assinatura'
  }, { ...deps, reservarCobrancaPopup: async () => ({ reservada: false, existente: { asaas_checkout_id: 'aberta', status: 'pendente', sessao_concluida_em: null } }) });
  igual(r2.tipo, 'reaproveitada', 'controle: pop-up ainda aberta é reaproveitada, como sempre foi');

  const servico = readFileSync(join(RAIZ, 'src/services/cobrancaService.js'), 'utf8');
  const trecho = servico.slice(servico.indexOf('export async function reservarCobrancaPopup'), servico.indexOf('export async function completarReservaPopup'));
  ok(/const travada = existente\s*&& !existente\.sessao_concluida_em/.test(trecho), 'reserva com sessão concluída nunca é "travada" — expirá-la soltaria uma segunda assinatura');

  const controlador = readFileSync(join(RAIZ, 'src/controllers/asaasCheckoutController.js'), 'utf8');
  igual((controlador.match(/sessao\.tipo === 'em_processamento'/g) ?? []).length, 2, 'cartão avulso E assinatura respondem o 409 de processamento');
  igual((controlador.match(/codigo: 'pagamento_em_processamento'/g) ?? []).length, 2);
}

/* 3. As duas telas de pop-up */
for (const arquivo of ['public/js/modules/assinaturaCheckoutHandler.js', 'public/js/modules/cartaoHandler.js']) {
  const fonte = readFileSync(join(RAIZ, arquivo), 'utf8');
  const polling = fonte.slice(fonte.indexOf('function iniciarPollingPopup'), fonte.indexOf('function mostrarProcessando'));
  ok(polling.length > 0, `${arquivo}: polling encontrado`);
  const linhasQueConfirmam = polling.split('\n').filter((l) => l.includes('aoConfirmar()'));
  igual(linhasQueConfirmam.length, 1, `${arquivo}: um único ponto dispara o sucesso`);
  ok(/status === 'CHECKOUT_PAID'/.test(linhasQueConfirmam[0]) && !/PROCESSANDO/.test(linhasQueConfirmam[0]), `${arquivo}: e esse ponto é só CHECKOUT_PAID`);
  ok(/status === 'PROCESSANDO'/.test(polling) && /aoProcessar/.test(polling), `${arquivo}: PROCESSANDO mostra processamento`);
  ok(/'PAGAMENTO_RECUSADO'/.test(polling) && /aoFalhar\(status\)/.test(polling), `${arquivo}: recusa é falha`);
  ok(/erro\.corpo\?\.codigo === 'pagamento_em_processamento'/.test(fonte) && /acompanhar\(erro\.corpo\.asaasCheckoutId/.test(fonte), `${arquivo}: o 409 acompanha a sessão existente`);
  const processando = fonte.slice(fonte.indexOf('function mostrarProcessando'), fonte.indexOf('export async function'));
  ok(!/ativarRetorno|btn-success|Aprovado|Ativa/.test(processando), `${arquivo}: o estado "processando" não comemora nem manda de volta à loja`);
}

console.log(`sessao-concluida-nao-e-pagamento: ${checagens} checagens OK`);
