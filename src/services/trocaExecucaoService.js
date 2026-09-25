/**
 * SAN CHECKOUT v2 — src/services/trocaExecucaoService.js
 * A COREOGRAFIA compartilhada da aprovação de troca de plano — o que
 * `trocaPlanoController.js` fazia inteiro numa função só até 18/09/2026
 * agora acontece minutos depois da chamada do contratante, disparado
 * por TRÊS origens diferentes que precisam do mesmo comportamento:
 *
 *   1. `POST /troca/aprovar`, na primeira vez (PENDING_APPROVAL) —
 *      `iniciarCobranca`.
 *   2. o mesmo `POST /troca/aprovar`, numa segunda chamada, quando a
 *      primeira ficou em `PAYMENT_UNKNOWN` — `reclassificarPendente`.
 *   3. o sweeper (`trocaSweeperService.js`, a cada 60s) e o webhook
 *      (`webhookController.js`, quando a Asaas resolve primeiro) —
 *      também `reclassificarPendente`, ou diretamente
 *      `resolverAposClassificacao` quando já se sabe o veredito (o
 *      webhook não precisa de um segundo `GET`).
 *
 * As três convergem em `resolverAposClassificacao`, que é onde a
 * máquina de estados realmente decide — nenhuma das três repete essa
 * lógica por conta própria.
 *
 * Fábrica com injeção de dependência, como `trocaPlanoController.js`:
 * o autoteste exercita a ORDEM sem rede nem banco.
 */

import * as intencaoService from './trocaIntencaoService.js';
import {
  buscarAssinaturaPorId,
  reivindicarTroca,
  liberarTroca,
  aplicarTrocaDePlano
} from './assinaturaService.js';
import { buscarContratante, resolverPlano } from './pedidoService.js';
import {
  dadosDeCobrancaDaAssinatura,
  cobrarNoCartaoSalvo,
  alterarPlanoAssinatura,
  consultarAssinaturaNaAsaas,
  consultarStatus,
  foiRecusaLimpaDaAsaas
} from './asaasService.js';
import { classificarPagamentoDoAcerto } from './classificacaoFinanceiraService.js';
import { registrarAcertoDeTroca } from './cobrancaService.js';
import { notificarPlanoTrocado } from '../controllers/webhookController.js';
import { registrarErro } from './erroService.js';
/** As duas únicas situações em que a assinatura ainda pode trocar de
 *  plano — mesma lista de `trocaPlanoController.js` (fonte única, não
 *  duplicada aqui). */
import { STATUS_QUE_TROCAM } from '../controllers/trocaPlanoController.js';

const emCentavos = (n) => Math.round(Number(n) * 100);

const dependenciasPadrao = {
  buscarIntencao: intencaoService.buscarIntencao,
  reivindicarProcessamento: intencaoService.reivindicarProcessamento,
  expirarSePassouDoPrazo: intencaoService.expirarSePassouDoPrazo,
  marcarStale: intencaoService.marcarStale,
  marcarStaleSePendente: intencaoService.marcarStaleSePendente,
  registrarChargeId: intencaoService.registrarChargeId,
  marcarConfirmada: intencaoService.marcarConfirmada,
  marcarRecusada: intencaoService.marcarRecusada,
  marcarAmbigua: intencaoService.marcarAmbigua,
  reivindicarAplicacao: intencaoService.reivindicarAplicacao,
  marcarConcluida: intencaoService.marcarConcluida,
  marcarReconciliacaoNecessaria: intencaoService.marcarReconciliacaoNecessaria,
  buscarAssinaturaPorId,
  reivindicarTroca,
  liberarTroca,
  aplicarTrocaDePlano,
  buscarContratante,
  resolverPlano,
  dadosDeCobrancaDaAssinatura,
  cobrarNoCartaoSalvo,
  alterarPlanoAssinatura,
  consultarAssinaturaNaAsaas,
  consultarStatus,
  foiRecusaLimpaDaAsaas,
  registrarAcertoDeTroca,
  notificarPlanoTrocado,
  registrarErro
};

export function criarExecutorDeTroca(deps = dependenciasPadrao) {
  /**
   * PAYMENT_CONFIRMED → APPLYING_PLAN → COMPLETED (ou
   * RECONCILIATION_REQUIRED). É o que `trocaPlanoController.js` fazia
   * depois de confirmar o acerto — aqui minutos depois, sem ninguém
   * olhando a resposta HTTP.
   */
  async function aplicarNaAsaasEConcluir(intencao) {
    const reivindicada = await deps.reivindicarAplicacao(intencao.id);
    if (!reivindicada) return; // outra chamada (webhook × sweeper) já está aplicando

    /* O documento do ASSINANTE vem daqui, sempre — nunca de um campo
       pré-anexado por quem chamou. As três origens (aprovação direta,
       webhook, sweeper retomando um crash) convergem no MESMO lugar
       assim, sem cada uma precisar lembrar de buscar isto por conta
       própria (foi exatamente essa a lacuna: a retomada do sweeper não
       tinha o documento anexado, e `cobrancas.documento`/o aviso ao
       contratante ficavam com `null` nesse caminho específico). */
    const assinatura = await deps.buscarAssinaturaPorId(intencao.assinatura_id);
    const documentoAssinante = assinatura?.documento ?? null;

    const registro = await deps.registrarAcertoDeTroca({
      chargeId: intencao.charge_id,
      asaasSubscriptionId: intencao.assinatura_id,
      contratanteId: intencao.contratante_id,
      planoId: intencao.plano_novo_id,
      documento: documentoAssinante,
      valor: Number(intencao.valor_acerto),
      ciclo: intencao.ciclo_novo
    });
    if (!registro?.registrado) {
      await deps.registrarErro(
        new Error(
          `Acerto de troca (intenção ${intencao.id}) cobrado e NÃO registrado em cobrancas: ` +
          `charge ${intencao.charge_id}, assinatura ${intencao.assinatura_id}, valor ${intencao.valor_acerto}`
        ),
        { contexto: 'trocaExecucaoService.acertoNaoRegistrado', rota: '/troca/aprovar', metodo: 'POST' }
      );
    }

    await deps.alterarPlanoAssinatura(intencao.assinatura_id, {
      valor: Number(intencao.valor_novo),
      ciclo: intencao.ciclo_novo
    });

    /* RELÊ para conferir — a Asaas responde 200 e ignora em silêncio
       campo que não conhece (medido em 17/09/2026, mesma razão de
       trocaPlanoController.js antes desta reescrita). */
    const depois = await deps.consultarAssinaturaNaAsaas(intencao.assinatura_id);
    const pegou = Number.isFinite(Number(depois?.valor))
      && emCentavos(depois.valor) === emCentavos(intencao.valor_novo)
      && depois?.ciclo === intencao.ciclo_novo;

    if (!pegou) {
      await deps.registrarErro(
        new Error(
          `PUT da troca (intenção ${intencao.id}) não pegou: esperava valor=${intencao.valor_novo}/ciclo=${intencao.ciclo_novo}, ` +
          `leu valor=${depois?.valor}/ciclo=${depois?.ciclo}`
        ),
        { contexto: 'trocaExecucaoService.reconferencia', rota: '/troca/aprovar', metodo: 'POST' }
      );
      await deps.marcarReconciliacaoNecessaria(intencao.id, 'APPLYING_PLAN');
      return;
    }

    const aplicou = await deps.aplicarTrocaDePlano(intencao.assinatura_id, {
      planoNovoId: intencao.plano_novo_id,
      planoAnteriorId: intencao.plano_id,
      valor: Number(intencao.valor_novo),
      ciclo: intencao.ciclo_novo,
      mutationVersionEsperada: intencao.mutation_version_snapshot
    });

    /* O arrendamento da assinatura sai AQUI, dando certo ou não — ele
       não tem mais nada a proteger depois desta escrita (seja ela qual
       for): sucesso já aconteceu, e um CAS perdido não é resolvido por
       segurar o arrendamento mais tempo. */
    await deps.liberarTroca(intencao.assinatura_id);

    if (!aplicou) {
      await deps.registrarErro(
        new Error(
          `aplicarTrocaDePlano (intenção ${intencao.id}) perdeu o CAS de mutation_version — ` +
          'o acerto foi cobrado e a Asaas foi alterada, mas o nosso banco NÃO foi escrito.'
        ),
        { contexto: 'trocaExecucaoService.casPerdido', rota: '/troca/aprovar', metodo: 'POST' }
      );
      await deps.marcarReconciliacaoNecessaria(intencao.id, 'APPLYING_PLAN');
      return;
    }

    await deps.marcarConcluida(intencao.id);

    /* O aviso tem DONO (SEC-013, 25/09/2026). Era chamado sem `await` nem
       `catch`: `enfileirarNotificacao` lança quando o banco recusa, a
       promessa rejeitada não tinha quem a observasse, e o tratador de
       `unhandledRejection` do `server.js` derrubava o processo — com o
       plano já trocado e o aviso ao contratante nunca gravado. O que
       espera aqui é só a escrita LOCAL na outbox; a rede continua com o
       worker. Falhou: a troca está feita e um humano reenvia o aviso. */
    try {
      const contratante = await deps.buscarContratante(intencao.contratante_id);
      if (contratante) {
        await deps.notificarPlanoTrocado(contratante, {
          planoId: intencao.plano_novo_id,
          planoAnterior: intencao.plano_id,
          documento: documentoAssinante,
          valor: Number(intencao.valor_novo),
          ciclo: intencao.ciclo_novo,
          acertoCobrado: Number(intencao.valor_acerto),
          assinaturaId: intencao.assinatura_id,
          chargeId: intencao.charge_id ?? null,
          intencaoId: intencao.id
        });
      }
    } catch (erroNoAviso) {
      await deps.registrarErro(
        new Error(`troca de plano ${intencao.id} CONCLUÍDA, e o aviso plano_trocado ao contratante NÃO foi enfileirado: ${erroNoAviso.message} — reenviar à mão`),
        { contexto: 'trocaExecucaoService.avisoPerdido', rota: '/troca/aprovar', metodo: 'POST' }
      );
    }
  }

  /**
   * O ponto de convergência das três origens: PAID aplica o plano,
   * DECLINED_FINAL fecha recusada, UNKNOWN fica esperando (o sweeper ou
   * o webhook resolvem depois). Idempotente: chamar de novo sobre uma
   * intenção que já não está em PROCESSING_PAYMENT/PAYMENT_UNKNOWN é
   * no-op nas transições (o CAS de `trocaIntencaoService` garante isso).
   */
  async function resolverAposClassificacao(intencao, veredito) {
    if (veredito === 'PAID') {
      const confirmada = await deps.marcarConfirmada(intencao.id);
      if (confirmada) await aplicarNaAsaasEConcluir(confirmada);
      return { tipo: 'confirmada' };
    }

    if (veredito === 'DECLINED_FINAL') {
      const recusada = await deps.marcarRecusada(intencao.id);
      if (recusada) await deps.liberarTroca(intencao.assinatura_id);
      return { tipo: 'recusada' };
    }

    // UNKNOWN: só transiciona quando ainda não estava lá — de
    // PAYMENT_UNKNOWN para PAYMENT_UNKNOWN o CAS já recusaria (a
    // origem exigida é PROCESSING_PAYMENT), e está certo: não é uma
    // transição de verdade.
    if (intencao.status === 'PROCESSING_PAYMENT') await deps.marcarAmbigua(intencao.id);
    return { tipo: 'ambigua' };
  }

  /**
   * Revalida, na hora da aprovação, o que pode ter mudado durante a
   * janela de até 15 minutos e que `mutation_version` NÃO cobre: o preço
   * do plano de destino (repuxado da API do CONTRATANTE — a mesma fonte
   * que `trocaPlanoController.criarIntencao` usa) e o estado da
   * assinatura NA ASAAS. `mutation_version` só muda quando ALGO grava na
   * NOSSA linha de `assinaturas`; o contratante mudando o preço do plano
   * do lado dele não toca essa coluna — achado no review do PR #36 pelo
   * Codex: sem isto, uma troca aprovada minutos depois de o contratante
   * reprecificar o plano de destino cobraria e aplicaria o valor
   * CONGELADO por cima de um plano que já não custa mais isso.
   *
   * Qualquer divergência (preço, ciclo, assinatura encerrada na Asaas) OU
   * falha em verificar (rede caiu falando com o contratante ou com a
   * Asaas) é tratada do mesmo jeito: não bate. Nunca recálculo
   * silencioso — a mesma regra do `mutation_version` acima, e a mesma
   * postura de "recusar cedo o que ficaria ambíguo depois" do resto
   * deste projeto.
   */
  async function planoEAssinaturaAindaBatem(intencao, contratante) {
    try {
      const { plano: planoNovo } = await deps.resolverPlano(contratante.id, intencao.plano_novo_id, {
        metodoRequerido: 'assinatura',
        contratante
      });
      const precoBate = Number.isFinite(Number(planoNovo?.valor))
        && emCentavos(planoNovo.valor) === emCentavos(intencao.valor_novo)
        && planoNovo?.ciclo === intencao.ciclo_novo;
      if (!precoBate) return false;

      const viva = await deps.consultarAssinaturaNaAsaas(intencao.assinatura_id);
      return Boolean(viva) && !viva.encerrada;
    } catch {
      return false;
    }
  }

  /**
   * PENDING_APPROVAL → (cobrar) → PROCESSING_PAYMENT → veredito.
   * A ÚNICA função que dispara uma cobrança nova — tudo o mais neste
   * arquivo só reage a uma cobrança que já existe.
   */
  async function iniciarCobranca(intencaoId) {
    let intencao = await deps.buscarIntencao(intencaoId);
    if (!intencao) return { tipo: 'nao_encontrada' };

    if (intencao.status === 'PENDING_APPROVAL') {
      const expirada = await deps.expirarSePassouDoPrazo(intencaoId);
      if (expirada) return { tipo: 'expirada' };
    }

    if (intencao.status !== 'PENDING_APPROVAL') {
      return { tipo: 'ja_processando', intencao };
    }

    let reivindicada;
    try {
      reivindicada = await deps.reivindicarProcessamento(intencaoId);
    } catch (erro) {
      /* Outra intenção DESTA assinatura já tem dinheiro em trânsito
         (índice único da 0019, SEC-010): aprovar esta cobraria um segundo
         acerto. Nada foi cobrado; o link fica STALE. */
      if (erro?.code !== 'TROCA_EM_VOO') throw erro;
      await deps.marcarStaleSePendente(intencaoId);
      return { tipo: 'stale' };
    }
    if (!reivindicada) {
      // Perdeu a corrida (duplo clique) OU o prazo venceu bem agora.
      const atual = await deps.buscarIntencao(intencaoId);
      if (atual?.status === 'PENDING_APPROVAL') return { tipo: 'expirada' };
      return { tipo: 'ja_processando', intencao: atual };
    }
    intencao = reivindicada;

    /* REVALIDAÇÃO — nunca recalcula o valor (o retrato congelado É o
       valor aprovado, de propósito), mas confere que a assinatura
       continua no mesmo `mutation_version`: se outra mutação
       (tipicamente OUTRA troca) aconteceu entre a criação da intenção e
       agora, aplicar este retrato por cima seria ignorar dinheiro ou
       estado que já mudou. Vira STALE, nunca recálculo silencioso. */
    const assinatura = await deps.buscarAssinaturaPorId(intencao.assinatura_id);
    const assinaturaValida = assinatura
      && STATUS_QUE_TROCAM.includes(assinatura.status)
      && assinatura.mutation_version === intencao.mutation_version_snapshot;

    if (!assinaturaValida) {
      await deps.marcarStale(intencao.id);
      return { tipo: 'stale' };
    }

    /* Segunda metade da revalidação: o plano de destino (repuxado da API
       do CONTRATANTE) e o estado da assinatura NA ASAAS — nenhum dos
       dois muda `mutation_version` (essa coluna só reage a escrita NA
       NOSSA linha), então a checagem acima sozinha deixava passar um
       contratante reprecificando o plano de destino no meio da janela de
       15 minutos. Busca o contratante aqui e reaproveita abaixo (split). */
    const contratante = await deps.buscarContratante(intencao.contratante_id);
    const aindaBate = contratante && await planoEAssinaturaAindaBatem(intencao, contratante);
    if (!aindaBate) {
      await deps.marcarStale(intencao.id);
      return { tipo: 'stale' };
    }

    const arrendamentoDaAssinatura = await deps.reivindicarTroca(assinatura.id);
    if (!arrendamentoDaAssinatura) {
      // Outra mutação da MESMA assinatura está em andamento agora —
      // mesmo veredito que a revalidação acima: não prosseguir às cegas.
      await deps.marcarStale(intencao.id);
      return { tipo: 'stale' };
    }

    const cobravel = await deps.dadosDeCobrancaDaAssinatura(assinatura.id);
    if (!cobravel?.cartaoToken || !cobravel?.clienteId) {
      await deps.liberarTroca(assinatura.id);
      await deps.marcarStale(intencao.id);
      await deps.registrarErro(
        new Error(`Intenção ${intencao.id}: assinatura ${assinatura.id} não tem mais cartão salvo na hora da aprovação.`),
        { contexto: 'trocaExecucaoService.semCartaoNaAprovacao', rota: '/troca/aprovar', metodo: 'POST' }
      );
      return { tipo: 'stale' };
    }

    /* Assinatura não leva taxa nossa, e o acerto segue a mesma regra da
       versão síncrona: o valor todo é do contratante quando há carteira. */
    const split = contratante?.wallet_id
      ? [{ walletId: contratante.wallet_id, fixedValue: Number(intencao.valor_acerto) }]
      : undefined;

    /* A partir daqui existe risco de AMBIGUIDADE: se `cobrarNoCartaoSalvo`
       lançar (timeout, 5xx da Asaas), não dá para saber se o cartão foi
       cobrado — a resposta se perdeu, não a certeza de que nada
       aconteceu. Três desfechos, e só um deles é "nada foi cobrado":

       - RECUSA LIMPA (4xx com corpo, `foiRecusaLimpaDaAsaas`): a Asaas
         disse não ao pedido. Nada cobrado → STALE, arrendamento devolvido.
       - AMBÍGUO (rede, timeout, 5xx, 429), e o caso de a cobrança ter
         saído e a GRAVAÇÃO do `charge_id` ter falhado: a intenção FICA em
         `PROCESSING_PAYMENT` sem `charge_id`, e o arrendamento da
         assinatura FICA com ela (SEC-010, 25/09/2026). Até aqui ele era
         devolvido e a intenção ia para `RECONCILIATION_REQUIRED`: o
         contratante podia pedir a troca de novo, o assinante aprovar de
         novo, e um segundo acerto saía — o `PAYMENT_CONFIRMED` do
         primeiro era descartado sem `charge_id` conhecido. Agora quem
         resolve é o sweeper, pela referência `troca:<id>` que a cobrança
         leva (SEC-009): achou → vincula e classifica; provou que não
         existe → STALE. Nunca uma segunda cobrança às cegas.
       - COBRADO e gravado: segue para o veredito. */
    let cobranca;
    try {
      cobranca = await deps.cobrarNoCartaoSalvo({
        clienteId: cobravel.clienteId,
        cartaoToken: cobravel.cartaoToken,
        valor: Number(intencao.valor_acerto),
        descricao: `Acerto proporcional da troca de plano (${intencao.dias_restantes} dia(s) restante(s))`,
        referenciaExterna: `troca:${intencao.id}`,
        split
      });
    } catch (erroNaCobranca) {
      if (deps.foiRecusaLimpaDaAsaas(erroNaCobranca)) {
        await deps.liberarTroca(assinatura.id);
        await deps.marcarStale(intencao.id);
        await deps.registrarErro(
          new Error(`a Asaas RECUSOU criar o acerto da intenção ${intencao.id} (assinatura ${assinatura.id}, valor ${intencao.valor_acerto}): ${erroNaCobranca.message} — nada foi cobrado`),
          { contexto: 'trocaExecucaoService.cobrancaRecusada', rota: '/troca/aprovar', metodo: 'POST' }
        );
        return { tipo: 'stale' };
      }
      await deps.registrarErro(
        new Error(
          `cobrarNoCartaoSalvo ficou AMBÍGUO para a intenção ${intencao.id} (assinatura ${assinatura.id}, valor ${intencao.valor_acerto}): ` +
          `${erroNaCobranca.message}. NÃO SE SABE se o cartão foi cobrado. A intenção fica em processamento e o sweeper confere na Asaas ` +
          `pela referência "troca:${intencao.id}" — nenhuma nova cobrança é feita.`
        ),
        { contexto: 'trocaExecucaoService.cobrancaAmbigua', rota: '/troca/aprovar', metodo: 'POST' }
      );
      return { tipo: 'ambigua', intencao };
    }

    /* O charge_id é gravado ANTES de classificar — é o que permite o
       webhook achar esta intenção mesmo enquanto o veredito ainda é
       UNKNOWN (ver `webhookController.js`, "acerto de troca"). */
    if (cobranca.chargeId) {
      let gravou;
      try {
        gravou = await deps.registrarChargeId(intencao.id, cobranca.chargeId);
      } catch (erroAoGravar) {
        await deps.registrarErro(
          new Error(
            `o acerto da intenção ${intencao.id} FOI COBRADO (${cobranca.chargeId}) e o charge_id não foi gravado: ${erroAoGravar.message}. ` +
            `A intenção fica em processamento; o sweeper a acha pela referência "troca:${intencao.id}" ou pelo id ${cobranca.chargeId}.`
          ),
          { contexto: 'trocaExecucaoService.chargeIdNaoGravado', rota: '/troca/aprovar', metodo: 'POST' }
        );
        return { tipo: 'ambigua', intencao };
      }
      if (!gravou) {
        /* A intenção JÁ tinha outro charge_id: este é um SEGUNDO acerto. */
        await deps.registrarErro(
          new Error(`a intenção ${intencao.id} já estava com outro charge_id, e ${cobranca.chargeId} é um SEGUNDO acerto cobrado — estornar um`),
          { contexto: 'trocaExecucaoService.segundoAcerto', rota: '/troca/aprovar', metodo: 'POST' }
        );
        await deps.marcarReconciliacaoNecessaria(intencao.id, 'PROCESSING_PAYMENT');
        return { tipo: 'reconciliacao_necessaria', intencao };
      }
    }

    intencao = { ...intencao, charge_id: cobranca.chargeId ?? null };

    const veredito = classificarPagamentoDoAcerto({ status: cobranca.status });
    const resultado = await resolverAposClassificacao(intencao, veredito);
    return { ...resultado, intencao };
  }

  /**
   * Para uma intenção que já cobrou (charge_id conhecido) e ainda está
   * `PROCESSING_PAYMENT`/`PAYMENT_UNKNOWN`: reconsulta a Asaas e tenta
   * fechar o veredito. Usada pelo sweeper e por uma segunda chamada de
   * `/troca/aprovar` sobre um link que ainda está em processamento.
   */
  async function reclassificarPendente(intencao) {
    if (!intencao?.charge_id) return { tipo: 'sem_cobranca' };

    const status = await deps.consultarStatus(intencao.charge_id);
    const veredito = classificarPagamentoDoAcerto({ status: status?.status });
    return resolverAposClassificacao(intencao, veredito);
  }

  /**
   * Retomada de crash: uma intenção que ficou em `PAYMENT_CONFIRMED` ou
   * `APPLYING_PLAN` sem nunca chegar a `COMPLETED`/`RECONCILIATION_
   * REQUIRED` — o processo morreu no meio (`reivindicarAplicacao`, em
   * `trocaIntencaoService.js`, é quem garante que só uma retomada por
   * vez consegue avançar, com o mesmo espírito do arrendamento de
   * `assinaturas.trocando_em`). Usada só pelo sweeper.
   */
  async function retomarAplicacao(intencao) {
    await aplicarNaAsaasEConcluir(intencao);
  }

  return { iniciarCobranca, reclassificarPendente, resolverAposClassificacao, retomarAplicacao };
}

export const {
  iniciarCobranca, reclassificarPendente, resolverAposClassificacao, retomarAplicacao
} = criarExecutorDeTroca();

/* ------------------------------------------------------------------
   Autoteste — `node src/services/trocaExecucaoService.js`
   Trava a ORDEM da coreografia com dependências falseadas — sem rede,
   sem banco. É a mesma disciplina do autoteste que
   `trocaPlanoController.js` tinha para a versão síncrona: o que importa
   aqui não é a aritmética (isso já tem dono em `proporcionalService.js`),
   é a SEQUÊNCIA e o que cada veredito faz.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('trocaExecucaoService.js')) {
  const { strict: assert } = await import('node:assert');
  let checagens = 0;
  const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

  const INTENCAO_BASE = {
    id: 'int_1',
    assinatura_id: 'sub_1',
    contratante_id: 'mostrai',
    plano_id: 'plano_velho',
    plano_novo_id: 'plano_novo',
    valor_novo: 160,
    ciclo_novo: 'MONTHLY',
    valor_acerto: 30,
    dias_restantes: 15,
    mutation_version_snapshot: 2,
    status: 'PENDING_APPROVAL'
  };

  function costura(ajustes = {}) {
    const chamadas = [];
    const anotar = (nome, args) => chamadas.push({ nome, args });
    // Começa DIFERENTE do valor/ciclo novo (100/QUARTERLY vs. 160/MONTHLY
    // do INTENCAO_BASE) de propósito: só assim "o PUT não pegou" é
    // observável — se o mock começasse já igual ao alvo, a releitura
    // passaria mesmo sem o PUT acontecer.
    const asaas = { valor: 100, ciclo: 'QUARTERLY', proximaCobranca: '2026-10-10' };

    const intencoes = new Map([[INTENCAO_BASE.id, { ...INTENCAO_BASE }]]);

    const deps = {
      buscarIntencao: async (id) => { anotar('buscarIntencao', [id]); return intencoes.get(id) ?? null; },
      reivindicarProcessamento: async (id) => {
        anotar('reivindicarProcessamento', [id]);
        if (ajustes.trocaEmVoo) throw Object.assign(new Error('já existe outra troca'), { code: 'TROCA_EM_VOO' });
        if (ajustes.perdeCorridaNoProcessamento) return null;
        const i = intencoes.get(id);
        if (!i || i.status !== 'PENDING_APPROVAL') return null;
        i.status = 'PROCESSING_PAYMENT';
        return { ...i };
      },
      expirarSePassouDoPrazo: async (id) => {
        anotar('expirarSePassouDoPrazo', [id]);
        if (!ajustes.vencida) return null;
        const i = intencoes.get(id);
        i.status = 'EXPIRED';
        return { ...i };
      },
      marcarStale: async (id) => { anotar('marcarStale', [id]); intencoes.get(id).status = 'STALE'; },
      marcarStaleSePendente: async (id) => {
        anotar('marcarStaleSePendente', [id]);
        const i = intencoes.get(id);
        if (i.status !== 'PENDING_APPROVAL') return null;
        i.status = 'STALE';
        return { ...i };
      },
      registrarChargeId: async (id, chargeId) => {
        anotar('registrarChargeId', [id, chargeId]);
        if (ajustes.registrarChargeIdFalha) throw new Error('Supabase indisponível');
        const i = intencoes.get(id);
        if (ajustes.outroChargeId || (i.charge_id && i.charge_id !== chargeId)) return false;
        i.charge_id = chargeId;
        return true;
      },
      marcarConfirmada: async (id) => {
        anotar('marcarConfirmada', [id]);
        const i = intencoes.get(id);
        if (!['PROCESSING_PAYMENT', 'PAYMENT_UNKNOWN'].includes(i.status)) return null;
        i.status = 'PAYMENT_CONFIRMED';
        return { ...i };
      },
      marcarRecusada: async (id) => {
        anotar('marcarRecusada', [id]);
        const i = intencoes.get(id);
        if (!['PROCESSING_PAYMENT', 'PAYMENT_UNKNOWN'].includes(i.status)) return null;
        i.status = 'PAYMENT_DECLINED';
        return { ...i };
      },
      marcarAmbigua: async (id) => { anotar('marcarAmbigua', [id]); intencoes.get(id).status = 'PAYMENT_UNKNOWN'; },
      reivindicarAplicacao: async (id) => {
        anotar('reivindicarAplicacao', [id]);
        const i = intencoes.get(id);
        // PAYMENT_CONFIRMED é a primeira vez; APPLYING_PLAN é RETOMADA
        // de um processo que morreu no meio. O `_arrendada` aqui é o
        // equivalente de mock para o `aprovando_em` real
        // (`trocaIntencaoService.reivindicarAplicacao`): dentro da
        // janela de arrendamento, uma SEGUNDA reivindicação sobre a
        // MESMA APPLYING_PLAN é recusada — é isso que impede duas
        // chamadas concorrentes de aplicarem o plano duas vezes.
        if (i.status === 'PAYMENT_CONFIRMED') {
          i.status = 'APPLYING_PLAN';
          i._arrendada = true;
          return { ...i };
        }
        if (i.status === 'APPLYING_PLAN' && !i._arrendada) {
          i._arrendada = true;
          return { ...i };
        }
        return null;
      },
      marcarConcluida: async (id) => { anotar('marcarConcluida', [id]); intencoes.get(id).status = 'COMPLETED'; },
      marcarReconciliacaoNecessaria: async (id) => { anotar('marcarReconciliacaoNecessaria', [id]); intencoes.get(id).status = 'RECONCILIATION_REQUIRED'; },
      buscarAssinaturaPorId: async (id) => {
        anotar('buscarAssinaturaPorId', [id]);
        if (ajustes.semAssinatura) return null;
        return {
          id, status: ajustes.statusAssinatura ?? 'ativa',
          mutation_version: ajustes.mutationVersionAtual ?? 2,
          documento: '11144477735'
        };
      },
      reivindicarTroca: async (id) => { anotar('reivindicarTroca', [id]); return !ajustes.arrendamentoOcupado; },
      liberarTroca: async (id) => { anotar('liberarTroca', [id]); },
      aplicarTrocaDePlano: async (id, dados) => { anotar('aplicarTrocaDePlano', [id, dados]); return !ajustes.perdeuCasNaAplicacao; },
      buscarContratante: async (id) => { anotar('buscarContratante', [id]); return { id, webhook_url: 'https://x.test', api_key: 'k' }; },
      resolverPlano: async (contratanteId, planoNovoId) => {
        anotar('resolverPlano', [contratanteId, planoNovoId]);
        if (ajustes.resolverPlanoFalha) throw new Error('fetch failed');
        return {
          plano: {
            nome: 'Plano Novo',
            valor: ajustes.precoDoPlanoMudou ? 999 : INTENCAO_BASE.valor_novo,
            ciclo: ajustes.cicloDoPlanoMudou ? 'YEARLY' : INTENCAO_BASE.ciclo_novo
          }
        };
      },
      dadosDeCobrancaDaAssinatura: async (id) => {
        anotar('dadosDeCobrancaDaAssinatura', [id]);
        return ajustes.semCartao ? { clienteId: null, cartaoToken: null } : { clienteId: 'cus_1', cartaoToken: 'tok_1' };
      },
      cobrarNoCartaoSalvo: async (dados) => {
        anotar('cobrarNoCartaoSalvo', [dados]);
        if (ajustes.cobrancaFalhaDeRede) throw new Error('fetch failed');
        if (ajustes.cobrancaRecusadaLimpa) throw Object.assign(new Error('Cartão recusado pela validação'), { status: 400, corpoAsaas: { errors: [{ code: 'invalid_creditCard' }] } });
        return { chargeId: 'pay_1', status: ajustes.statusDaCobranca ?? 'CONFIRMED', valor: dados.valor };
      },
      alterarPlanoAssinatura: async (id, dados) => { anotar('alterarPlanoAssinatura', [id, dados]); if (!ajustes.putNaoPega) Object.assign(asaas, dados); },
      consultarAssinaturaNaAsaas: async (id) => {
        anotar('consultarAssinaturaNaAsaas', [id]);
        return { ...asaas, encerrada: Boolean(ajustes.assinaturaEncerradaNaAsaas) };
      },
      consultarStatus: async (chargeId) => { anotar('consultarStatus', [chargeId]); return { status: ajustes.statusNaReclassificacao ?? 'CONFIRMED' }; },
      foiRecusaLimpaDaAsaas,
      registrarAcertoDeTroca: async (dados) => { anotar('registrarAcertoDeTroca', [dados]); return { registrado: !ajustes.registroFalha }; },
      notificarPlanoTrocado: async (contratante, dados) => {
        anotar('notificarPlanoTrocado', [contratante, dados]);
        if (ajustes.avisoFalha) throw new Error('outbox recusou o INSERT');
      },
      registrarErro: async (erro, ctx) => { anotar('registrarErro', [erro, ctx]); }
    };

    return {
      chamadas,
      intencoes,
      nomes: () => chamadas.map((c) => c.nome),
      chamou: (nome) => chamadas.some((c) => c.nome === nome),
      ...criarExecutorDeTroca(deps)
    };
  }

  /* --- 1. caminho feliz: PAID confirma, aplica e conclui ------------ */
  let t = costura();
  let r = await t.iniciarCobranca('int_1');
  conferir(r.tipo === 'confirmada', `PAID vira "confirmada", veio ${r.tipo}`);
  conferir(t.intencoes.get('int_1').status === 'COMPLETED', 'e a intenção termina COMPLETED');
  const nomes = t.nomes();
  conferir(
    nomes.indexOf('reivindicarProcessamento') < nomes.indexOf('cobrarNoCartaoSalvo'),
    'a intenção é reivindicada ANTES de cobrar'
  );
  conferir(
    nomes.indexOf('cobrarNoCartaoSalvo') < nomes.indexOf('alterarPlanoAssinatura'),
    'O ACERTO É COBRADO ANTES DE ALTERAR O PLANO — mesma regra da versão síncrona'
  );
  conferir(
    nomes.indexOf('registrarChargeId') < nomes.indexOf('marcarConfirmada'),
    'o charge_id é gravado ANTES de classificar — é o que o webhook usa enquanto ainda é UNKNOWN'
  );
  conferir(
    nomes.indexOf('alterarPlanoAssinatura') < nomes.lastIndexOf('consultarAssinaturaNaAsaas'),
    'a assinatura é RELIDA depois do PUT'
  );
  conferir(
    nomes.lastIndexOf('consultarAssinaturaNaAsaas') < nomes.indexOf('aplicarTrocaDePlano'),
    'o nosso banco só é reescrito depois de a releitura confirmar'
  );
  conferir(t.chamou('notificarPlanoTrocado'), 'o contratante é avisado');
  conferir(t.chamou('liberarTroca'), 'e o arrendamento da assinatura é devolvido');
  conferir(
    t.chamadas.find((c) => c.nome === 'registrarAcertoDeTroca').args[0].documento === '11144477735',
    'o documento do ASSINANTE (não um campo pré-anexado) vai para a cobrança registrada'
  );
  conferir(
    t.chamadas.find((c) => c.nome === 'notificarPlanoTrocado').args[1].documento === '11144477735',
    'e para o aviso ao contratante também — mesma fonte, buscada dentro de aplicarNaAsaasEConcluir'
  );

  /* --- 2. recusa definitiva -------------------------------------------
     A classificação em si (o que conta como DECLINED_FINAL) já tem o
     autoteste dela em `classificacaoFinanceiraService.js` — aqui o que
     se testa é o que a COREOGRAFIA faz com um veredito já fechado. */
  t = costura();
  t.intencoes.set('int_2', { ...INTENCAO_BASE, id: 'int_2', status: 'PROCESSING_PAYMENT', charge_id: 'pay_2' });
  r = await t.resolverAposClassificacao(t.intencoes.get('int_2'), 'DECLINED_FINAL');
  conferir(r.tipo === 'recusada', `DECLINED_FINAL vira "recusada", veio ${r.tipo}`);
  conferir(t.intencoes.get('int_2').status === 'PAYMENT_DECLINED', 'a intenção fecha PAYMENT_DECLINED');
  conferir(t.chamou('liberarTroca'), 'e o arrendamento da assinatura é devolvido — nada mais vai cobrar');
  conferir(!t.chamou('aplicarTrocaDePlano'), 'CARTÃO RECUSADO NÃO ALTERA O PLANO');

  /* --- 3. UNKNOWN fica esperando, não decide nada -------------------- */
  t = costura({ statusDaCobranca: 'PENDING' });
  r = await t.iniciarCobranca('int_1');
  conferir(r.tipo === 'ambigua', `status ambíguo (PENDING) vira "ambigua", nunca recusa, veio ${r.tipo}`);
  conferir(t.intencoes.get('int_1').status === 'PAYMENT_UNKNOWN', 'a intenção fica PAYMENT_UNKNOWN');
  conferir(!t.chamou('liberarTroca'), 'O ARRENDAMENTO DA ASSINATURA NÃO É DEVOLVIDO — o dinheiro pode ainda estar em trânsito');
  conferir(!t.chamou('aplicarTrocaDePlano'), 'e o plano não muda enquanto for ambíguo');

  /* --- 4. reclassificação depois resolve o que ficou UNKNOWN -------- */
  t = costura({ statusNaReclassificacao: 'CONFIRMED' });
  const ambigua = { ...INTENCAO_BASE, status: 'PAYMENT_UNKNOWN', charge_id: 'pay_1' };
  r = await t.reclassificarPendente(ambigua);
  conferir(r.tipo === 'confirmada', 'reconsultar e achar CONFIRMED fecha a intenção que estava travada');
  conferir(t.chamou('consultarStatus'), 'reclassificar usa consultarStatus, não cobra de novo');
  conferir(!t.chamou('cobrarNoCartaoSalvo'), 'NUNCA COBRA DE NOVO — só reconsulta o que já foi cobrado');

  /* --- 5. revalidação: mutation_version mudou vira STALE ------------ */
  t = costura({ mutationVersionAtual: 99 });
  r = await t.iniciarCobranca('int_1');
  conferir(r.tipo === 'stale', `mutation_version divergente vira "stale", veio ${r.tipo}`);
  conferir(!t.chamou('cobrarNoCartaoSalvo'), 'STALE NUNCA COBRA — a revalidação vem antes da cobrança');
  conferir(!t.chamou('reivindicarTroca'), 'nem chega a arrendar a assinatura');

  /* --- 5b. revalidação: o contratante reprecificou o plano de destino
     durante a janela de aprovação — achado no review do PR #36 pelo
     Codex. `mutation_version` (teste 5) não pega isto: essa coluna só
     muda quando ALGO grava na NOSSA assinatura, e reprecificar um plano
     não toca nela. */
  t = costura({ precoDoPlanoMudou: true });
  r = await t.iniciarCobranca('int_1');
  conferir(r.tipo === 'stale', `preço do plano mudou no contratante vira "stale", veio ${r.tipo}`);
  conferir(t.chamou('resolverPlano'), 'a revalidação repuxa o plano da API do contratante');
  conferir(!t.chamou('cobrarNoCartaoSalvo'), 'e NUNCA cobra o valor congelado por cima de um plano que já mudou de preço');
  conferir(!t.chamou('reivindicarTroca'), 'nem chega a arrendar a assinatura — mesmo padrão da revalidação de mutation_version');

  /* --- 5c. o ciclo do plano mudou (mesmo preço, ciclo diferente) ---- */
  t = costura({ cicloDoPlanoMudou: true });
  r = await t.iniciarCobranca('int_1');
  conferir(r.tipo === 'stale', `ciclo do plano mudou também vira "stale", veio ${r.tipo}`);
  conferir(!t.chamou('cobrarNoCartaoSalvo'), 'e não cobra');

  /* --- 5d. a assinatura foi encerrada NA ASAAS entre a criação e a
     aprovação — mutation_version local pode nem ter mudado se o
     encerramento veio de fora do nosso fluxo. */
  t = costura({ assinaturaEncerradaNaAsaas: true });
  r = await t.iniciarCobranca('int_1');
  conferir(r.tipo === 'stale', `assinatura encerrada na Asaas vira "stale", veio ${r.tipo}`);
  conferir(!t.chamou('cobrarNoCartaoSalvo'), 'e não cobra sobre uma assinatura que a Asaas já encerrou');

  /* --- 5e. não deu para revalidar (rede caiu falando com o contratante)
     — o lado seguro é recusar, nunca presumir que continua igual. ---- */
  t = costura({ resolverPlanoFalha: true });
  r = await t.iniciarCobranca('int_1');
  conferir(r.tipo === 'stale', `falha ao revalidar o plano também vira "stale" (fail-closed), veio ${r.tipo}`);
  conferir(!t.chamou('cobrarNoCartaoSalvo'), 'NÃO COBRA quando não deu para confirmar que o plano continua o mesmo');

  /* --- 6. assinatura cancelada entre a criação e a aprovação -------- */
  t = costura({ statusAssinatura: 'cancelada' });
  r = await t.iniciarCobranca('int_1');
  conferir(r.tipo === 'stale', 'assinatura cancelada no meio do caminho também vira STALE, nunca cobra');

  /* --- 7. token expirado nunca reivindica --------------------------- */
  t = costura({ vencida: true });
  r = await t.iniciarCobranca('int_1');
  conferir(r.tipo === 'expirada', `token vencido vira "expirada", veio ${r.tipo}`);
  conferir(!t.chamou('reivindicarProcessamento'), 'expira antes de tentar reivindicar');

  /* --- 8. segunda chamada sobre uma intenção que já processou ------- */
  t = costura();
  t.intencoes.set('int_3', { ...INTENCAO_BASE, id: 'int_3', status: 'COMPLETED' });
  r = await t.iniciarCobranca('int_3');
  conferir(r.tipo === 'ja_processando', 'chamar de novo sobre uma intenção concluída não reprocessa nada');
  conferir(!t.chamou('cobrarNoCartaoSalvo'), 'e não cobra de novo');

  /* --- 9. dois cliques no mesmo link (corrida na reivindicação) ----- */
  t = costura({ perdeCorridaNoProcessamento: true });
  r = await t.iniciarCobranca('int_1');
  conferir(['ja_processando', 'expirada'].includes(r.tipo), `perder a corrida não cobra duas vezes, veio ${r.tipo}`);
  conferir(!t.chamou('cobrarNoCartaoSalvo'), 'A SEGUNDA CHAMADA NÃO COBRA O MESMO ACERTO DE NOVO');

  /* --- 10. sem cartão salvo na hora da aprovação --------------------- */
  t = costura({ semCartao: true });
  r = await t.iniciarCobranca('int_1');
  conferir(r.tipo === 'stale', 'sem cartão salvo, a aprovação recusa em vez de inventar caminho de cobrança');
  conferir(t.chamou('liberarTroca'), 'e devolve o arrendamento que tinha acabado de reivindicar');

  /* --- 10b. a Asaas cai NO MEIO da chamada que cobra — achado no ciclo
     de revisão do PR #36: sem tratamento, a intenção ficava presa em
     PROCESSING_PAYMENT SEM charge_id, e o sweeper pula exatamente essa
     combinação (não tem o que reconsultar) — órfã para sempre. Não dá
     para saber se o cartão foi cobrado, então o único destino seguro é
     RECONCILIATION_REQUIRED, nunca fingir que nada aconteceu. -------- */
  /* Revisto em 25/09/2026 (SEC-009/010): a intenção FICA em
     PROCESSING_PAYMENT, e o arrendamento FICA com ela — o sweeper resolve
     pela referência `troca:<id>` (autoteste do sweeper e
     `tests/acerto-de-troca-nunca-fica-orfao.js`). Devolver o arrendamento
     aqui é o que deixava o contratante pedir a troca de novo e o
     assinante pagar um segundo acerto. */
  t = costura({ cobrancaFalhaDeRede: true });
  r = await t.iniciarCobranca('int_1');
  conferir(r.tipo === 'ambigua', `falha de rede na cobrança é AMBÍGUA, veio ${r.tipo}`);
  conferir(t.intencoes.get('int_1').status === 'PROCESSING_PAYMENT', 'a intenção fica em processamento — quem resolve é o sweeper, pela referência');
  conferir(!t.chamou('liberarTroca'), 'SEC-010: o arrendamento NÃO é devolvido — o cartão pode ter sido cobrado');
  conferir(!t.chamou('marcarReconciliacaoNecessaria'), 'e não vai para RECONCILIATION_REQUIRED, de onde nada automático a tiraria');
  conferir(t.chamadas.find((c) => c.nome === 'registrarErro')?.args[0].message.includes('troca:int_1'), 'o estado ambíguo é registrado, com a referência que acha a cobrança na Asaas');
  conferir(!t.chamou('registrarChargeId'), 'sem chargeId nenhum — a chamada nunca chegou a devolver um');

  /* --- 10b'. recusa LIMPA da Asaas (4xx com corpo): nada foi cobrado —
     aí sim STALE e o arrendamento devolvido. ------------------------ */
  t = costura({ cobrancaRecusadaLimpa: true });
  r = await t.iniciarCobranca('int_1');
  conferir(r.tipo === 'stale', `recusa limpa vira "stale", veio ${r.tipo}`);
  conferir(t.intencoes.get('int_1').status === 'STALE', 'a intenção fecha — o link não cobra mais nada');
  conferir(t.chamou('liberarTroca'), 'e o arrendamento é devolvido: a Asaas disse NÃO, nada está em trânsito');

  /* --- 10c. a cobrança teve SUCESSO, mas GRAVAR o chargeId falhou —
     achado no review do PR #36 pelo Codex: a versão anterior só tinha
     `try/catch` em volta de `cobrarNoCartaoSalvo`, não de
     `registrarChargeId`. Sem cobrir os dois, esta exceção escapava sem
     liberar o arrendamento nem marcar reconciliação — a MESMA órfã do
     teste 10b, só que agora com o cartão comprovadamente cobrado (o
     `chargeId` existe, só não foi possível persisti-lo). --------------- */
  t = costura({ registrarChargeIdFalha: true });
  r = await t.iniciarCobranca('int_1');
  conferir(r.tipo === 'ambigua', `cobrado e não gravado fica AMBÍGUO até o sweeper vincular, veio ${r.tipo}`);
  conferir(t.intencoes.get('int_1').status === 'PROCESSING_PAYMENT', 'a intenção fica em processamento (o sweeper a acha pela referência)');
  conferir(!t.chamou('liberarTroca'), 'SEC-010: e o arrendamento FICA — o cartão foi cobrado');
  conferir(
    t.chamadas.find((c) => c.nome === 'registrarErro').args[0].message.includes('pay_1'),
    'o erro registrado leva o chargeId REAL da Asaas (pay_1), mesmo sem ter conseguido gravá-lo na linha'
  );
  conferir(!t.chamou('marcarConfirmada') && !t.chamou('aplicarTrocaDePlano'), 'e nada é aplicado sobre um vínculo que não foi gravado');

  /* --- 10d. a intenção já tinha OUTRO charge_id: segundo acerto ------ */
  t = costura({ outroChargeId: true });
  r = await t.iniciarCobranca('int_1');
  conferir(r.tipo === 'reconciliacao_necessaria', `segundo acerto na mesma intenção escala, veio ${r.tipo}`);
  conferir(/SEGUNDO acerto/.test(t.chamadas.find((c) => c.nome === 'registrarErro')?.args[0].message ?? ''), 'e é denunciado para estorno');
  conferir(!t.chamou('aplicarTrocaDePlano'), 'e nada é aplicado');

  /* --- 10e. outra troca DESTA assinatura em voo (índice da 0019) ----- */
  t = costura({ trocaEmVoo: true });
  r = await t.iniciarCobranca('int_1');
  conferir(r.tipo === 'stale', `aprovação com outra troca em voo vira "stale", veio ${r.tipo}`);
  conferir(t.intencoes.get('int_1').status === 'STALE', 'o link fecha');
  conferir(!t.chamou('cobrarNoCartaoSalvo'), 'SEC-010: e o segundo acerto NUNCA é cobrado');

  /* --- 11. PUT que a Asaas ignora em silêncio (mesmo furo da versão
     síncrona, agora do lado da aplicação) ----------------------------- */
  t = costura({ putNaoPega: true });
  r = await t.iniciarCobranca('int_1');
  conferir(t.intencoes.get('int_1').status === 'RECONCILIATION_REQUIRED', 'PUT que não pegou vira RECONCILIATION_REQUIRED, nunca COMPLETED silencioso');
  conferir(!t.chamou('notificarPlanoTrocado'), 'e o contratante não é avisado de uma troca que não houve');
  conferir(t.chamou('registrarErro'), 'o estado ruim é registrado — cobrado e não aplicado');

  /* --- 12. CAS de mutation_version perdido bem no fim ---------------- */
  t = costura({ perdeuCasNaAplicacao: true });
  r = await t.iniciarCobranca('int_1');
  conferir(t.intencoes.get('int_1').status === 'RECONCILIATION_REQUIRED', 'CAS perdido na escrita final também escalona, nunca finge sucesso');
  conferir(t.chamou('liberarTroca'), 'e o arrendamento sai mesmo assim — não tem mais nada a proteger');

  /* --- 13. webhook × sweeper chegando à confirmação quase ao mesmo
     tempo não aplicam o plano duas vezes. `resolverAposClassificacao`
     sozinho não bastaria para provar isto (a segunda chamada já bateria
     em `marcarConfirmada`, que é CAS de status — outro ponto de
     exclusão, já coberto pelo teste 2). O que é NOVO e precisa de teste
     próprio é `reivindicarAplicacao`: duas chamadas que ACHAM a MESMA
     intenção já em PAYMENT_CONFIRMED (o cenário real de webhook e
     sweeper correndo quase juntos) só podem aplicar uma vez. */
  t = costura();
  const jaConfirmada = { ...INTENCAO_BASE, status: 'PAYMENT_CONFIRMED', charge_id: 'pay_1' };
  t.intencoes.set('int_1', jaConfirmada);
  await Promise.all([
    t.retomarAplicacao(jaConfirmada),
    t.retomarAplicacao(jaConfirmada)
  ]);
  const vezesQueAplicou = t.nomes().filter((n) => n === 'aplicarTrocaDePlano').length;
  conferir(vezesQueAplicou === 1, `duas chamadas concorrentes sobre a MESMA confirmação aplicam o plano EXATAMENTE uma vez, aplicou ${vezesQueAplicou}`);
  conferir(t.intencoes.get('int_1').status === 'COMPLETED', 'e a intenção termina COMPLETED de qualquer forma');

  /* --- 14. retomada de crash: presa em APPLYING_PLAN é concluída ---- */
  t = costura();
  const presaAplicando = { ...INTENCAO_BASE, status: 'APPLYING_PLAN', charge_id: 'pay_1' };
  t.intencoes.set('int_1', presaAplicando);
  await t.retomarAplicacao(presaAplicando);
  conferir(t.intencoes.get('int_1').status === 'COMPLETED', 'retomar uma intenção presa em APPLYING_PLAN termina COMPLETED');
  conferir(!t.chamou('cobrarNoCartaoSalvo'), 'a retomada NUNCA cobra de novo — só termina o que já estava em andamento');
  conferir(
    t.chamadas.find((c) => c.nome === 'registrarAcertoDeTroca').args[0].documento === '11144477735',
    'MESMO NA RETOMADA de crash (sem nada pré-anexado pelo chamador), o documento do assinante chega certo — ' +
    'era exatamente esta a lacuna antes de aplicarNaAsaasEConcluir buscar a assinatura por conta própria'
  );

  /* --- 15. SEC-013: o aviso ao contratante falha — a troca continua feita,
     a falha vira `erros`, e NADA sobe como promessa rejeitada sem dono. */
  t = costura({ avisoFalha: true });
  r = await t.iniciarCobranca('int_1');
  conferir(r.tipo === 'confirmada' && t.intencoes.get('int_1').status === 'COMPLETED', 'o aviso que falha não desfaz nem esconde a troca feita');
  conferir(/aviso plano_trocado/.test(t.chamadas.find((c) => c.nome === 'registrarErro')?.args[0].message ?? ''), 'e a falha do aviso é registrada para reenvio');

  console.log(`trocaExecucaoService: ${checagens} checagens OK`);
}
