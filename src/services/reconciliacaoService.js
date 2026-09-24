/**
 * SAN CHECKOUT v2 — src/services/reconciliacaoService.js
 *
 * O RECONCILIADOR de órfãos entre a Asaas e o banco (H-06 da auditoria
 * de 24/09/2026).
 *
 * O caso: `reservarCobranca` grava a linha local, `POST /v3/payments`
 * (ou `/v3/checkouts`) é chamado, e a resposta se perde — timeout, 5xx,
 * queda do processo. A cobrança pode existir na Asaas SEM `charge_id`
 * aqui. Até aqui isso virava uma linha em `erros` e um humano com a
 * instrução "confira na Asaas por externalReference". Agora é rotina:
 *
 *  1. toda reserva `pendente` sem `charge_id` e sem `asaas_checkout_id`
 *     há mais de N minutos é examinada;
 *  2. Pix/Boleto: `GET /v3/payments?externalReference=reserva-<id>` —
 *     achou → completa a linha com o `charge_id` real e o status mapeado
 *     (a cobrança EXISTE e pode até estar paga); não achou e a reserva
 *     é velha o bastante → a linha é liberada (nada nasceu do lado de
 *     lá, e mantê-la trava esse pedido para sempre);
 *  3. pop-up (cartão/assinatura): não há `GET /v3/checkouts` documentado
 *     para buscar por referência; quem reconcilia é o próprio webhook
 *     `CHECKOUT_*`, que traz `checkout.externalReference` e encontra a
 *     reserva (`webhookController.processarEventoCheckout`). Aqui, uma
 *     reserva de pop-up sem sessão há mais tempo que a validade da
 *     sessão é liberada — uma sessão que nunca teve `CHECKOUT_PAID` em
 *     70 minutos expirou do lado da Asaas.
 *
 * Roda a cada 5 minutos (`server.js`) e pelo autoteste. Nunca cria nada
 * na Asaas; só lê e completa/limpa o que é nosso.
 */

import { listarReservasTravadas, liberarReservaCobranca, completarCobranca } from './cobrancaService.js';
import { listarPagamentosPorReferenciaExterna } from './asaasService.js';
import { reenfileirarPorReferencia } from './webhookInboxService.js';
import { registrarErro } from './erroService.js';
import { METODOS_DE_ASSINATURA } from './pedidoService.js';

/** Depois de quanto tempo uma reserva sem cobrança é examinada. Acima
 *  do teto de 20 s de toda chamada à Asaas, com folga para a fila. */
export const MINUTOS_ATE_EXAMINAR = 3;
/** Depois de quanto tempo uma reserva SEM nada do lado da Asaas é
 *  liberada. Igual à validade da sessão de pop-up mais folga. */
export const MINUTOS_ATE_LIBERAR = 65;

const STATUS_POR_STATUS_ASAAS = {
  PENDING: 'pendente',
  RECEIVED: 'confirmado',
  CONFIRMED: 'confirmado',
  RECEIVED_IN_CASH: 'confirmado',
  OVERDUE: 'vencido',
  REFUNDED: 'estornado',
  REFUND_REQUESTED: 'estorno_solicitado',
  REFUND_IN_PROGRESS: 'estorno_solicitado',
  CHARGEBACK_REQUESTED: 'chargeback',
  CHARGEBACK_DISPUTE: 'chargeback',
  AWAITING_CHARGEBACK_REVERSAL: 'chargeback',
  AWAITING_RISK_ANALYSIS: 'em_analise'
};

const dependenciasPadrao = {
  listarReservasTravadas,
  liberarReservaCobranca,
  completarCobranca,
  listarPagamentosPorReferenciaExterna,
  reenfileirarPorReferencia,
  registrarErro,
  agora: () => new Date()
};

/** Status local a partir do objeto de pagamento da Asaas — `pendente`
 *  quando desconhecido (o webhook corrige depois; nunca inventa pago). */
export function statusLocalDoPagamento(pagamento) {
  return STATUS_POR_STATUS_ASAAS[pagamento?.status] ?? 'pendente';
}

export function criarReconciliador(deps = dependenciasPadrao) {
  async function reconciliarUmaVez() {
    const relatorio = { examinadas: 0, completadas: 0, liberadas: 0, aguardando: 0, erros: 0 };
    const agora = deps.agora();

    const travadas = await deps.listarReservasTravadas({ minutos: MINUTOS_ATE_EXAMINAR });
    for (const reserva of travadas) {
      relatorio.examinadas += 1;
      const idadeMin = (agora.getTime() - new Date(reserva.criado_em).getTime()) / 60_000;
      const ehPopup = reserva.metodo_pagamento === 'cartao_credito' || METODOS_DE_ASSINATURA.includes(reserva.metodo_pagamento);

      try {
        if (!ehPopup) {
          const encontrados = await deps.listarPagamentosPorReferenciaExterna(`reserva-${reserva.id}`);
          const vivo = encontrados.find((p) => p && !p.deleted) ?? encontrados[0];
          if (vivo?.id) {
            /* A cobrança EXISTE do lado de lá. Completa a linha com o que
               a Asaas sabe; dado do pagador não está aqui (ficou na
               requisição que morreu) e não é inventado. Os eventos dela
               que já chegaram (e foram consumidos sem achar a linha) são
               REENFILEIRADOS na inbox: reprocessados agora, acham a linha
               pelo `charge_id`, aplicam o status e avisam o contratante. */
            await deps.completarCobranca(reserva.id, {
              chargeId: vivo.id,
              documento: null,
              valorCheio: vivo.value ?? null,
              valorComDesconto: vivo.value ?? null,
              taxaAsaas: 0,
              taxaPropria: 0,
              taxaIsenta: true,
              valorCobrado: vivo.value ?? null
            });
            relatorio.completadas += 1;
            const reenfileiradas = await deps.reenfileirarPorReferencia(vivo.id);
            relatorio.reenfileiradas = (relatorio.reenfileiradas ?? 0) + reenfileiradas;
            await deps.registrarErro(
              new Error(`reconciliação: a reserva ${reserva.id} (${reserva.metodo_pagamento}, pedido ${reserva.pedido_id}) EXISTIA na Asaas como ${vivo.id} (${vivo.status}) e foi completada — o pagador/valor da requisição original não foram recuperados.`),
              { contexto: 'reconciliacaoService.completada', rota: 'reconciliador', metodo: 'INTERNO', status: 500 }
            );
            continue;
          }
        }

        if (idadeMin >= MINUTOS_ATE_LIBERAR) {
          await deps.liberarReservaCobranca(reserva.id);
          relatorio.liberadas += 1;
        } else {
          relatorio.aguardando += 1;
        }
      } catch (erro) {
        relatorio.erros += 1;
        await deps.registrarErro(erro, { contexto: 'reconciliacaoService.reserva', rota: 'reconciliador', metodo: 'INTERNO', status: 500 });
      }
    }
    return relatorio;
  }

  return { reconciliarUmaVez };
}

export const { reconciliarUmaVez } = criarReconciliador();

/* ------------------------------------------------------------------
   Autoteste — `node src/services/reconciliacaoService.js`
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('reconciliacaoService.js')) {
  const { strict: assertReal } = await import('node:assert');
  let checagens = 0;
  const assert = new Proxy(assertReal, {
    get(alvo, nome) {
      const valor = alvo[nome];
      if (typeof valor !== 'function') return valor;
      return (...args) => { checagens += 1; return valor.apply(alvo, args); };
    }
  });

  const agora = new Date('2026-09-24T12:00:00Z');
  const ha = (min) => new Date(agora.getTime() - min * 60_000).toISOString();

  function costura({ reservas, naAsaas = {} }) {
    const chamadas = [];
    const deps = {
      listarReservasTravadas: async () => reservas,
      liberarReservaCobranca: async (id) => { chamadas.push(['liberar', id]); },
      completarCobranca: async (id, dados) => { chamadas.push(['completar', id, dados]); },
      listarPagamentosPorReferenciaExterna: async (ref) => { chamadas.push(['buscar', ref]); return naAsaas[ref] ?? []; },
      reenfileirarPorReferencia: async (ref) => { chamadas.push(['reenfileirar', ref]); return 2; },
      registrarErro: async (e) => { chamadas.push(['erro', e.message]); },
      agora: () => agora
    };
    return { chamadas, ...criarReconciliador(deps) };
  }

  // Pix cuja criação deu timeout mas EXISTE na Asaas: completa, nunca libera
  let t = costura({
    reservas: [{ id: 'r1', metodo_pagamento: 'pix', pedido_id: 'p1', criado_em: ha(10) }],
    naAsaas: { 'reserva-r1': [{ id: 'pay_x', status: 'RECEIVED', value: 50 }] }
  });
  let rel = await t.reconciliarUmaVez();
  assert.deepEqual(rel, { examinadas: 1, completadas: 1, liberadas: 0, aguardando: 0, erros: 0, reenfileiradas: 2 });
  assert.deepEqual(t.chamadas[0], ['buscar', 'reserva-r1']);
  assert.equal(t.chamadas[1][0], 'completar');
  assert.equal(t.chamadas[1][2].chargeId, 'pay_x', 'H-06: a linha órfã ganha o charge_id real');
  assert.deepEqual(t.chamadas[2], ['reenfileirar', 'pay_x'], 'os eventos já consumidos desse charge voltam à inbox — é o que aplica o status e avisa o contratante');
  assert.ok(!t.chamadas.some((c) => c[0] === 'liberar'), 'e NUNCA é liberada — existe dinheiro do lado de lá');

  // Pix que NÃO existe na Asaas: aguarda até o prazo, depois libera
  t = costura({ reservas: [{ id: 'r2', metodo_pagamento: 'pix', pedido_id: 'p2', criado_em: ha(10) }] });
  rel = await t.reconciliarUmaVez();
  assert.equal(rel.aguardando, 1, 'jovem e sem nada na Asaas: espera');
  assert.equal(rel.liberadas, 0);
  t = costura({ reservas: [{ id: 'r3', metodo_pagamento: 'boleto', pedido_id: 'p3', criado_em: ha(MINUTOS_ATE_LIBERAR + 1) }] });
  rel = await t.reconciliarUmaVez();
  assert.equal(rel.liberadas, 1, 'velha e sem nada na Asaas: libera');
  assert.deepEqual(t.chamadas.at(-1), ['liberar', 'r3']);

  // pop-up: não consulta a Asaas (sem GET por referência); libera só depois da validade da sessão
  t = costura({ reservas: [{ id: 'r4', metodo_pagamento: 'assinatura', plano_id: 'pl', criado_em: ha(30) }] });
  rel = await t.reconciliarUmaVez();
  assert.ok(!t.chamadas.some((c) => c[0] === 'buscar'), 'pop-up não tem busca por referência');
  assert.equal(rel.aguardando, 1);
  t = costura({ reservas: [{ id: 'r5', metodo_pagamento: 'cartao_credito', pedido_id: 'p5', criado_em: ha(MINUTOS_ATE_LIBERAR + 1) }] });
  rel = await t.reconciliarUmaVez();
  assert.equal(rel.liberadas, 1, 'pop-up velha sem sessão: libera');

  // erro numa reserva não derruba as outras
  t = costura({ reservas: [{ id: 'r6', metodo_pagamento: 'pix', pedido_id: 'p6', criado_em: ha(10) }, { id: 'r7', metodo_pagamento: 'pix', pedido_id: 'p7', criado_em: ha(100) }] });
  t.chamadas.length = 0;
  const original = t.reconciliarUmaVez;
  const depsQuebradas = costura({ reservas: [{ id: 'r6', metodo_pagamento: 'pix', pedido_id: 'p6', criado_em: ha(10) }, { id: 'r7', metodo_pagamento: 'pix', pedido_id: 'p7', criado_em: ha(100) }] });
  void original;
  rel = await criarReconciliador({
    listarReservasTravadas: async () => [{ id: 'r6', metodo_pagamento: 'pix', pedido_id: 'p6', criado_em: ha(10) }, { id: 'r7', metodo_pagamento: 'pix', pedido_id: 'p7', criado_em: ha(100) }],
    liberarReservaCobranca: async (id) => { depsQuebradas.chamadas.push(['liberar', id]); },
    completarCobranca: async () => {},
    listarPagamentosPorReferenciaExterna: async (ref) => { if (ref === 'reserva-r6') throw new Error('asaas fora'); return []; },
    registrarErro: async (e) => { depsQuebradas.chamadas.push(['erro', e.message]); },
    agora: () => agora
  }).reconciliarUmaVez();
  assert.equal(rel.erros, 1);
  assert.equal(rel.liberadas, 1, 'a segunda reserva foi tratada apesar do erro na primeira');

  // mapa de status: nunca inventa pago
  assert.equal(statusLocalDoPagamento({ status: 'CONFIRMED' }), 'confirmado');
  assert.equal(statusLocalDoPagamento({ status: 'OVERDUE' }), 'vencido');
  assert.equal(statusLocalDoPagamento({ status: 'INVENTADO' }), 'pendente');
  assert.equal(statusLocalDoPagamento(null), 'pendente');

  console.log(`reconciliacaoService: ${checagens} checagens OK`);
}
