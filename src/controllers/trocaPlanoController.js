/**
 * SAN CHECKOUT v2 — src/controllers/trocaPlanoController.js
 * `POST /api/checkout/trocar-plano`
 * Header: `X-Checkout-Key` (a MESMA chave do contratante que
 *   cancelar/pausar/retomar já usam)
 * Body: `{ planoId, planoNovoId, documento }`
 *
 * Leva o assinante do plano A para o plano B mantendo o vínculo: cobra o
 * acerto proporcional no cartão que já está salvo, altera a assinatura
 * na Asaas e reescreve o nosso registro. Sem cancelar, sem o assinante
 * digitar cartão de novo, sem janela em que ele fica sem assinatura.
 *
 * ── Quem decide o quê ───────────────────────────────────────────────
 * Autorizada pelo dono em 17/09/2026, com as sete regras do acerto
 * respondidas por ele (elas moram em `services/proporcionalService.js`,
 * que é quem faz a conta). O que esta rota acrescenta é a COREOGRAFIA —
 * a ordem em que as coisas acontecem, que é onde o dinheiro se perde.
 *
 * ── A ordem, e por que é esta ───────────────────────────────────────
 * 1. autentica, valida, e **puxa o plano de destino do contratante**:
 *    `valor` e `ciclo` nunca vêm do corpo da requisição (é a regra do
 *    `tests/valor-vem-do-servidor.js` — quem paga não escolhe quanto);
 * 2. **recusa antes de cobrar** o que a Asaas recusaria depois (piso de
 *    R$ 5,00, ciclo fora da lista) e o que não dá para calcular com
 *    honestidade (cobrança do período não paga, dado incoerente);
 * 3. **reivindica o arrendamento** (`assinaturas.trocando_em`): duas
 *    chamadas simultâneas não cobram o mesmo acerto duas vezes;
 * 4. **cobra o acerto primeiro.** Se o cartão recusar, o plano NÃO
 *    muda — é o fail-closed. A ordem inversa daria o plano caro de
 *    graça a quem tem cartão sem limite;
 * 5. altera na Asaas e **relê para conferir**: ela responde `200` e
 *    ignora em silêncio campo que não conhece (medido em 17/09), então
 *    status de resposta não prova nada;
 * 6. escreve no nosso banco **na mesma operação**, porque a Asaas não
 *    manda evento nenhum de assinatura (`CONSTRAINTS.md` §2.2, medido:
 *    zero `SUBSCRIPTION_*` entre os 53 configurados). O que não for
 *    gravado aqui não chega nunca;
 * 7. avisa o contratante (`evento: 'plano_trocado'`). **Avisar o
 *    ASSINANTE é obrigação dele** — por e-mail e por aviso no site —,
 *    decisão do dono e RN-35: o checkout não fala com o pagador.
 *
 * ── O que esta rota NÃO faz ─────────────────────────────────────────
 * - **não devolve dinheiro.** Rebaixamento não gera crédito nem estorno:
 *   o preço novo passa a valer no vencimento que já existia (regra 6 do
 *   dono). Aqui isso aparece como `acerto.cobrado: false`;
 * - **não move a data.** `nextDueDate` fica onde está (medido), e o
 *   desenho vive disso: o acerto cobre os dias que faltam, e o plano
 *   novo inteiro entra na data que o assinante já tinha;
 * - **não troca plano de assinatura sem cartão salvo** (Pix Automático)
 *   quando há acerto a cobrar — sem cartão não há como cobrar sem
 *   interação, e inventar um caminho aqui seria pior que recusar;
 * - **não reconfirma CVV**, e isso é desvio registrado de uma regra da
 *   skill `seguranca-san` ("cartão salvo pede reconfirmação de CVV
 *   antes de pagar"). Cumpri-la exigiria receber CVV, o que colocaria o
 *   projeto no escopo PCI que a pop-up hospedada existe para evitar — e
 *   `POST /v3/payments` com `creditCardToken` não tem nem campo de CVV.
 *   A exceção está em `CONSTRAINTS.md` §3, com as cinco compensações
 *   que a tornam aceitável (a principal: quem dispara é o contratante
 *   com a chave dele, e nem ele escolhe o valor).
 */

import {
  buscarContratantePorChave,
  resolverPlano
} from '../services/pedidoService.js';
import {
  buscarAssinaturaAtiva,
  reivindicarTroca,
  liberarTroca,
  aplicarTrocaDePlano
} from '../services/assinaturaService.js';
import {
  buscarCobrancaPorSubscriptionId,
  registrarAcertoDeTroca
} from '../services/cobrancaService.js';
import {
  consultarAssinaturaNaAsaas,
  dadosDeCobrancaDaAssinatura,
  cobrarNoCartaoSalvo,
  alterarPlanoAssinatura,
  STATUS_ACERTO_PAGO
} from '../services/asaasService.js';
import { calcularAcertoDeTroca, DIAS_DO_CICLO } from '../services/proporcionalService.js';
import { notificarPlanoTrocado } from './webhookController.js';
/* Os sete ciclos moram lá porque é lá que a assinatura NASCE, e o front
   espelha a mesma lista apontando para aquele arquivo. Importar em vez
   de repetir: uma segunda lista de ciclos é uma lista que envelhece. */
import { CICLOS_VALIDOS } from './asaasCheckoutController.js';
import {
  documentoValido,
  normalizarDocumento,
  valorValido,
  valorCobradoAceitavel,
  MENSAGEM_PISO_ASAAS
} from '../utils/validadores.js';
import { responderErro } from '../utils/erros.js';
import { registrarErro } from '../services/erroService.js';
import { hojeCivil } from '../utils/diaCivil.js';

/** Só uma assinatura que está cobrando (ou pausada, que volta a cobrar)
 *  pode trocar de plano. `cancelada` não: não há o que alterar na Asaas,
 *  e o caminho para voltar é assinar de novo.
 *
 *  Pausada ENTRA porque a Asaas aceita mudança de valor em assinatura
 *  pausada — medido em 17/09/2026. Recusar aqui seria inventar um limite
 *  que o provedor não tem. */
const STATUS_QUE_TROCAM = ['ativa', 'pausada'];

/** O status da nossa cobrança que significa "o período em curso foi
 *  pago". É dele que sai o crédito do acerto (regra 4 do dono: o crédito
 *  vem do valor PAGO, nunca de saldo guardado). */
const STATUS_PERIODO_PAGO = 'confirmado';

/**
 * Valor em CENTAVOS, que é a unidade que a Asaas guarda.
 *
 * A reconferência do `PUT` compara assim, e não em reais, porque a
 * igualdade em ponto flutuante criaria um falso negativo caro: um plano
 * de R$ 45,999 passa por `valorValido`, a Asaas guarda 46,00, e a
 * comparação exata falharia — `502` e registro não gravado DEPOIS de o
 * acerto já ter sido cobrado. Mesma unidade, e mesmo motivo, de
 * `valorCobradoAceitavel`.
 */
const emCentavos = (n) => Math.round(Number(n) * 100);


const dependenciasPadrao = {
  buscarContratantePorChave,
  resolverPlano,
  buscarAssinaturaAtiva,
  reivindicarTroca,
  liberarTroca,
  aplicarTrocaDePlano,
  buscarCobrancaPorSubscriptionId,
  registrarAcertoDeTroca,
  consultarAssinaturaNaAsaas,
  dadosDeCobrancaDaAssinatura,
  cobrarNoCartaoSalvo,
  alterarPlanoAssinatura,
  notificarPlanoTrocado,
  registrarErro,
  /* Dia civil de BRASÍLIA, não de UTC. O processo roda em UTC (medido
     no contêiner), e entre 21h e meia-noite de Brasília o dia de UTC já
     é o seguinte: o acerto sairia com um dia restante a menos — em
     mensal, 3% do valor, todo dia, nas três últimas horas. A data de
     vencimento com que ele é comparado é brasileira. */
  hoje: hojeCivil
};

/**
 * A fábrica existe para o autoteste poder exercitar a COREOGRAFIA sem
 * rede e sem banco — e é a coreografia que importa aqui: a ordem entre
 * cobrar e alterar é a regra de negócio inteira.
 */
export function criarTrocarPlano(deps = dependenciasPadrao) {
  return async function trocarPlano(requisicao, resposta) {
    const chave = requisicao.get('X-Checkout-Key');
    let { planoId, planoNovoId, documento } = requisicao.body ?? {};

    if (!chave) return resposta.status(401).json({ erro: 'X-Checkout-Key ausente.' });
    if (!planoId || !planoNovoId || !documento) {
      return resposta.status(400).json({ erro: 'planoId, planoNovoId e documento são obrigatórios.' });
    }
    if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });

    // Dígitos, e daqui para baixo é só esta forma (RN-32) — a explicação
    // inteira está em `normalizarDocumento`, em `utils/validadores.js`.
    documento = normalizarDocumento(documento);

    if (planoId === planoNovoId) {
      return resposta.status(400).json({ erro: 'planoNovoId é o mesmo plano da assinatura — não há troca a fazer.' });
    }

    let assinatura = null;
    /* Só quem TOMOU o arrendamento pode devolvê-lo. Sem esta marca, um
       erro antes da reivindicação (o plano de destino não responde, por
       exemplo) devolveria no `catch` um arrendamento que pertence a
       OUTRA chamada em andamento — e aí as duas cobrariam o acerto. */
    let arrendamentoMeu = false;
    /* Fora do `try` porque o `catch` precisa dele: o arrendamento só é
       DEVOLVIDO enquanto nada foi cobrado. Depois da cobrança ele é a
       única coisa que impede uma retentativa de debitar o acerto duas
       vezes — se o `GET` de reconferência estourar (timeout da Asaas,
       5xx) com o cartão já debitado, devolver o arrendamento faria a
       chamada seguinte cobrar de novo. Aqui o prazo expira sozinho em
       minutos, e até lá a segunda tentativa recebe 409. */
    let chargeIdDoAcerto = null;

    try {
      const contratante = await deps.buscarContratantePorChave(chave);
      if (!contratante) return resposta.status(401).json({ erro: 'Chave inválida.' });

      assinatura = await deps.buscarAssinaturaAtiva(
        contratante.id, planoId, documento, STATUS_QUE_TROCAM
      );
      if (!assinatura) {
        return resposta.status(404).json({ erro: 'Nenhuma assinatura ativa ou pausada encontrada pra esse plano/documento.' });
      }

      /* O plano de DESTINO vem da API do contratante, como na criação da
         assinatura — nunca do corpo desta requisição. É a mesma regra do
         valor de um pedido: quem paga não escolhe quanto paga, e quem
         troca de plano não escolhe o preço do plano novo. */
      const { plano: planoNovo } = await deps.resolverPlano(contratante.id, planoNovoId, {
        metodoRequerido: 'assinatura',
        contratante
      });

      const valorNovo = Number(planoNovo?.valor ?? 0);
      if (!valorValido(valorNovo)) {
        return resposta.status(400).json({ erro: 'Valor do plano de destino inválido.' });
      }
      /* Piso da Asaas conferido AQUI, antes de qualquer cobrança: ela
         recusaria o `PUT` com `400 invalid_value`, e esse erro chegaria
         ao contratante sem contexto — e depois de o acerto já ter sido
         cobrado. */
      if (!valorCobradoAceitavel(valorNovo)) {
        return resposta.status(400).json({ erro: MENSAGEM_PISO_ASAAS });
      }

      const cicloNovo = planoNovo?.ciclo ?? 'MONTHLY';
      if (!CICLOS_VALIDOS.includes(cicloNovo)) {
        return resposta.status(400).json({
          erro: `Ciclo de assinatura inválido: "${cicloNovo}". Valores aceitos: ${CICLOS_VALIDOS.join(', ')}.`
        });
      }

      /* Estado VIVO na Asaas, não o nosso: é dela a data de vencimento
         que o acerto proporcionaliza, e é dela o ciclo (se divergir do
         nosso, o errado é o nosso — RN-26.1). */
      const viva = await deps.consultarAssinaturaNaAsaas(assinatura.id);
      if (!viva) {
        return resposta.status(404).json({ erro: 'Assinatura não encontrada na Asaas.' });
      }
      if (viva.encerrada) {
        return resposta.status(409).json({ erro: 'Assinatura encerrada na Asaas — não há plano a trocar.' });
      }

      const cicloAtual = viva.ciclo ?? assinatura.ciclo;
      const vencimentoAtual = viva.proximaCobranca;

      /* Regra 3 do dono: não existe crédito de período que não foi pago.
         Sem cobrança confirmada, a troca é recusada em vez de creditar
         um valor que ninguém pagou.

         A busca é pelo id da ASSINATURA, e não por `planoId`, e a
         diferença aparece na SEGUNDA troca dentro do mesmo período: o
         ciclo pago está gravado sob o plano ANTIGO, então procurar pelo
         plano atual não acharia nada e a rota responderia "cobrança não
         confirmada" — falso, e no caminho do dinheiro. A assinatura é o
         que não muda quando o plano muda.

         Status diferente de `confirmado` recusa, inclusive quando existe
         um ciclo confirmado mais antigo: um ciclo recusado ou vencido
         como linha mais recente significa que o período em curso não foi
         pago, e adivinhar o contrário daria crédito por dinheiro que não
         entrou. Recusar é o lado seguro do erro. */
      const ultima = await deps.buscarCobrancaPorSubscriptionId(assinatura.id);
      if (!ultima || ultima.status !== STATUS_PERIODO_PAGO) {
        return resposta.status(409).json({
          erro: 'A cobrança do período em curso não está confirmada. Resolva o pagamento pendente antes de trocar de plano.'
        });
      }

      const acerto = calcularAcertoDeTroca({
        valorPagoDoPeriodo: Number(ultima.valor_cobrado),
        cicloAtual,
        valorDoPlanoNovo: valorNovo,
        cicloNovo,
        vencimentoAtual,
        hoje: deps.hoje()
      });

      /* "Não é devido" e "não sei calcular" não podem se confundir aqui:
         o primeiro segue sem cobrar, o segundo RECUSA. Dar a troca de
         graça sobre dado que ninguém conferiu é o erro caro. */
      if (acerto.dadoIncoerente) {
        return resposta.status(409).json({
          erro: 'Não foi possível calcular o acerto proporcional desta troca.',
          motivo: acerto.motivo
        });
      }

      /* A partir daqui existe efeito. O arrendamento é o que impede duas
         chamadas simultâneas de cobrarem o mesmo acerto duas vezes. */
      arrendamentoMeu = await deps.reivindicarTroca(assinatura.id);
      if (!arrendamentoMeu) {
        return resposta.status(409).json({ erro: 'Já existe uma troca de plano em andamento para esta assinatura.' });
      }

      /* `cobra: false` com acerto negativo (rebaixamento) ou absorvido
         significa cobrança ZERO, não o número calculado — ele iria para
         a resposta e para o aviso ao contratante como se tivesse sido
         debitado. */
      const acertoCobradoEmReais = acerto.cobra ? acerto.acerto : 0;

      if (acerto.cobra) {
        const cobravel = await deps.dadosDeCobrancaDaAssinatura(assinatura.id);
        if (!cobravel?.cartaoToken || !cobravel?.clienteId) {
          await deps.liberarTroca(assinatura.id);
          return resposta.status(409).json({
            erro: 'Esta assinatura não tem cartão salvo para cobrar o acerto proporcional da troca.'
          });
        }

        /* Assinatura não leva taxa nossa, e o acerto segue a mesma
           regra: o valor todo é do contratante quando há carteira. */
        const split = contratante.wallet_id
          ? [{ walletId: contratante.wallet_id, fixedValue: acerto.acerto }]
          : undefined;

        const cobranca = await deps.cobrarNoCartaoSalvo({
          clienteId: cobravel.clienteId,
          cartaoToken: cobravel.cartaoToken,
          valor: acerto.acerto,
          descricao: `Acerto proporcional da troca de plano (${acerto.diasRestantes} dia(s) restante(s))`,
          referenciaExterna: `troca:${assinatura.id}:${planoNovoId}`,
          split
        });

        /* O fail-closed: sem dinheiro dentro, o plano não muda. */
        if (!STATUS_ACERTO_PAGO.includes(cobranca.status)) {
          await deps.liberarTroca(assinatura.id);
          return resposta.status(402).json({
            erro: 'O acerto proporcional não foi aprovado no cartão salvo. O plano NÃO foi alterado.',
            acerto: { cobrado: false, valor: acerto.acerto, status: cobranca.status ?? null }
          });
        }

        chargeIdDoAcerto = cobranca.chargeId;

        const registro = await deps.registrarAcertoDeTroca({
          chargeId: cobranca.chargeId,
          asaasSubscriptionId: assinatura.id,
          contratanteId: contratante.id,
          planoId: planoNovoId,
          documento,
          valor: acerto.acerto,
          ciclo: cicloNovo
        });

        /* Dinheiro cobrado e não registrado é o pior dos dois estados, e
           por isso não pode passar calado: a métrica não conta, o painel
           não mostra, e ninguém sabe que existe. A troca SEGUE — o
           cartão já foi debitado, e recusar agora deixaria o assinante
           pagando sem receber —, mas o furo vira linha na tabela `erros`
           (Lei 8) com o `chargeId`, que é o que permite reparar à mão. */
        if (!registro?.registrado) {
          await deps.registrarErro(
            new Error(
              `Acerto de troca cobrado e NÃO registrado em cobrancas: charge ${cobranca.chargeId}, ` +
              `assinatura ${assinatura.id}, valor ${acerto.acerto}`
            ),
            { contexto: 'trocaPlano.acertoNaoRegistrado', rota: '/api/checkout/trocar-plano', metodo: 'POST' }
          );
        }
      }

      await deps.alterarPlanoAssinatura(assinatura.id, { valor: valorNovo, ciclo: cicloNovo });

      /* RELÊ para conferir. A Asaas responde `200` e ignora em silêncio
         campo que não conhece (medido em 17/09), e `value` não está na
         documentação pública do `PUT` — então a única prova de que a
         alteração pegou é ler de volta. Se não pegou e o acerto já foi
         cobrado, o estado é ruim e tem de ser DITO, não escondido: o
         nosso banco não mente dizendo que trocou. */
      const depois = await deps.consultarAssinaturaNaAsaas(assinatura.id);
      const pegou = Number.isFinite(Number(depois?.valor))
        && emCentavos(depois.valor) === emCentavos(valorNovo)
        && depois?.ciclo === cicloNovo;

      if (!pegou) {
        /* Arrendamento NÃO é devolvido de propósito: ele expira sozinho
           em minutos, e até lá impede uma retentativa automática de
           cobrar o acerto de novo. */
        await deps.registrarErro(
          new Error(
            `PUT da troca de plano não pegou: ${assinatura.id} esperava valor=${valorNovo}/ciclo=${cicloNovo}, ` +
            `leu valor=${depois?.valor}/ciclo=${depois?.ciclo}`
          ),
          { contexto: 'trocaPlano.reconferencia', rota: '/api/checkout/trocar-plano', metodo: 'POST' }
        );

        return resposta.status(502).json({
          erro: 'A alteração do plano não foi confirmada pela Asaas. O plano NÃO foi alterado.',
          acerto: { cobrado: Boolean(chargeIdDoAcerto), valor: acertoCobradoEmReais, chargeId: chargeIdDoAcerto }
        });
      }

      await deps.aplicarTrocaDePlano(assinatura.id, {
        planoNovoId,
        planoAnteriorId: planoId,
        valor: valorNovo,
        ciclo: cicloNovo
      });

      /* Fire-and-forget, como os outros avisos de assinatura: a resposta
         abaixo já confirma a quem chamou. O aviso existe para o
         contratante que trocou por uma tela dele ficar sabendo pelo
         mesmo canal de sempre — e `planoAnterior` vai junto porque o
         payload de assinatura identifica por `planoId`+`documento`
         (API.md §4.3.4), e o `planoId` acabou de mudar. */
      deps.notificarPlanoTrocado(contratante, {
        planoId: planoNovoId,
        planoAnterior: planoId,
        documento,
        valor: valorNovo,
        ciclo: cicloNovo,
        acertoCobrado: acertoCobradoEmReais
      });

      resposta.json({
        assinaturaId: assinatura.id,
        planoId: planoNovoId,
        planoAnterior: planoId,
        valor: valorNovo,
        ciclo: cicloNovo,
        proximaCobranca: depois?.proximaCobranca ?? null,
        /* Os números vão abertos porque é o contratante que tem de
           explicar a cobrança ao assinante (RN-35) — sem crédito,
           débito e dias, ele só teria um valor sem origem. */
        acerto: {
          cobrado: Boolean(chargeIdDoAcerto),
          valor: acertoCobradoEmReais,
          chargeId: chargeIdDoAcerto,
          credito: acerto.credito,
          debito: acerto.debito,
          diasRestantes: acerto.diasRestantes,
          motivo: acerto.motivo
        }
      });
    } catch (erro) {
      /* Erro depois de reivindicar e ANTES de cobrar: devolve o
         arrendamento, para a próxima tentativa não esperar o prazo.
         Depois de cobrar, não devolve — ver `chargeIdDoAcerto` acima. */
      if (arrendamentoMeu && !chargeIdDoAcerto) await deps.liberarTroca(assinatura.id);
      responderErro(resposta, erro, 'trocaPlano.trocarPlano');
    }
  };
}

export const trocarPlano = criarTrocarPlano();

/* ------------------------------------------------------------------
   Autoteste — `node src/controllers/trocaPlanoController.js`

   O que este autoteste existe para travar é **a ordem**, não a
   aritmética (a conta tem o autoteste dela, em
   `services/proporcionalService.js`, com 42 checagens).

   A ordem é a regra de negócio: cobrar o acerto ANTES de alterar o
   plano é o que impede um cartão recusado de virar plano caro de graça,
   e reler a assinatura DEPOIS do `PUT` é o que impede o nosso banco de
   dizer "trocou" sobre uma alteração que a Asaas ignorou em silêncio
   (ela responde `200` e ignora campo que não conhece — medido em
   17/09/2026).

   Nada aqui toca rede nem banco: as dependências entram pela fábrica.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('trocaPlanoController.js')) {
  const { strict: assert } = await import('node:assert');

  let checagens = 0;
  const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

  const CONTRATANTE = {
    id: 'mostrai', api_key: 'chave-boa', webhook_url: 'https://exemplo.test/hook', wallet_id: null
  };
  const HOJE = '2026-09-25';
  const VENCIMENTO = '2026-10-10'; // 15 dias — o exemplo que o dono viu

  /**
   * Falseia tudo o que a rota toca e ANOTA a sequência de chamadas, que
   * é o que está sob teste.
   */
  function costura(ajustes = {}) {
    const chamadas = [];
    const asaas = {
      valor: 100,
      ciclo: 'MONTHLY',
      proximaCobranca: VENCIMENTO,
      encerrada: ajustes.encerrada === true,
      deleted: false,
      status: 'ACTIVE'
    };

    const anotar = (nome, args) => { chamadas.push({ nome, args }); };

    const deps = {
      buscarContratantePorChave: async (chave) => {
        anotar('buscarContratantePorChave', [chave]);
        return chave === 'chave-boa' ? CONTRATANTE : null;
      },
      resolverPlano: async (contratanteId, planoId, opcoes) => {
        anotar('resolverPlano', [contratanteId, planoId, opcoes]);
        if (ajustes.planoErro) throw ajustes.planoErro;
        return {
          contratante: CONTRATANTE,
          plano: ajustes.plano ?? { valor: 160, ciclo: 'MONTHLY' }
        };
      },
      buscarAssinaturaAtiva: async (contratanteId, planoId, documento, statusAceitos) => {
        anotar('buscarAssinaturaAtiva', [contratanteId, planoId, documento, statusAceitos]);
        if (ajustes.semAssinatura) return null;
        return { id: 'sub_1', status: 'ativa', ciclo: 'MONTHLY', valor: 100 };
      },
      reivindicarTroca: async (id) => {
        anotar('reivindicarTroca', [id]);
        return ajustes.arrendamentoOcupado ? false : true;
      },
      liberarTroca: async (id) => { anotar('liberarTroca', [id]); },
      aplicarTrocaDePlano: async (id, dados) => { anotar('aplicarTrocaDePlano', [id, dados]); },
      buscarCobrancaPorSubscriptionId: async (id) => {
        anotar('buscarCobrancaPorSubscriptionId', [id]);
        if (ajustes.ultima === null) return null;
        return ajustes.ultima ?? { status: 'confirmado', valor_cobrado: 100 };
      },
      registrarAcertoDeTroca: async (dados) => {
        anotar('registrarAcertoDeTroca', [dados]);
        return { registrado: ajustes.registroFalha ? false : true };
      },
      consultarAssinaturaNaAsaas: async (id) => {
        anotar('consultarAssinaturaNaAsaas', [id]);
        if (ajustes.asaasNaoConhece) return null;
        /* A reconferência é a SEGUNDA chamada: `reconferenciaEstoura`
           simula a rede caindo entre cobrar e conferir. */
        if (ajustes.reconferenciaEstoura
            && chamadas.filter((c) => c.nome === 'consultarAssinaturaNaAsaas').length > 1) {
          throw new Error('rede caiu depois de cobrar');
        }
        return { ...asaas };
      },
      dadosDeCobrancaDaAssinatura: async (id) => {
        anotar('dadosDeCobrancaDaAssinatura', [id]);
        return ajustes.semCartao
          ? { clienteId: 'cus_1', cartaoToken: null }
          : { clienteId: 'cus_1', cartaoToken: 'tok_1' };
      },
      cobrarNoCartaoSalvo: async (dados) => {
        anotar('cobrarNoCartaoSalvo', [dados]);
        return {
          chargeId: 'pay_acerto',
          status: ajustes.statusDoAcerto ?? 'CONFIRMED',
          valor: dados.valor
        };
      },
      alterarPlanoAssinatura: async (id, { valor, ciclo }) => {
        anotar('alterarPlanoAssinatura', [id, { valor, ciclo }]);
        // O `PUT` só "pega" quando a Asaas de verdade aceitou — é isso
        // que a releitura confere.
        if (!ajustes.putNaoPega) {
          // A Asaas guarda em centavos: um valor com mais casas volta
          // arredondado, e é esse o caso que o falso negativo criava.
          asaas.valor = ajustes.asaasArredonda ? Math.round(valor * 100) / 100 : valor;
          asaas.ciclo = ciclo;
        }
      },
      notificarPlanoTrocado: (contratante, dados) => { anotar('notificarPlanoTrocado', [contratante, dados]); },
      registrarErro: async (erro, ctx) => { anotar('registrarErro', [erro, ctx]); },
      hoje: () => HOJE
    };

    return {
      chamadas,
      asaas,
      nomes: () => chamadas.map((c) => c.nome),
      args: (nome) => chamadas.filter((c) => c.nome === nome).map((c) => c.args),
      chamou: (nome) => chamadas.some((c) => c.nome === nome),
      trocar: criarTrocarPlano(deps)
    };
  }

  const pedido = (body, chave = 'chave-boa') => ({
    get: (cabecalho) => (cabecalho === 'X-Checkout-Key' ? chave : undefined),
    body
  });

  function respostaFalsa() {
    const r = { codigo: 200, corpo: null, req: {} };
    r.status = (c) => { r.codigo = c; return r; };
    r.json = (c) => { r.corpo = c; return r; };
    return r;
  }

  const CORPO_OK = { planoId: 'plano_mensal', planoNovoId: 'plano_caro', documento: '11144477735' };

  async function rodar(ajustes = {}, corpo = CORPO_OK, chave = 'chave-boa') {
    const c = costura(ajustes);
    const r = respostaFalsa();
    await c.trocar(pedido(corpo, chave), r);
    return { ...c, r };
  }

  /* --- 1. as recusas que acontecem antes de qualquer efeito -------- */
  let t = await rodar({}, CORPO_OK, null);
  conferir(t.r.codigo === 401, `sem chave é 401, veio ${t.r.codigo}`);
  conferir(t.chamadas.length === 0, 'sem chave não toca em nada');

  t = await rodar({}, CORPO_OK, 'chave-ruim');
  conferir(t.r.codigo === 401, `chave inválida é 401, veio ${t.r.codigo}`);
  conferir(!t.chamou('reivindicarTroca'), 'chave inválida não reivindica troca');

  t = await rodar({}, { planoId: 'p1', documento: '11144477735' });
  conferir(t.r.codigo === 400, `sem planoNovoId é 400, veio ${t.r.codigo}`);

  t = await rodar({}, { ...CORPO_OK, documento: '123' });
  conferir(t.r.codigo === 400, `documento inválido é 400, veio ${t.r.codigo}`);

  t = await rodar({}, { planoId: 'p1', planoNovoId: 'p1', documento: '11144477735' });
  conferir(t.r.codigo === 400, `trocar para o mesmo plano é 400, veio ${t.r.codigo}`);
  conferir(t.chamadas.length === 0, 'plano igual não chega a consultar nada');

  t = await rodar({ semAssinatura: true });
  conferir(t.r.codigo === 404, `sem assinatura é 404, veio ${t.r.codigo}`);
  conferir(!t.chamou('cobrarNoCartaoSalvo'), 'sem assinatura não cobra nada');

  /* --- 2. o caminho feliz, e a ORDEM dentro dele ------------------- */
  t = await rodar();
  conferir(t.r.codigo === 200, `troca boa responde 200, veio ${t.r.codigo} (${JSON.stringify(t.r.corpo)})`);
  conferir(t.r.corpo.acerto.cobrado === true, 'upgrade de 100 para 160 com 15 dias cobra acerto');
  conferir(t.r.corpo.acerto.valor === 30, `acerto de R$ 30, veio ${t.r.corpo.acerto.valor}`);
  conferir(t.r.corpo.planoId === 'plano_caro' && t.r.corpo.planoAnterior === 'plano_mensal', 'a resposta diz de onde para onde');
  conferir(t.r.corpo.valor === 160 && t.r.corpo.ciclo === 'MONTHLY', 'a resposta traz o valor e o ciclo novos');

  const nomes = t.nomes();
  conferir(
    nomes.indexOf('cobrarNoCartaoSalvo') < nomes.indexOf('alterarPlanoAssinatura'),
    'O ACERTO É COBRADO ANTES DE ALTERAR O PLANO — inverter isto dá o plano caro de graça a quem tem cartão recusado'
  );
  conferir(
    nomes.indexOf('reivindicarTroca') < nomes.indexOf('cobrarNoCartaoSalvo'),
    'o arrendamento é tomado antes de cobrar — é ele que impede cobrar duas vezes'
  );
  conferir(
    nomes.indexOf('alterarPlanoAssinatura') < nomes.lastIndexOf('consultarAssinaturaNaAsaas'),
    'a assinatura é RELIDA depois do PUT — a Asaas responde 200 e ignora campo que não conhece'
  );
  conferir(
    nomes.lastIndexOf('consultarAssinaturaNaAsaas') < nomes.indexOf('aplicarTrocaDePlano'),
    'o nosso banco só é reescrito depois de a releitura confirmar'
  );
  conferir(t.chamou('registrarAcertoDeTroca'), 'o acerto cobrado é registrado em cobrancas');
  conferir(t.args('registrarAcertoDeTroca')[0][0].valor === 30, 'e registrado com o valor que foi cobrado');
  conferir(t.args('registrarAcertoDeTroca')[0][0].planoId === 'plano_caro', 'a cobrança do acerto fica no plano NOVO');
  conferir(t.chamou('notificarPlanoTrocado'), 'o contratante é avisado');
  conferir(
    t.args('notificarPlanoTrocado')[0][1].planoAnterior === 'plano_mensal',
    'o aviso leva o planoAnterior — sem ele o contratante não acha o próprio registro (o planoId mudou)'
  );

  /* --- 3. valor e ciclo NUNCA vêm do corpo da requisição ----------- */
  t = await rodar(
    { plano: { valor: 160, ciclo: 'QUARTERLY' } },
    { ...CORPO_OK, valor: 1, ciclo: 'WEEKLY', valorCobrado: 1 }
  );
  conferir(t.r.codigo === 200, 'campos a mais no corpo não quebram a rota');
  const putArgs = t.args('alterarPlanoAssinatura')[0][1];
  conferir(
    putArgs.valor === 160 && putArgs.ciclo === 'QUARTERLY',
    `o PUT usa o plano PUXADO do contratante, não o corpo: veio ${JSON.stringify(putArgs)}`
  );
  conferir(t.r.corpo.valor === 160, 'e a resposta também');

  /* --- 4. o fail-closed: cartão recusado não troca plano ----------- */
  t = await rodar({ statusDoAcerto: 'REFUSED' });
  conferir(t.r.codigo === 402, `acerto recusado é 402, veio ${t.r.codigo}`);
  conferir(!t.chamou('alterarPlanoAssinatura'), 'CARTÃO RECUSADO NÃO ALTERA O PLANO NA ASAAS');
  conferir(!t.chamou('aplicarTrocaDePlano'), 'e não escreve troca nenhuma no nosso banco');
  conferir(!t.chamou('registrarAcertoDeTroca'), 'nem registra cobrança que não confirmou');
  conferir(t.chamou('liberarTroca'), 'e devolve o arrendamento, para a próxima tentativa não esperar o prazo');

  /* --- 5. rebaixamento: troca sem cobrar, e sem devolver ----------- */
  t = await rodar({ plano: { valor: 60, ciclo: 'MONTHLY' } });
  conferir(t.r.codigo === 200, `rebaixamento responde 200, veio ${t.r.codigo}`);
  conferir(!t.chamou('cobrarNoCartaoSalvo'), 'rebaixamento não cobra nada');
  conferir(!t.chamou('registrarAcertoDeTroca'), 'e não registra cobrança nenhuma');
  conferir(t.r.corpo.acerto.cobrado === false && t.r.corpo.acerto.valor === 0, 'a resposta diz que não houve acerto');
  conferir(t.chamou('aplicarTrocaDePlano'), 'mas a troca ACONTECE — o preço novo vale do vencimento em diante');
  conferir(t.args('aplicarTrocaDePlano')[0][1].valor === 60, 'e o valor gravado é o do plano novo');

  /* Controle positivo do "não devolve": nenhuma chamada de estorno
     existe nas dependências desta rota, e é assim que a regra 2 do dono
     ("não devolve") é cumprida — por ausência, não por condição. */
  conferir(
    !t.nomes().some((n) => /estorn|refund/i.test(n)),
    'rebaixamento não estorna — e a rota não tem nem como'
  );

  /* --- 6. acerto absorvido (abaixo do piso da Asaas) --------------- */
  t = await rodar({ plano: { valor: 108, ciclo: 'MONTHLY' } }); // acerto de R$ 4,00
  conferir(t.r.codigo === 200, 'acerto abaixo do piso ainda troca de plano');
  conferir(!t.chamou('cobrarNoCartaoSalvo'), 'e não tenta cobrar R$ 4,00 — a Asaas recusaria');
  conferir(/absorvido/.test(t.r.corpo.acerto.motivo), `a resposta explica que foi absorvido, veio "${t.r.corpo.acerto.motivo}"`);

  /* --- 7. as recusas que protegem a conta ------------------------- */
  t = await rodar({ ultima: { status: 'pendente', valor_cobrado: 100 } });
  conferir(t.r.codigo === 409, `cobrança do período pendente é 409, veio ${t.r.codigo}`);
  conferir(!t.chamou('reivindicarTroca'), 'e recusa ANTES de reivindicar — não existe crédito de período não pago');

  t = await rodar({ ultima: null });
  conferir(t.r.codigo === 409, 'sem cobrança nenhuma no período também é 409');

  t = await rodar({ arrendamentoOcupado: true });
  conferir(t.r.codigo === 409, `troca simultânea é 409, veio ${t.r.codigo}`);
  conferir(!t.chamou('cobrarNoCartaoSalvo'), 'A SEGUNDA CHAMADA NÃO COBRA O MESMO ACERTO DE NOVO');
  conferir(!t.chamou('liberarTroca'), 'e não devolve o arrendamento que é da OUTRA chamada');

  t = await rodar({ semCartao: true });
  conferir(t.r.codigo === 409, `assinatura sem cartão salvo é 409, veio ${t.r.codigo}`);
  conferir(!t.chamou('alterarPlanoAssinatura'), 'sem como cobrar o acerto, o plano não muda');
  conferir(t.chamou('liberarTroca'), 'e o arrendamento é devolvido');

  t = await rodar({ encerrada: true });
  conferir(t.r.codigo === 409, `assinatura encerrada na Asaas é 409, veio ${t.r.codigo}`);

  t = await rodar({ asaasNaoConhece: true });
  conferir(t.r.codigo === 404, `assinatura que a Asaas não conhece é 404, veio ${t.r.codigo}`);

  t = await rodar({ plano: { valor: 4, ciclo: 'MONTHLY' } });
  conferir(t.r.codigo === 400, `plano novo abaixo do piso de R$ 5,00 é 400, veio ${t.r.codigo}`);
  conferir(!t.chamou('consultarAssinaturaNaAsaas'), 'e recusa antes de falar com a Asaas');

  t = await rodar({ plano: { valor: 160, ciclo: 'DECADAL' } });
  conferir(t.r.codigo === 400, `ciclo fora dos sete é 400, veio ${t.r.codigo}`);

  /* Dado incoerente: vencimento mais longe que o ciclo inteiro. Não é
     "nada a cobrar" — é "não sei calcular", e aí recusa. */
  t = await rodar({ plano: { valor: 160, ciclo: 'MONTHLY' }, ultima: { status: 'confirmado', valor_cobrado: 0 } });
  conferir(t.r.codigo === 409, `dado incoerente é 409, veio ${t.r.codigo}`);
  conferir(!t.chamou('reivindicarTroca'), 'dado incoerente não chega a reivindicar nem a cobrar');

  /* --- 8. o PUT que a Asaas ignorou em silêncio ------------------- */
  t = await rodar({ putNaoPega: true });
  conferir(t.r.codigo === 502, `PUT que não pegou é 502, veio ${t.r.codigo}`);
  conferir(!t.chamou('aplicarTrocaDePlano'), 'O NOSSO BANCO NÃO PODE DIZER QUE TROCOU SE A ASAAS NÃO TROCOU');
  conferir(!t.chamou('notificarPlanoTrocado'), 'e o contratante não é avisado de uma troca que não houve');
  conferir(t.chamou('registrarErro'), 'o estado ruim é registrado — acerto cobrado e plano não alterado');
  conferir(t.r.corpo.acerto.chargeId === 'pay_acerto', 'e a resposta entrega o chargeId do acerto, que é o que resolve na mão');
  conferir(!t.chamou('liberarTroca'), 'o arrendamento fica de pé: ele é o que impede uma retentativa automática de cobrar de novo');

  /* --- 8b. a segunda troca DENTRO do mesmo período ---------------- */
  /* O ciclo pago está gravado sob o plano ANTIGO. Procurar o último
     ciclo por `planoId` não acharia nada depois da primeira troca, e a
     rota responderia "cobrança não confirmada" — falso, e no caminho do
     dinheiro. A busca é pela ASSINATURA, que não muda quando o plano
     muda. */
  t = await rodar();
  conferir(
    t.args('buscarCobrancaPorSubscriptionId')[0][0] === 'sub_1',
    `o último ciclo é procurado pelo id da ASSINATURA, veio "${t.args('buscarCobrancaPorSubscriptionId')[0][0]}"`
  );
  conferir(
    !t.nomes().includes('buscarUltimaCobrancaDaAssinatura'),
    'e NÃO pela busca por plano+documento, que erra na segunda troca do mesmo período'
  );

  /* --- 8c. valor com mais de duas casas não vira falso 502 -------- */
  t = await rodar({ plano: { valor: 45.999, ciclo: 'MONTHLY' }, asaasArredonda: true });
  conferir(
    t.r.codigo === 200,
    `plano de R$ 45,999 (a Asaas guarda 46,00) tem de passar, veio ${t.r.codigo} — comparar em reais daria 502 DEPOIS de cobrar o acerto`
  );
  conferir(t.chamou('aplicarTrocaDePlano'), 'e a troca é gravada');

  /* Controle positivo: o arredondamento não pode virar "aceita
     qualquer valor de volta". Se a Asaas devolver outro número, é 502. */
  t = await rodar({ putNaoPega: true, asaasArredonda: true });
  conferir(t.r.codigo === 502, 'valor diferente continua sendo 502 — o arredondamento não afrouxa a conferência');

  /* --- 8d. acerto cobrado e não registrado não passa calado ------- */
  t = await rodar({ registroFalha: true });
  conferir(t.r.codigo === 200, 'falha ao GRAVAR o acerto não desfaz a troca — o cartão já foi debitado');
  conferir(
    t.chamou('registrarErro'),
    'mas vira erro registrado (Lei 8): dinheiro cobrado e não registrado é invisível para a métrica e para o painel'
  );

  /* --- 9. erro no meio devolve o arrendamento; erro antes, não ---- */
  const erroDoPlano = Object.assign(new Error('Plano não encontrado.'), { status: 404 });
  t = await rodar({ planoErro: erroDoPlano });
  conferir(t.r.codigo === 404, `plano de destino inexistente é 404, veio ${t.r.codigo}`);
  conferir(
    !t.chamou('liberarTroca'),
    'ERRO ANTES DE REIVINDICAR NÃO DEVOLVE ARRENDAMENTO — devolver o de outra chamada é o que faria as duas cobrarem'
  );

  /* --- 9b. exceção DEPOIS de cobrar não devolve o arrendamento ----
     Este é o furo que o ciclo 2 da revisão achou: o `GET` de
     reconferência pode estourar (timeout, 5xx) com o cartão já
     debitado. Devolver o arrendamento ali faria a retentativa cobrar o
     acerto de novo — e desfazer isso é estorno no cartão de uma pessoa
     real. */
  t = await rodar({ reconferenciaEstoura: true });
  conferir(t.r.codigo >= 500, `exceção depois de cobrar responde erro, veio ${t.r.codigo}`);
  conferir(t.chamou('cobrarNoCartaoSalvo'), 'o acerto foi cobrado neste cenário');
  conferir(
    !t.chamou('liberarTroca'),
    'ARRENDAMENTO NÃO É DEVOLVIDO depois de cobrar — é o que impede a retentativa de debitar duas vezes'
  );

  /* E o par que dá sentido a isso: a MESMA exceção, antes de cobrar,
     devolve o arrendamento — senão a guarda viraria "nunca devolve", e
     um erro de rede trancaria a assinatura por minutos sem motivo. */
  t = await rodar({ reconferenciaEstoura: true, plano: { valor: 60, ciclo: 'MONTHLY' } });
  conferir(!t.chamou('cobrarNoCartaoSalvo'), 'rebaixamento não cobra, então nada foi debitado');
  conferir(t.chamou('liberarTroca'), 'e aí o arrendamento VOLTA — sem cobrança não há o que proteger');

  /* --- 10. o documento é normalizado antes de qualquer busca ------ */
  t = await rodar({}, { ...CORPO_OK, documento: '111.444.777-35' });
  conferir(t.r.codigo === 200, 'CPF pontuado é aceito');
  conferir(
    t.args('buscarAssinaturaAtiva')[0][2] === '11144477735',
    `a busca usa só dígitos (RN-32), veio "${t.args('buscarAssinaturaAtiva')[0][2]}"`
  );

  /* --- 11. pausada troca de plano, cancelada não ------------------ */
  t = await rodar();
  conferir(
    t.args('buscarAssinaturaAtiva')[0][3].includes('pausada'),
    'pausada entra na busca — a Asaas aceita mudar valor de assinatura pausada (medido)'
  );
  conferir(
    !t.args('buscarAssinaturaAtiva')[0][3].includes('cancelada'),
    'cancelada não: não há o que alterar, e o caminho de volta é assinar de novo'
  );

  /* --- 12. o plano de destino é puxado com o contratante em mãos --- */
  conferir(
    t.args('resolverPlano')[0][2]?.contratante === CONTRATANTE,
    'o contratante já carregado é repassado — senão é uma segunda ida ao banco pela mesma linha (213 ms medidos)'
  );
  conferir(
    t.args('resolverPlano')[0][2]?.metodoRequerido === 'assinatura',
    'e o método exigido é assinatura: contratante sem assinatura habilitada não troca plano'
  );

  /* --- 13. a regra fica no código, não na memória ----------------
     As duas consultas que devolvem "a cobrança da assinatura" precisam
     filtrar por MÉTODO de assinatura. Sem isso o acerto de uma troca —
     que aponta para a mesma assinatura, carrega o mesmo plano e nasce
     depois do último ciclo — vira a cobrança mais recente dela, e
     estraga dois usos: o valor que o contratante lê como preço do plano
     (`API.md` §5.3) e o MOLDE do ciclo seguinte, que copiaria uma linha
     sem telefone e sem endereço.

     Foi medido ao vivo, dentro do contêiner: sem o filtro vinha o acerto
     de R$ 30 onde devia vir o ciclo de R$ 160. A checagem é no
     texto-fonte porque provar de novo exigiria banco, e provar que o
     filtro não foi removido não exige nada. */
  {
    const { readFileSync } = await import('node:fs');
    const fonte = readFileSync(new URL('../services/cobrancaService.js', import.meta.url), 'utf8');

    for (const funcao of ['buscarUltimaCobrancaDaAssinatura', 'buscarCobrancaPorSubscriptionId']) {
      const inicio = fonte.indexOf(`export async function ${funcao}`);
      conferir(inicio > 0, `${funcao} ainda existe em cobrancaService`);
      const corpo = fonte.slice(inicio, fonte.indexOf('\n}', inicio));
      conferir(
        /\.in\(\s*'metodo_pagamento'\s*,\s*METODOS_DE_ASSINATURA\s*\)/.test(corpo),
        `${funcao} tem de filtrar por METODOS_DE_ASSINATURA — senão o acerto de troca vira "a cobrança da assinatura"`
      );
    }
  }

  /* --- 14. os sete ciclos existem em DOIS lugares, e ninguém comparava
     `CICLOS_VALIDOS` (asaasCheckoutController) é o conjunto que a Asaas
     aceita e que a criação da assinatura valida; `DIAS_DO_CICLO`
     (proporcionalService) é quantos dias cada um tem. São dois arquivos
     com o MESMO conjunto fechado e nenhuma comparação entre eles até
     18/09/2026 — achado no ciclo de revisão do projeto inteiro.

     O que aconteceria na divergência não é erro visível: um ciclo novo
     aceito na criação e ausente na tabela de dias faz a troca de plano
     responder "não foi possível calcular o acerto" para aquele plano,
     para sempre, sem nada apontar a causa. É a lição nº 19 (conjunto
     fechado enumerado pela metade) aplicada a duas metades nossas. */
  {
    const dosDias = Object.keys(DIAS_DO_CICLO).sort();
    const aceitos = [...CICLOS_VALIDOS].sort();
    conferir(
      dosDias.length === aceitos.length && dosDias.every((c, i) => c === aceitos[i]),
      `os ciclos aceitos e os ciclos com dias têm de ser o MESMO conjunto — aceitos: ${aceitos.join(',')} / com dias: ${dosDias.join(',')}`
    );
    conferir(aceitos.length === 7, `e são sete (veio ${aceitos.length})`);
  }

  console.log(`trocaPlanoController: ${checagens} checagens OK`);
}
