/**
 * SAN CHECKOUT v2 — src/controllers/trocaPlanoController.js
 * `POST /api/checkout/trocar-plano`
 * Header: `X-Checkout-Key` (a MESMA chave do contratante que
 *   cancelar/pausar/retomar já usam)
 * Body: `{ planoId, planoNovoId, documento }`
 *
 * ── Redesenhada em 21/09/2026 ─────────────────────────────────────────
 * Até 18/09/2026 esta rota cobrava o acerto proporcional e alterava o
 * plano NA MESMA chamada, sem o pagador ver nada — decisão registrada em
 * 17/09 ("quem troca de plano não decide o próprio plano pelo
 * checkout"). O dono reverteu isso em 20/09: quando há acerto a pagar
 * (>= R$ 5,00), o PAGADOR precisa consentir na tela do Checkout antes de
 * qualquer cobrança. Desenho completo, com as quatro rodadas de decisão
 * que chegaram até aqui, em
 * `docs/specs/2026-09-20-troca-de-plano-redireciona-pagador.md`.
 *
 * ── As TRÊS saídas desta rota, hoje ───────────────────────────────────
 *   1. `acerto.cobra === false` (rebaixamento) → `200`, IMEDIATO, como
 *      sempre foi — rebaixamento não cobra, não há o que aprovar.
 *   2. `acerto.cobra === false` por absorção (< R$ 5,00, abaixo do piso
 *      da Asaas) → `200`, IMEDIATO, pelo mesmo motivo — é o MESMO flag
 *      que o caso 1 (`proporcionalService.js` já decide os dois como
 *      "não cobra"; esta rota não distingue os dois, e não precisa).
 *   3. `acerto.cobra === true` (>= R$ 5,00) → `202 Accepted`. NADA é
 *      cobrado nem alterado aqui: nasce uma "intenção de troca"
 *      (`trocaIntencaoService.js`, migration 0011), com um retrato
 *      CONGELADO do que foi calculado agora, e a resposta traz o link
 *      para o pagador aprovar. A cobrança de verdade só acontece em
 *      `POST /troca/aprovar` (`trocaAprovacaoController.js`), minutos
 *      depois, quando (e se) o pagador confirmar.
 *
 * As recusas cedo (piso, ciclo, cobrança do período não confirmada,
 * dado incoerente, assinatura sem cartão salvo) continuam TODAS aqui,
 * antes de criar qualquer intenção — nenhuma delas precisa da aprovação
 * do pagador para ser recusada, e criar uma intenção que vai falhar de
 * qualquer jeito só atrasaria a resposta ao contratante.
 *
 * ── Quem decide o quê ───────────────────────────────────────────────
 * As sete regras do acerto continuam do dono (17/09/2026), em
 * `services/proporcionalService.js`. O que esta rota faz é a
 * COREOGRAFIA de antes de existir efeito — puxar o plano de destino,
 * recusar cedo, e decidir entre "não há o que aprovar" e "criar a
 * intenção". A coreografia de COBRAR (antes: aqui; agora: em
 * `trocaExecucaoService.js`, disparada pela aprovação) é onde o dinheiro
 * se perde, e por isso tem o autoteste dela separado, lá.
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
import { buscarCobrancaPorSubscriptionId } from '../services/cobrancaService.js';
import {
  consultarAssinaturaNaAsaas,
  dadosDeCobrancaDaAssinatura,
  alterarPlanoAssinatura
} from '../services/asaasService.js';
import { criarIntencao } from '../services/trocaIntencaoService.js';
import { calcularAcertoDeTroca, DIAS_DO_CICLO } from '../services/proporcionalService.js';
import { notificarPlanoTrocado } from './webhookController.js';
/* Os sete ciclos moram lá porque é lá que a assinatura NASCE, e o front
   espelha a mesma lista apontando para aquele arquivo. Importar em vez
   de repetir: uma segunda lista de ciclos é uma lista que envelhece. */
import { resolverCicloDoPlano } from './planoController.js';
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
 *  que o provedor não tem.
 *
 *  Exportada: `trocaExecucaoService.js` usa a MESMA lista para
 *  revalidar, na hora da aprovação, que a assinatura ainda está num
 *  estado que troca — duas cópias desse conjunto fechado é o que a
 *  lição nº 19 (`docs/erros/`) existe para evitar. */
export const STATUS_QUE_TROCAM = ['ativa', 'pausada'];

/** O status da nossa cobrança que significa "o período em curso foi
 *  pago". É dele que sai o crédito do acerto (regra 4 do dono: o crédito
 *  vem do valor PAGO, nunca de saldo guardado). */
const STATUS_PERIODO_PAGO = 'confirmado';

const dependenciasPadrao = {
  buscarContratantePorChave,
  resolverPlano,
  buscarAssinaturaAtiva,
  reivindicarTroca,
  liberarTroca,
  aplicarTrocaDePlano,
  buscarCobrancaPorSubscriptionId,
  consultarAssinaturaNaAsaas,
  dadosDeCobrancaDaAssinatura,
  alterarPlanoAssinatura,
  criarIntencao,
  notificarPlanoTrocado,
  registrarErro,
  /* Origem do front estático (Cloudflare Pages) — é onde `/troca`
     mora. Mesma variável que já decide o CORS em `server.js`
     (`ORIGEM_FRONTEND`): o Checkout só tem UM front, então é a mesma
     origem para as duas coisas. */
  origemFrontend: () => process.env.ORIGEM_FRONTEND,
  /* Dia civil de BRASÍLIA, não de UTC. O processo roda em UTC (medido
     no contêiner), e entre 21h e meia-noite de Brasília o dia de UTC já
     é o seguinte: o acerto sairia com um dia restante a menos — em
     mensal, 3% do valor, todo dia, nas três últimas horas. A data de
     vencimento com que ele é comparado é brasileira. */
  hoje: hojeCivil
};

/**
 * A fábrica existe para o autoteste poder exercitar a COREOGRAFIA sem
 * rede e sem banco — e é a coreografia que importa aqui: decidir entre
 * "não há o que aprovar" e "existe uma intenção para aprovar" é a regra
 * de negócio inteira desta rota, desde 21/09/2026.
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

    /* Fora do `try`: o `catch` precisa saber se ESTA chamada é dona do
       arrendamento, para devolvê-lo numa falha de rede a meio do
       caminho (a Asaas cai entre `reivindicarTroca` e a releitura). Sem
       isto, achado no ciclo de revisão do PR #36: uma assinatura ficava
       travada até o arrendamento de 5 minutos vencer sozinho — nada se
       perde (este caminho não cobra nada), mas é a mesma regressão que
       a versão síncrona original já evitava. */
    let assinaturaIdArrendada = null;

    try {
      const contratante = await deps.buscarContratantePorChave(chave);
      if (!contratante) return resposta.status(401).json({ erro: 'Chave inválida.' });

      const assinatura = await deps.buscarAssinaturaAtiva(
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
      /* Piso da Asaas conferido AQUI, antes de qualquer intenção: ela
         recusaria o `PUT` com `400 invalid_value`, e esse erro chegaria
         ao contratante sem contexto — e depois de o pagador já ter
         aprovado um valor que nunca ia passar. */
      if (!valorCobradoAceitavel(valorNovo)) {
        return resposta.status(400).json({ erro: MENSAGEM_PISO_ASAAS });
      }

      /* Mesma camada canônica de ciclos da criação (M-10,
         `utils/ciclos.js`): qualquer dos três vocabulários, conferido
         contra o que este contratante vende, sem `MONTHLY` por omissão. */
      const { ciclo: cicloNovo, erro: erroCiclo } = resolverCicloDoPlano(planoNovo, contratante);
      if (erroCiclo) return resposta.status(400).json({ erro: erroCiclo });

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
         um valor que ninguém pagou. Busca pelo id da ASSINATURA (não por
         `planoId`): numa SEGUNDA troca dentro do mesmo período, o ciclo
         pago está gravado sob o plano ANTIGO. */
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

      /* ── SAÍDA 3: existe acerto a cobrar — nasce uma intenção ──────
         `acerto.cobra === true` é SEMPRE >= R$ 5,00 (a mesma função já
         decide "absorvido" como `cobra: false` para valores abaixo do
         piso) — então este é o único ramo que passa pelo redirecionar. */
      if (acerto.cobra) {
        /* Recusa cedo o que a aprovação recusaria depois — criar uma
           intenção destinada a falhar só atrasaria o contratante. */
        const cobravel = await deps.dadosDeCobrancaDaAssinatura(assinatura.id);
        if (!cobravel?.cartaoToken || !cobravel?.clienteId) {
          return resposta.status(409).json({
            erro: 'Esta assinatura não tem cartão salvo para cobrar o acerto proporcional da troca.'
          });
        }

        /* O nome do plano ATUAL é só cosmético (a tela do pagador o
           mostra) — best-effort, nunca bloqueia a troca por ele. O
           plano NOVO já foi resolvido acima e sempre tem nome. */
        let planoAtualNome = planoId;
        try {
          const { plano } = await deps.resolverPlano(contratante.id, planoId, {
            metodoRequerido: 'assinatura',
            contratante
          });
          if (plano?.nome) planoAtualNome = plano.nome;
        } catch { /* cosmético — segue com o id */ }

        const { id, expiraEm } = await deps.criarIntencao({
          assinaturaId: assinatura.id,
          contratanteId: contratante.id,
          planoId,
          planoNovoId,
          planoNome: planoAtualNome,
          planoNovoNome: planoNovo?.nome ?? planoNovoId,
          cicloAtual,
          cicloNovo,
          valorAtual: Number(assinatura.valor),
          valorNovo,
          valorPagoDoPeriodo: Number(ultima.valor_cobrado),
          vencimentoAtual,
          diasRestantes: acerto.diasRestantes,
          credito: acerto.credito,
          debito: acerto.debito,
          valorAcerto: acerto.acerto,
          mutationVersionSnapshot: assinatura.mutation_version
        });

        const origem = deps.origemFrontend();
        return resposta.status(202).json({
          code: 'PLAN_CHANGE_APPROVAL_REQUIRED',
          status: 'approval_required',
          approvalUrl: origem ? `${origem}/troca#t=${id}` : `/troca#t=${id}`,
          expiresAt: expiraEm,
          amount: acerto.acerto
        });
      }

      /* ── SAÍDAS 1 e 2: nada a cobrar — troca IMEDIATA, como sempre foi
         Rebaixamento (regra 6 do dono: não devolve, o preço novo passa a
         valer no vencimento que já existia) e absorção (abaixo do piso
         da Asaas) chegam aqui do MESMO jeito — `acerto.cobra === false`
         nos dois casos, e nenhum dos dois tem o que o pagador aprove. */
      const arrendamentoMeu = await deps.reivindicarTroca(assinatura.id);
      if (!arrendamentoMeu) {
        return resposta.status(409).json({ erro: 'Já existe uma troca de plano em andamento para esta assinatura.' });
      }
      assinaturaIdArrendada = assinatura.id;

      await deps.alterarPlanoAssinatura(assinatura.id, { valor: valorNovo, ciclo: cicloNovo });

      /* RELÊ para conferir. A Asaas responde `200` e ignora em silêncio
         campo que não conhece (medido em 17/09), então a única prova de
         que a alteração pegou é ler de volta. */
      const depois = await deps.consultarAssinaturaNaAsaas(assinatura.id);
      const emCentavos = (n) => Math.round(Number(n) * 100);
      const pegou = Number.isFinite(Number(depois?.valor))
        && emCentavos(depois.valor) === emCentavos(valorNovo)
        && depois?.ciclo === cicloNovo;

      if (!pegou) {
        await deps.registrarErro(
          new Error(
            `PUT da troca de plano (sem acerto) não pegou: ${assinatura.id} esperava valor=${valorNovo}/ciclo=${cicloNovo}, ` +
            `leu valor=${depois?.valor}/ciclo=${depois?.ciclo}`
          ),
          { contexto: 'trocaPlano.reconferencia', rota: '/api/checkout/trocar-plano', metodo: 'POST' }
        );

        return resposta.status(502).json({
          erro: 'A alteração do plano não foi confirmada pela Asaas. O plano NÃO foi alterado.',
          acerto: { cobrado: false, valor: 0 }
        });
      }

      const aplicou = await deps.aplicarTrocaDePlano(assinatura.id, {
        planoNovoId,
        planoAnteriorId: planoId,
        valor: valorNovo,
        ciclo: cicloNovo,
        mutationVersionEsperada: assinatura.mutation_version
      });

      if (!aplicou) {
        /* CAS perdido é IMPOSSÍVEL neste caminho em condições normais —
           `trocando_em` já serializa toda troca desta assinatura, e
           nenhuma outra rota deste projeto mexe em `mutation_version`
           hoje. Chegar aqui é sinal de corrida real; registra e devolve
           o estado ruim em vez de fingir sucesso. */
        await deps.registrarErro(
          new Error(`aplicarTrocaDePlano (sem acerto) perdeu o CAS de mutation_version — assinatura ${assinatura.id}`),
          { contexto: 'trocaPlano.casPerdido', rota: '/api/checkout/trocar-plano', metodo: 'POST' }
        );
        return resposta.status(502).json({
          erro: 'A troca não pôde ser confirmada — tente novamente.',
          acerto: { cobrado: false, valor: 0 }
        });
      }

      /* Fire-and-forget, como os outros avisos de assinatura. */
      deps.notificarPlanoTrocado(contratante, {
        planoId: planoNovoId,
        planoAnterior: planoId,
        documento,
        valor: valorNovo,
        ciclo: cicloNovo,
        acertoCobrado: 0,
        assinaturaId: assinatura.id
      });

      resposta.json({
        assinaturaId: assinatura.id,
        planoId: planoNovoId,
        planoAnterior: planoId,
        valor: valorNovo,
        ciclo: cicloNovo,
        proximaCobranca: depois?.proximaCobranca ?? null,
        acerto: {
          cobrado: false,
          valor: 0,
          credito: acerto.credito,
          debito: acerto.debito,
          diasRestantes: acerto.diasRestantes,
          motivo: acerto.motivo
        }
      });
    } catch (erro) {
      /* Este caminho (sem acerto) nunca cobra nada — então, ao contrário
         da aprovação assíncrona, não há ambiguidade de dinheiro a
         proteger aqui: devolver o arrendamento é sempre seguro. */
      if (assinaturaIdArrendada) await deps.liberarTroca(assinaturaIdArrendada);
      responderErro(resposta, erro, 'trocaPlano.trocarPlano');
    }
  };
}

export const trocarPlano = criarTrocarPlano();

/* ------------------------------------------------------------------
   Autoteste — `node src/controllers/trocaPlanoController.js`

   Desde 21/09/2026 este autoteste trava DUAS coisas: as recusas cedo
   (inalteradas) e a DECISÃO entre "200 imediato" e "202, cria
   intenção". A coreografia de COBRAR não mora mais aqui — tem o
   autoteste dela em `trocaExecucaoService.js`, com as 13 checagens que
   cobrem a ordem cobrar→aplicar→concluir. Aqui, cobrar significa
   "criar a intenção correta"; a cobrança de verdade só existe depois
   da aprovação.
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

  function costura(ajustes = {}) {
    const chamadas = [];
    const asaas = {
      valor: 100, ciclo: 'MONTHLY', proximaCobranca: VENCIMENTO,
      encerrada: ajustes.encerrada === true, deleted: false, status: 'ACTIVE'
    };
    const anotar = (nome, args) => chamadas.push({ nome, args });

    const deps = {
      buscarContratantePorChave: async (chave) => {
        anotar('buscarContratantePorChave', [chave]);
        return chave === 'chave-boa' ? CONTRATANTE : null;
      },
      resolverPlano: async (contratanteId, planoId, opcoes) => {
        anotar('resolverPlano', [contratanteId, planoId, opcoes]);
        if (ajustes.planoErro) throw ajustes.planoErro;
        if (planoId === 'plano_mensal') return { contratante: CONTRATANTE, plano: { nome: 'Mensal', valor: 100, ciclo: 'MONTHLY' } };
        return { contratante: CONTRATANTE, plano: ajustes.plano ?? { nome: 'Caro', valor: 160, ciclo: 'MONTHLY' } };
      },
      buscarAssinaturaAtiva: async (contratanteId, planoId, documento, statusAceitos) => {
        anotar('buscarAssinaturaAtiva', [contratanteId, planoId, documento, statusAceitos]);
        if (ajustes.semAssinatura) return null;
        return { id: 'sub_1', status: 'ativa', ciclo: 'MONTHLY', valor: 100, mutation_version: ajustes.mutationVersion ?? 3 };
      },
      reivindicarTroca: async (id) => { anotar('reivindicarTroca', [id]); return !ajustes.arrendamentoOcupado; },
      liberarTroca: async (id) => { anotar('liberarTroca', [id]); },
      aplicarTrocaDePlano: async (id, dados) => { anotar('aplicarTrocaDePlano', [id, dados]); return !ajustes.casPerdido; },
      buscarCobrancaPorSubscriptionId: async (id) => {
        anotar('buscarCobrancaPorSubscriptionId', [id]);
        if (ajustes.ultima === null) return null;
        return ajustes.ultima ?? { status: 'confirmado', valor_cobrado: 100 };
      },
      consultarAssinaturaNaAsaas: async (id) => {
        anotar('consultarAssinaturaNaAsaas', [id]);
        if (ajustes.asaasNaoConhece) return null;
        return { ...asaas };
      },
      dadosDeCobrancaDaAssinatura: async (id) => {
        anotar('dadosDeCobrancaDaAssinatura', [id]);
        return ajustes.semCartao ? { clienteId: 'cus_1', cartaoToken: null } : { clienteId: 'cus_1', cartaoToken: 'tok_1' };
      },
      alterarPlanoAssinatura: async (id, { valor, ciclo }) => {
        anotar('alterarPlanoAssinatura', [id, { valor, ciclo }]);
        if (ajustes.putFalhaDeRede) throw new Error('fetch failed');
        if (!ajustes.putNaoPega) { asaas.valor = valor; asaas.ciclo = ciclo; }
      },
      criarIntencao: async (dados) => {
        anotar('criarIntencao', [dados]);
        return { id: 'int_abc123', expiraEm: '2026-09-25T15:15:00.000Z' };
      },
      notificarPlanoTrocado: (contratante, dados) => { anotar('notificarPlanoTrocado', [contratante, dados]); },
      registrarErro: async (erro, ctx) => { anotar('registrarErro', [erro, ctx]); },
      origemFrontend: () => ajustes.semOrigem ? undefined : 'https://checkout.sancocore.com.br',
      hoje: () => HOJE
    };

    return {
      chamadas, asaas,
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
    const r = { codigo: 200, corpo: null };
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

  t = await rodar({}, { planoId: 'p1', documento: '11144477735' });
  conferir(t.r.codigo === 400, `sem planoNovoId é 400, veio ${t.r.codigo}`);

  t = await rodar({}, { ...CORPO_OK, documento: '123' });
  conferir(t.r.codigo === 400, `documento inválido é 400, veio ${t.r.codigo}`);

  t = await rodar({}, { planoId: 'p1', planoNovoId: 'p1', documento: '11144477735' });
  conferir(t.r.codigo === 400, `trocar para o mesmo plano é 400, veio ${t.r.codigo}`);
  conferir(t.chamadas.length === 0, 'plano igual não chega a consultar nada');

  t = await rodar({ semAssinatura: true });
  conferir(t.r.codigo === 404, `sem assinatura é 404, veio ${t.r.codigo}`);

  t = await rodar({ ultima: { status: 'pendente', valor_cobrado: 100 } });
  conferir(t.r.codigo === 409, `cobrança do período pendente é 409, veio ${t.r.codigo}`);

  t = await rodar({ encerrada: true });
  conferir(t.r.codigo === 409, `assinatura encerrada na Asaas é 409, veio ${t.r.codigo}`);

  t = await rodar({ asaasNaoConhece: true });
  conferir(t.r.codigo === 404, `assinatura que a Asaas não conhece é 404, veio ${t.r.codigo}`);

  t = await rodar({ plano: { nome: 'Barato', valor: 4, ciclo: 'MONTHLY' } });
  conferir(t.r.codigo === 400, `plano novo abaixo do piso de R$ 5,00 é 400, veio ${t.r.codigo}`);

  t = await rodar({ plano: { nome: 'Estranho', valor: 160, ciclo: 'DECADAL' } });
  conferir(t.r.codigo === 400, `ciclo fora dos sete é 400, veio ${t.r.codigo}`);

  t = await rodar({ plano: { nome: 'Caro', valor: 160, ciclo: 'MONTHLY' }, ultima: { status: 'confirmado', valor_cobrado: 0 } });
  conferir(t.r.codigo === 409, `dado incoerente é 409, veio ${t.r.codigo}`);
  conferir(!t.chamou('criarIntencao'), 'dado incoerente não chega a criar intenção nenhuma');

  /* --- 2. SAÍDA 1: rebaixamento, imediato, sem intenção ------------- */
  t = await rodar({ plano: { nome: 'Barato', valor: 60, ciclo: 'MONTHLY' } });
  conferir(t.r.codigo === 200, `rebaixamento responde 200 imediato, veio ${t.r.codigo}`);
  conferir(!t.chamou('criarIntencao'), 'rebaixamento não cria intenção — não há o que o pagador aprove');
  conferir(t.r.corpo.acerto.cobrado === false && t.r.corpo.acerto.valor === 0, 'a resposta diz que não houve acerto');
  conferir(t.chamou('aplicarTrocaDePlano'), 'mas a troca ACONTECE na hora — o preço novo vale do vencimento em diante');
  const argsAplicar1 = t.args('aplicarTrocaDePlano')[0][1];
  conferir(argsAplicar1.mutationVersionEsperada === 3, 'e leva o mutation_version que acabou de ler, para o CAS');
  conferir(t.chamou('notificarPlanoTrocado'), 'e o contratante é avisado (fire-and-forget)');

  /* --- 3. SAÍDA 2: absorção abaixo do piso, imediato, sem intenção -- */
  t = await rodar({ plano: { nome: 'QuaseIgual', valor: 108, ciclo: 'MONTHLY' } }); // acerto de R$ 4,00
  conferir(t.r.codigo === 200, 'acerto abaixo do piso também é 200 imediato');
  conferir(!t.chamou('criarIntencao'), 'e também não cria intenção — o mesmo flag `cobra: false` do rebaixamento');
  conferir(/absorvido/.test(t.r.corpo.acerto.motivo), `a resposta explica que foi absorvido, veio "${t.r.corpo.acerto.motivo}"`);
  conferir(!t.chamou('dadosDeCobrancaDaAssinatura'), 'e nem chega a checar cartão salvo — não vai cobrar nada');

  /* --- 4. SAÍDA 3: acerto de verdade, 202 e intenção criada --------- */
  t = await rodar(); // upgrade de 100→160, 15 dias restantes: acerto de R$ 30
  conferir(t.r.codigo === 202, `acerto >= R$5 responde 202, veio ${t.r.codigo} (${JSON.stringify(t.r.corpo)})`);
  conferir(t.r.corpo.code === 'PLAN_CHANGE_APPROVAL_REQUIRED', 'com o código de aprovação pendente');
  conferir(t.r.corpo.status === 'approval_required', 'e o status em texto');
  conferir(t.r.corpo.approvalUrl === 'https://checkout.sancocore.com.br/troca#t=int_abc123', `a URL leva o token no FRAGMENTO, veio "${t.r.corpo.approvalUrl}"`);
  conferir(!t.r.corpo.approvalUrl.includes('?'), 'nunca em query string — fragmento não viaja em log nenhum');
  conferir(t.r.corpo.amount === 30, `o valor do acerto vai na resposta, veio ${t.r.corpo.amount}`);
  conferir(
    !t.chamou('cobrarNoCartaoSalvo') && !t.chamou('alterarPlanoAssinatura') && !t.chamou('aplicarTrocaDePlano'),
    'NADA É COBRADO NEM ALTERADO NESTA CHAMADA — só a intenção nasce'
  );
  conferir(!t.chamou('notificarPlanoTrocado'), 'e o contratante não é avisado ainda — a troca não aconteceu');
  const intencaoCriada = t.args('criarIntencao')[0][0];
  conferir(intencaoCriada.assinaturaId === 'sub_1', 'a intenção leva a assinatura certa');
  conferir(intencaoCriada.valorAcerto === 30, 'e o valor do acerto CONGELADO');
  conferir(intencaoCriada.mutationVersionSnapshot === 3, 'e o mutation_version no instante da criação, para a aprovação revalidar depois');
  conferir(intencaoCriada.planoNovoNome === 'Caro', 'e o nome do plano novo, para a tela mostrar');
  conferir(
    t.nomes().indexOf('dadosDeCobrancaDaAssinatura') < t.nomes().indexOf('criarIntencao'),
    'checa cartão salvo ANTES de criar a intenção — recusar cedo o que a aprovação recusaria depois'
  );

  t = await rodar({ semOrigem: true });
  conferir(t.r.corpo.approvalUrl === '/troca#t=int_abc123', 'sem ORIGEM_FRONTEND configurada, cai para caminho relativo em vez de quebrar');

  /* --- 5. sem cartão salvo: recusa ANTES de criar intenção ---------- */
  t = await rodar({ semCartao: true });
  conferir(t.r.codigo === 409, `sem cartão salvo é 409, veio ${t.r.codigo}`);
  conferir(!t.chamou('criarIntencao'), 'nunca cria uma intenção destinada a falhar na aprovação');

  /* --- 6. o PUT que a Asaas ignorou em silêncio (caminho SEM acerto) */
  t = await rodar({ plano: { nome: 'Barato', valor: 60, ciclo: 'MONTHLY' }, putNaoPega: true });
  conferir(t.r.codigo === 502, `PUT que não pegou é 502, veio ${t.r.codigo}`);
  conferir(!t.chamou('notificarPlanoTrocado'), 'e o contratante não é avisado de uma troca que não houve');
  conferir(t.chamou('registrarErro'), 'o estado ruim é registrado');

  /* --- 7. CAS perdido no caminho SEM acerto (corrida improvável, mas
     coberta) -------------------------------------------------------- */
  t = await rodar({ plano: { nome: 'Barato', valor: 60, ciclo: 'MONTHLY' }, casPerdido: true });
  conferir(t.r.codigo === 502, `CAS perdido é 502, veio ${t.r.codigo}`);
  conferir(t.chamou('registrarErro'), 'e fica registrado');

  /* --- 7b. a Asaas cai DEPOIS de reivindicar o arrendamento — achado no
     ciclo de revisão do PR #36: a versão antiga desta rota devolvia o
     arrendamento no `catch` quando nada tinha sido cobrado
     (`if (arrendamentoMeu && !chargeIdDoAcerto)`); a reescrita tinha
     perdido essa proteção, e a assinatura ficava travada até o
     arrendamento de 5 minutos vencer sozinho. Este caminho nunca cobra
     nada, então devolver sempre é seguro. ------------------------------ */
  t = await rodar({ plano: { nome: 'Barato', valor: 60, ciclo: 'MONTHLY' }, putFalhaDeRede: true });
  conferir(t.r.codigo >= 500, `exceção de rede no PUT responde erro, veio ${t.r.codigo}`);
  conferir(t.chamou('reivindicarTroca'), 'o arrendamento foi reivindicado antes de quebrar');
  conferir(t.chamou('liberarTroca'), 'MAS É DEVOLVIDO NO CATCH — nada foi cobrado, nada impede a próxima tentativa');

  /* --- 8. a segunda troca DENTRO do mesmo período, pelo id da
     assinatura — mesma regra de sempre -------------------------------- */
  t = await rodar();
  conferir(
    t.args('buscarCobrancaPorSubscriptionId')[0][0] === 'sub_1',
    'o último ciclo é procurado pelo id da ASSINATURA, não por plano+documento'
  );

  /* --- 9. o documento é normalizado antes de qualquer busca --------- */
  t = await rodar({}, { ...CORPO_OK, documento: '111.444.777-35' });
  conferir(t.r.codigo === 202, 'CPF pontuado é aceito');
  conferir(
    t.args('buscarAssinaturaAtiva')[0][2] === '11144477735',
    'a busca usa só dígitos (RN-32)'
  );

  /* --- 10. pausada troca de plano, cancelada não -------------------- */
  t = await rodar();
  conferir(t.args('buscarAssinaturaAtiva')[0][3].includes('pausada'), 'pausada entra na busca');
  conferir(!t.args('buscarAssinaturaAtiva')[0][3].includes('cancelada'), 'cancelada não');

  console.log(`trocaPlanoController: ${checagens} checagens OK`);
}
