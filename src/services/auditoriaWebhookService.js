/**
 * SAN CHECKOUT v2 — src/services/auditoriaWebhookService.js
 *
 * O log de auditoria do webhook da Asaas: uma linha por evento
 * recebido, e um contador por hora das tentativas que a guarda de
 * origem recusou. É o que a Lei 8 pede aqui, e é o que torna útil
 * marcar no painel da Asaas um evento que o código ainda não trata —
 * antes disto, esse evento virava `console.log` da hospedagem e sumia.
 *
 * A REGRA QUE MANDA NESTE ARQUIVO: payload de webhook da Asaas carrega
 * nome, e-mail, CPF/CNPJ, telefone e endereço do comprador. Nada disso
 * é gravado. `redigirPayload` decide o que passa por LISTA BRANCA de
 * nome de campo; tudo que não está nela vira só o CAMINHO da chave,
 * sem o valor. Lista branca e não lista negra porque lista negra falha
 * aberta — e falhar aberta aqui é CPF no banco.
 *
 * Nada aqui pode derrubar o webhook. A Asaas PAUSA a fila depois de 15
 * falhas seguidas (CONSTRAINTS.md §2.3), então o receptor responde 200
 * sempre; uma auditoria que estourasse exceção transformaria um
 * problema de diagnóstico em perda de confirmação de pagamento. Por
 * isso toda função de escrita aqui engole o próprio erro e no máximo
 * loga.
 */

import { supabase } from '../config/supabase.js';

/* ------------------------------------------------------------------
   Redação
------------------------------------------------------------------ */

/**
 * Nomes de campo cujo VALOR pode ser gravado. Todo o resto vira só
 * caminho de chave.
 *
 * O critério para entrar: o campo é de estado/valor da cobrança ou da
 * conta, e não identifica pessoa nem por si nem por cruzamento. Por
 * isso `id`, `customer`, `subscription` e `externalReference` NÃO
 * estão aqui — o identificador de que a auditoria precisa é extraído
 * à parte, por `extrairReferencia`, e vai para a coluna própria.
 *
 * Comparação pelo nome FINAL da chave, não pelo caminho inteiro: o
 * mesmo campo aparece em `payment.status` e em `checkout.payment
 * .status`, e uma lista por caminho completo teria que prever todas as
 * formas — o que falharia justamente no formato que ainda não vimos ao
 * vivo.
 */
const ESCALARES_PERMITIDOS = new Set([
  'event',
  // estado e dinheiro da cobrança
  'status', 'billingType', 'value', 'netValue', 'originalValue',
  'chargedFeeValue', 'interestValue', 'discountValue',
  'installmentCount', 'cycle', 'deleted', 'anticipated', 'postalService',
  // datas
  'dueDate', 'originalDueDate', 'paymentDate', 'clientPaymentDate',
  'confirmedDate', 'effectiveDate', 'nextDueDate', 'expirationDate',
  // situação de subconta (ACCOUNT_STATUS_*)
  'general', 'commercialInfo', 'bankAccountInfo', 'documentation',
  // motivo de recusa — Pix Automático, antifraude, captura de cartão
  'reason', 'refusalReason', 'failReason', 'eligible'
]);

const PROFUNDIDADE_MAXIMA = 6;
const CAMINHOS_MAXIMOS = 120;
const TAMANHO_MAXIMO_DO_VALOR = 64;
/* O caminho também tem teto. Quem tem o token do webhook controla o
   NOME das chaves, não só o valor: um objeto com uma chave de 100 KB
   viraria um caminho de 100 KB, 120 vezes por linha. O limite de 120
   caminhos sozinho não segura nada se cada um puder ter qualquer
   tamanho. */
const TAMANHO_MAXIMO_DO_CAMINHO = 160;
const TAMANHO_MAXIMO_DO_NOME_DE_EVENTO = 120;
const TAMANHO_MAXIMO_DA_REFERENCIA = 120;

/**
 * Devolve `{ valores, caminhos }`:
 *
 * - `valores` — só o que a lista branca autoriza, por caminho.
 * - `caminhos` — o mapa de chaves do payload, SEM valor nenhum.
 *
 * O mapa de chaves é o que responde a pergunta que está aberta no
 * cabeçalho do `webhookController.js` desde sempre: no `CHECKOUT_PAID`
 * real, o id da cobrança criada vem em `checkout.payment.id` ou solto
 * em `payment.id`? É pergunta de formato, e formato não precisa de
 * dado pessoal para ser respondido.
 *
 * Índice de array vira `[]` de propósito: `itens[0].nome` e
 * `itens[37].nome` são a mesma informação de formato, e guardar o
 * índice faria o mapa crescer com o tamanho do pedido.
 */
export function redigirPayload(corpo) {
  const valores = {};
  const caminhos = new Set();

  const percorrer = (valor, caminho, profundidade) => {
    if (caminhos.size >= CAMINHOS_MAXIMOS) return;

    if (Array.isArray(valor)) {
      if (profundidade >= PROFUNDIDADE_MAXIMA) return;
      for (const item of valor) percorrer(item, `${caminho}[]`, profundidade + 1);
      return;
    }

    if (valor !== null && typeof valor === 'object') {
      if (profundidade >= PROFUNDIDADE_MAXIMA) return;
      for (const [chave, filho] of Object.entries(valor)) {
        percorrer(filho, caminho ? `${caminho}.${chave}` : chave, profundidade + 1);
      }
      return;
    }

    const caminhoCurto = caminho.slice(0, TAMANHO_MAXIMO_DO_CAMINHO);
    caminhos.add(caminhoCurto);

    const nomeFinal = caminho.split('.').pop().replace('[]', '');
    if (!ESCALARES_PERMITIDOS.has(nomeFinal)) return;
    if (valor === null || valor === undefined) return;
    if (!['string', 'number', 'boolean'].includes(typeof valor)) return;

    valores[caminhoCurto] = typeof valor === 'string'
      ? valor.slice(0, TAMANHO_MAXIMO_DO_VALOR)
      : valor;
  };

  if (corpo !== null && typeof corpo === 'object') percorrer(corpo, '', 0);
  return { valores, caminhos: [...caminhos].sort() };
}

/**
 * O identificador que a auditoria guarda, e de que tipo ele é. A ordem
 * importa: `payment.id` primeiro porque é ele que vira `charge_id` na
 * tabela `cobrancas`; `checkout.id` depois porque no fluxo de pop-up é
 * o único que existe antes da confirmação.
 *
 * Devolve `{ tipo: null, id: null }` quando não reconhece — evento
 * novo não pode quebrar a auditoria dele mesmo.
 */
export function extrairReferencia(corpo) {
  /* `account` vem POR ÚLTIMO: todo evento real traz `account` (é a conta
     que emite — medido no primeiro `SUBSCRIPTION_CREATED` e no primeiro
     `CHECKOUT_PAID` de produção, 25/09/2026). Na frente, ele rotulava
     todo `SUBSCRIPTION_*` como "account <id da nossa conta>", e a
     referência que importa — a assinatura — não aparecia em lugar
     nenhum. Só evento de conta de verdade (`ACCOUNT_STATUS_*`) cai nele. */
  const candidatos = [
    ['payment', corpo?.payment?.id],
    ['checkout', corpo?.checkout?.id],
    ['subscription', corpo?.payment?.subscription ?? corpo?.subscription?.id],
    ['authorization', corpo?.authorization?.id ?? corpo?.recurring?.id],
    ['account', corpo?.account?.id]
  ];

  for (const [tipo, id] of candidatos) {
    if (typeof id === 'string' && id) return { tipo, id: id.slice(0, TAMANHO_MAXIMO_DA_REFERENCIA) };
  }
  return { tipo: null, id: null };
}

/* ------------------------------------------------------------------
   Escrita do evento
------------------------------------------------------------------ */

/**
 * Grava a linha do evento. Não lança nunca — ver o cabeçalho.
 * Devolve `true` só quando gravou, para o autoteste conseguir afirmar.
 */
export async function registrarEventoWebhook(dados) {
  try {
    const { error } = await supabase.from('webhook_eventos').insert({
      evento: dados.evento ? String(dados.evento).slice(0, TAMANHO_MAXIMO_DO_NOME_DE_EVENTO) : null,
      rota: dados.rota ?? null,
      resultado: dados.resultado,
      detalhe: dados.detalhe ? String(dados.detalhe).slice(0, 500) : null,
      referencia_tipo: dados.referenciaTipo ?? null,
      referencia_id: dados.referenciaId ?? null,
      status_mapeado: dados.statusMapeado ?? null,
      campos: dados.campos ?? null
    });

    if (error) {
      console.error('[auditoriaWebhook.registrarEvento]', error.message);
      return false;
    }
    return true;
  } catch (erro) {
    console.error('[auditoriaWebhook.registrarEvento]', erro.message);
    return false;
  }
}

/* ------------------------------------------------------------------
   Tentativas recusadas pela guarda de origem
------------------------------------------------------------------ */

const INTERVALO_DE_DESCARGA_MS = 60_000;
const AMOSTRAS_POR_HORA = 20;

/**
 * Acumula em memória e descarrega no banco no máximo uma vez por
 * minuto. Isso existe porque esta contagem é alimentada por requisição
 * NÃO autenticada: gravar direto, uma linha por tentativa, seria
 * entregar escrita ilimitada no banco a quem não tem token nenhum.
 * Acumulado, uma sondagem de mil requisições por segundo continua
 * custando uma escrita por minuto.
 *
 * O que se perde num reinício do serviço é o que ainda não desceu —
 * até 60 segundos de contagem. Aceito: o número serve para perceber
 * sondagem, não para fechar caixa.
 *
 * Chaveado pela hora do evento, não pela hora da descarga, senão um
 * lote que atravessa a virada da hora cairia todo na hora errada.
 */
const pendentes = new Map();
let descargaAgendada = null;

function inicioDaHora(data) {
  const copia = new Date(data);
  copia.setUTCMinutes(0, 0, 0);
  return copia.toISOString();
}

export function registrarRejeicaoWebhook({ ip, tinhaToken, motivo } = {}) {
  const agora = new Date();
  const hora = inicioDaHora(agora);
  const balde = pendentes.get(hora) ?? { quantidade: 0, amostras: [] };

  balde.quantidade += 1;
  if (balde.amostras.length < AMOSTRAS_POR_HORA) {
    // O token recusado NÃO entra aqui. É credencial em texto puro (a
    // skill `seguranca-san` proíbe), e quem errar uma letra do token
    // CERTO gravaria o token certo no banco. Só `tinhaToken` é
    // suficiente para separar "sondagem burra" de "token errado".
    balde.amostras.push({
      em: agora.toISOString(),
      ip: ip ? String(ip).slice(0, 45) : null,
      tinhaToken: Boolean(tinhaToken),
      motivo: motivo ? String(motivo).slice(0, 80) : null
    });
  }

  pendentes.set(hora, balde);
  agendarDescarga();
}

function agendarDescarga() {
  if (descargaAgendada) return;
  descargaAgendada = setTimeout(() => {
    descargaAgendada = null;
    descarregarRejeicoes();
  }, INTERVALO_DE_DESCARGA_MS);
  // Não segurar o processo vivo só por causa de um contador.
  descargaAgendada.unref?.();
}

/** Exportada para o autoteste e para o desligamento; não lança. */
export async function descarregarRejeicoes() {
  if (pendentes.size === 0) return;

  const lotes = [...pendentes.entries()];
  pendentes.clear();

  // Limpa ANTES de gravar: se o banco estiver fora, o lote se perde em
  // vez de voltar para a fila. É escolha, não descuido — devolver o
  // lote faria a memória crescer sem teto justamente durante uma
  // sondagem com o banco indisponível, que é o pior momento possível
  // para o processo inchar. O número existe para perceber sondagem,
  // não para fechar caixa.

  for (const [hora, balde] of lotes) {
    try {
      const { error } = await supabase.rpc('registrar_rejeicoes_webhook', {
        p_hora: hora,
        p_quantidade: balde.quantidade,
        p_amostras: balde.amostras
      });
      if (error) console.error('[auditoriaWebhook.descarregarRejeicoes]', error.message);
    } catch (erro) {
      console.error('[auditoriaWebhook.descarregarRejeicoes]', erro.message);
    }
  }
}

/* ------------------------------------------------------------------
   Consultas do painel
------------------------------------------------------------------ */

export async function listarEventosWebhook({ limite = 50, resultado, evento, antesDe } = {}) {
  // Clamp nos dois lados: `Math.min(Number(limite) || 50, 200)` sozinho
  // deixa passar negativo, e `.limit(-5)` vira erro do PostgREST em vez
  // de lista vazia.
  const quantas = Math.min(Math.max(Number(limite) || 50, 1), 200);

  let consulta = supabase
    .from('webhook_eventos')
    .select('*')
    .order('recebido_em', { ascending: false })
    .limit(quantas);

  if (resultado) consulta = consulta.eq('resultado', resultado);
  if (evento) consulta = consulta.eq('evento', evento);
  if (antesDe) consulta = consulta.lt('recebido_em', antesDe);

  const { data, error } = await consulta;
  if (error) throw error;
  return data ?? [];
}

/** Quantos eventos caíram no "não mapeado" no período — é o número que
 *  vira o contador da aba, e o que faz alguém perceber que a Asaas
 *  começou a mandar algo novo. */
export async function contarEventosNaoTratados(dias = 7) {
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('webhook_eventos')
    .select('id', { count: 'exact', head: true })
    .eq('resultado', 'nao_mapeado')
    .gte('recebido_em', desde);

  if (error) throw error;
  return count ?? 0;
}

/** O último evento que chegou, de qualquer tipo. Serve para a única
 *  leitura possível da fila pausada da Asaas (CONSTRAINTS.md §2.3):
 *  fila pausada não gera evento, então o que aparece é AUSÊNCIA — e
 *  ausência só é visível se alguém mostrar há quanto tempo. */
export async function ultimoEventoRecebido() {
  const { data, error } = await supabase
    .from('webhook_eventos')
    .select('recebido_em, evento')
    .order('recebido_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

export async function resumoRejeicoes({ horas = 24 } = {}) {
  await descarregarRejeicoes();

  const desde = new Date(Date.now() - horas * 60 * 60 * 1000).toISOString();

  const [agregado, recentes] = await Promise.all([
    supabase.rpc('resumo_rejeicoes_webhook'),
    supabase
      .from('webhook_rejeicoes')
      .select('*')
      .gte('hora', desde)
      .order('hora', { ascending: false })
  ]);

  if (agregado.error) throw agregado.error;
  if (recentes.error) throw recentes.error;

  const linhas = recentes.data ?? [];
  const resumo = Array.isArray(agregado.data) ? agregado.data[0] : agregado.data;

  // Comparação por INSTANTE, não por texto. O Postgres devolve
  // `2026-09-11T17:00:00+00:00` e o `toISOString()` daqui produz
  // `2026-09-11T17:00:00.000Z` — o mesmo momento, escrito de dois
  // jeitos. Comparar as duas strings nunca daria igual, e a contagem
  // da última hora seria sempre zero, calada.
  const horaAtual = new Date(inicioDaHora(new Date())).getTime();
  const daHoraAtual = linhas.find((l) => new Date(l.hora).getTime() === horaAtual);

  return {
    total: Number(resumo?.total_geral ?? 0),
    desde: resumo?.primeira_hora ?? null,
    ultimaHora: Number(daHoraAtual?.total ?? 0),
    horas: linhas.map((l) => ({ hora: l.hora, total: l.total })),
    amostras: linhas.flatMap((l) => l.amostras ?? []).slice(0, 100)
  };
}

/* ------------------------------------------------------------------
   Expurgo
------------------------------------------------------------------ */

const DIAS_DE_EVENTO = 90;
const DIAS_DE_AMOSTRA = 30;

/**
 * Chamado no boot e a cada 24h pelo `server.js`. Este log é
 * diagnóstico, não é dado fiscal: não herda os 5 anos de retenção da
 * tabela `cobrancas` (CONSTRAINTS.md seção 2).
 *
 * As LINHAS de `webhook_rejeicoes` não são apagadas — são minúsculas
 * (no máximo 24 por dia) e o total histórico é a soma delas. O que
 * expira são as amostras, que é onde mora o IP.
 */
export async function expurgarAuditoria() {
  const limiteEventos = new Date(Date.now() - DIAS_DE_EVENTO * 24 * 60 * 60 * 1000).toISOString();
  const limiteAmostras = new Date(Date.now() - DIAS_DE_AMOSTRA * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { error: erroEventos } = await supabase
      .from('webhook_eventos')
      .delete()
      .lt('recebido_em', limiteEventos);
    if (erroEventos) console.error('[auditoriaWebhook.expurgar] eventos:', erroEventos.message);

    // Sem filtro de "já está vazia": comparar jsonb com string via
    // PostgREST é justamente o tipo de sutileza que falha calada. O
    // custo de reescrever linha já vazia é desprezível (no máximo 24
    // por dia de histórico) e o resultado é o mesmo — idempotente.
    const { error: erroAmostras } = await supabase
      .from('webhook_rejeicoes')
      .update({ amostras: [] })
      .lt('hora', limiteAmostras);
    if (erroAmostras) console.error('[auditoriaWebhook.expurgar] amostras:', erroAmostras.message);
  } catch (erro) {
    console.error('[auditoriaWebhook.expurgar]', erro.message);
  }
}

/* ------------------------------------------------------------------
   Autoteste — `node src/services/auditoriaWebhookService.js`

   Só o que é puro: redação e extração de referência. Nada aqui toca
   banco. A redação é a parte de segurança deste arquivo, então é ela
   que recebe o payload mais realista que der.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('auditoriaWebhookService.js')) {
  const { strict: assert } = await import('node:assert');

  // Payload no formato que a Asaas documenta para PAYMENT_*, com o
  // bloco `customer` inteiro — que é onde mora o dado de pessoa.
  const payloadReal = {
    event: 'PAYMENT_CONFIRMED',
    payment: {
      id: 'pay_8241',
      customer: 'cus_000005401844',
      subscription: 'sub_9911',
      externalReference: 'ped_2026_0031',
      status: 'CONFIRMED',
      billingType: 'PIX',
      value: 149.9,
      netValue: 147.41,
      dueDate: '2026-09-20',
      confirmedDate: '2026-09-11',
      description: 'Pedido de Maria Aparecida da Silva',
      invoiceUrl: 'https://www.asaas.com/i/8241',
      creditCard: { creditCardNumber: '8829', creditCardBrand: 'VISA' }
    },
    customer: {
      name: 'Maria Aparecida da Silva',
      email: 'maria.silva@exemplo.com.br',
      cpfCnpj: '52998224725',
      mobilePhone: '11987654321',
      address: 'Rua das Acácias',
      addressNumber: '1024',
      postalCode: '01310930',
      city: 'São Paulo'
    }
  };

  const { valores, caminhos } = redigirPayload(payloadReal);
  const serializado = JSON.stringify({ valores, caminhos });

  // O teste que importa: nenhum dado de pessoa sobreviveu à redação.
  for (const proibido of [
    'Maria Aparecida', 'maria.silva@exemplo.com.br', '52998224725',
    '11987654321', 'Rua das Acácias', '01310930', 'São Paulo',
    '8829', 'https://www.asaas.com/i/8241', 'ped_2026_0031',
    'cus_000005401844'
  ]) {
    assert.ok(!serializado.includes(proibido), `redação deixou passar: ${proibido}`);
  }

  // E o que a lista branca autoriza continua lá, senão a redação teria
  // eliminado junto a razão de existir do log.
  assert.equal(valores['event'], 'PAYMENT_CONFIRMED');
  assert.equal(valores['payment.status'], 'CONFIRMED');
  assert.equal(valores['payment.billingType'], 'PIX');
  assert.equal(valores['payment.value'], 149.9);
  assert.equal(valores['payment.dueDate'], '2026-09-20');

  // Campo de identificação NÃO entra em `valores`, mas o CAMINHO dele
  // entra — é isso que responde "onde vem o id" sem carregar o valor.
  assert.ok(!('payment.customer' in valores), 'customer não vira valor');
  assert.ok(caminhos.includes('payment.customer'), 'mas o caminho de customer é registrado');
  assert.ok(caminhos.includes('customer.cpfCnpj'), 'o caminho do cpfCnpj é registrado');
  assert.ok(!('customer.cpfCnpj' in valores), 'o VALOR do cpfCnpj nunca');

  // A pergunta aberta do webhookController: onde vem o payment.id de um
  // CHECKOUT_PAID? O mapa de chaves responde sem dado pessoal.
  const checkout = redigirPayload({
    event: 'CHECKOUT_PAID',
    checkout: { id: 'chk_1', status: 'PAID', payment: { id: 'pay_novo', value: 10 } }
  });
  assert.ok(checkout.caminhos.includes('checkout.payment.id'), 'o caminho do id criado é visível');
  assert.equal(checkout.valores['checkout.payment.value'], 10);

  // Índice de array não entra no caminho: pedido de 2 itens e de 200
  // itens produzem o mesmo mapa.
  const doisItens = redigirPayload({ payment: { itens: [{ nome: 'a' }, { nome: 'b' }] } });
  assert.deepEqual(doisItens.caminhos, ['payment.itens[].nome']);

  // Teto de tamanho: quem tem o token controla o nome das chaves, então
  // caminho e referência não podem crescer sem limite.
  const chaveGigante = 'k'.repeat(5000);
  const inchado = redigirPayload({ payment: { [chaveGigante]: 'x' } });
  assert.ok(
    inchado.caminhos.every((c) => c.length <= 160),
    'caminho de chave tem teto — senão uma linha do log cresce sem limite'
  );
  assert.equal(
    extrairReferencia({ payment: { id: 'p'.repeat(5000) } }).id.length, 120,
    'referência tem teto'
  );

  // Corpo inútil não quebra a auditoria dele mesmo.
  assert.deepEqual(redigirPayload(null), { valores: {}, caminhos: [] });
  assert.deepEqual(redigirPayload('texto solto'), { valores: {}, caminhos: [] });

  // Referência: payment.id na frente de checkout.id, porque é ele que
  // vira charge_id.
  assert.deepEqual(extrairReferencia(payloadReal), { tipo: 'payment', id: 'pay_8241' });
  assert.deepEqual(
    extrairReferencia({ event: 'CHECKOUT_PAID', checkout: { id: 'chk_1' } }),
    { tipo: 'checkout', id: 'chk_1' }
  );
  assert.deepEqual(
    extrairReferencia({ event: 'ACCOUNT_STATUS_DOCUMENT_APPROVED', account: { id: 'acc_1' } }),
    { tipo: 'account', id: 'acc_1' }
  );
  // O primeiro SUBSCRIPTION_CREATED real (25/09/2026), redigido: traz `account` E `subscription`.
  assert.deepEqual(
    extrairReferencia({ id: 'evt_6561&1533536453', event: 'SUBSCRIPTION_CREATED', account: { id: '29eceb5c', ownerId: null }, subscription: { id: 'sub_39mjscz7vl2jwx7g', checkoutSession: '842e6f11' } }),
    { tipo: 'subscription', id: 'sub_39mjscz7vl2jwx7g' },
    'SUBSCRIPTION_* real: a referência é a assinatura, não a conta que emitiu'
  );
  assert.deepEqual(
    extrairReferencia({ event: 'CHECKOUT_PAID', account: { id: '29eceb5c' }, checkout: { id: '842e6f11' } }),
    { tipo: 'checkout', id: '842e6f11' },
    'CHECKOUT_PAID real também traz account — o checkout vence'
  );
  assert.deepEqual(extrairReferencia({ event: 'SEI_LA' }), { tipo: null, id: null });
  assert.deepEqual(extrairReferencia(null), { tipo: null, id: null });

  // Acúmulo de rejeição: milhares de tentativas não viram milhares de
  // escritas — viram baldes por hora, com amostra limitada.
  for (let i = 0; i < 5000; i += 1) {
    registrarRejeicaoWebhook({ ip: `10.0.0.${i % 255}`, tinhaToken: i % 2 === 0, motivo: 'token inválido' });
  }
  assert.equal(pendentes.size, 1, '5000 tentativas na mesma hora: um balde só');
  const balde = [...pendentes.values()][0];
  assert.equal(balde.quantidade, 5000, 'a contagem não se perde');
  assert.equal(balde.amostras.length, AMOSTRAS_POR_HORA, 'a amostra é limitada — sondagem não enche o banco');
  assert.equal(balde.amostras[0].motivo, 'token inválido', 'o motivo é guardado');
  assert.ok(
    balde.amostras.every((a) => !('token' in a)),
    'o token recusado NUNCA é guardado'
  );
  pendentes.clear();

  console.log('auditoriaWebhookService: redação e acúmulo OK');
}
