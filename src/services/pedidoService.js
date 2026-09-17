/**
 * SAN CHECKOUT v2 — src/services/pedidoService.js
 * O coração do modelo pull (ver INTEGRACAO.md seção 3): o checkout
 * nunca guarda catálogo — liga de volta pra API do próprio contratante
 * pra saber o que está sendo vendido e por quanto.
 */

import { supabase } from '../config/supabase.js';
import { puxarDoContratante, RespostaRecusada } from '../utils/puxarDoContratante.js';

const TIMEOUT_MS = 45000; // calibrado pro pior cold start de hospedagem gratuita

/**
 * `assinatura_pix` (Pix Automático) entrou depois e NÃO está no default
 * do `create table` — então contratante já cadastrado fica sem ele até
 * alguém marcar no admin. Isso é de propósito: o recurso depende de a
 * Asaas ter habilitado Pix Automático na conta, então tem que ser
 * opt-in consciente, não algo que liga sozinho e falha na cara do
 * comprador.
 */
export const METODOS_VALIDOS = ['pix', 'boleto', 'cartao', 'assinatura', 'assinatura_pix'];

/**
 * Os dois métodos que significam "esta cobrança é de uma assinatura".
 *
 * Mora aqui, junto de `METODOS_VALIDOS`, porque três lugares precisam da
 * MESMA lista e ela vinha declarada dentro do `webhookController`: o
 * webhook (para escolher o vocabulário de evento), a conciliação (para
 * achar o último CICLO, e não qualquer cobrança que compartilhe o plano)
 * e a troca de plano. Três cópias dessincronizam no dia em que um
 * terceiro método de assinatura nascer.
 */
export const METODOS_DE_ASSINATURA = ['assinatura', 'assinatura_pix'];

/**
 * O acerto proporcional de uma troca de plano — `POST /trocar-plano`.
 *
 * Tem método PRÓPRIO, e não `cartao`, por dois motivos que não são
 * cosméticos:
 *
 *  1. **O webhook da Asaas chega para ele.** O acerto é uma cobrança
 *     avulsa de verdade, então `PAYMENT_CONFIRMED` (e um eventual
 *     `PAYMENT_REFUNDED`) batem no nosso receptor. Sem um método que o
 *     identifique, o receptor o trataria como pedido avulso e mandaria
 *     ao contratante a confirmação de um pedido com `pedidoId: null` —
 *     uma venda que não existe, no caminho do dinheiro.
 *  2. **A métrica fica legível.** O acerto é dinheiro confirmado e
 *     entra na conta, mas não é venda nova: num balde próprio ninguém
 *     o confunde com uma.
 */
export const METODO_ACERTO_TROCA = 'acerto_troca';

/** `metodos_habilitados` nulo (linha antiga, antes da migração) libera
 *  tudo — mesmo default do `create table` novo, só reforçado aqui pra
 *  não travar contratante nenhum silenciosamente. */
function metodoHabilitado(contratante, metodo) {
  const lista = contratante.metodos_habilitados;
  if (!Array.isArray(lista)) return true;
  return lista.includes(metodo);
}

function exigirMetodoHabilitado(contratante, metodoRequerido) {
  if (!metodoRequerido) return;
  if (metodoHabilitado(contratante, metodoRequerido)) return;
  const erro = new Error(`Este contratante não aceita pagamento por ${metodoRequerido}.`);
  erro.status = 403;
  throw erro;
}

/**
 * Menor tamanho aceito pra um id só de dígitos. Abaixo disso o id é
 * sequencial na prática, e sequencial é enumerável.
 *
 * O motivo: a rota que resolve um pedido é PÚBLICA por necessidade — o
 * comprador precisa dela antes de existir qualquer autenticação. Se o
 * contratante usar id `1`, `2`, `3`, qualquer pessoa varre
 * `?c=parceiro&pedido=N` e lê valor, itens e os dados do pagador que
 * vierem pré-preenchidos. A defesa não pode ser a rota (ela tem que ser
 * aberta), então é o id: precisa ser impossível de adivinhar.
 *
 * Id longo só de dígitos (timestamp, por exemplo) passa; qualquer id
 * com letra passa. `INTEGRACAO.md` registra isso como obrigação do
 * contratante.
 */
const MINIMO_DIGITOS_ID = 8;

function exigirIdImprevisivel(id, rotulo) {
  const texto = String(id ?? '');
  const soDigitos = /^\d+$/.test(texto);
  if (!soDigitos || texto.length >= MINIMO_DIGITOS_ID) return;

  const erro = new Error(
    `O ${rotulo} "${texto}" é sequencial e por isso adivinhável — o checkout recusa ids assim. ` +
    'Use um identificador imprevisível (UUID, hash ou similar). Ver INTEGRACAO.md, seção 2.'
  );
  erro.status = 400;
  throw erro;
}

/**
 * Busca o cadastro do contratante no Supabase (nunca por API pública).
 *
 * **Contratante arquivado não é encontrado aqui, e isso é o ponto.**
 * Arquivar precisa parar a cobrança, senão é só esconder da lista: um
 * link antigo continuaria abrindo o checkout e gerando Pix para um
 * parceiro que saiu. Quem chama trata a ausência como 404 "Contratante
 * não encontrado", que é a resposta certa — e não revela ao portador do
 * link se o contratante nunca existiu ou se foi desligado.
 *
 * O caminho de volta existe e é um clique no painel (`desarquivar`),
 * porque arquivar não pode ser uma porta de mão única.
 */
export async function buscarContratante(contratanteId) {
  const { data, error } = await supabase
    .from('contratantes')
    .select('*')
    .eq('id', contratanteId)
    .is('arquivado_em', null)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Busca o contratante pela api_key — usado pra autenticar o /estornar.
 *
 * Também recusa arquivado, pela mesma razão e mais uma: a chave de um
 * parceiro desligado deixa de valer no mesmo instante em que ele é
 * arquivado, sem precisar rotacionar nada.
 */
export async function buscarContratantePorChave(apiKey) {
  const { data, error } = await supabase
    .from('contratantes')
    .select('*')
    .eq('api_key', apiKey)
    .is('arquivado_em', null)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Liga pra API do contratante e busca os dados reais do pedido.
 * @returns {Promise<object>} o pedido, como veio da API do contratante
 * @throws {Error} com .status 404/502/504 conforme a falha
 */
export async function resolverPedido(contratanteId, pedidoId, { metodoRequerido } = {}) {
  exigirIdImprevisivel(pedidoId, 'pedidoId');

  const contratante = await buscarContratante(contratanteId);
  if (!contratante) {
    const erro = new Error('Contratante não encontrado.');
    erro.status = 404;
    throw erro;
  }
  exigirMetodoHabilitado(contratante, metodoRequerido);

  const controlador = new AbortController();
  const timeoutId = setTimeout(() => controlador.abort(), TIMEOUT_MS);

  /* Quem vai à rede é `puxarDoContratante`: ele revalida cada
     redirecionamento e lê o corpo com teto. O `fetch` cru que estava
     aqui seguia redirect sem perguntar (SSRF pela resposta, não pelo
     cadastro) e lia o corpo inteiro (OOM na instância de 512 MiB) —
     ver a nota no topo daquele arquivo. */
  let resposta;
  try {
    resposta = await puxarDoContratante(`${contratante.api_base_url}/pedido/${pedidoId}`, {
      chave: contratante.api_key,
      signal: controlador.signal
    });
  } catch (erroFetch) {
    /* Redirect para fora, cadeia longa demais e corpo acima do teto são
       resposta ERRADA do contratante, não rede fora do ar: `502`, como
       qualquer outra resposta que não dá para usar. Só a falha de rede
       de verdade continua `504`. A mensagem ao comprador é a mesma nos
       dois casos de propósito — ele não tem o que fazer com a diferença,
       e o motivo fica no log pelo `erro.cause`. */
    const erro = new Error('Não foi possível carregar os dados do pedido, tente novamente.');
    erro.status = erroFetch instanceof RespostaRecusada ? 502 : 504;
    erro.cause = erroFetch;
    throw erro;
  } finally {
    clearTimeout(timeoutId);
  }

  if (resposta.status === 404) {
    const erro = new Error('Pedido não encontrado.');
    erro.status = 404;
    throw erro;
  }

  if (resposta.status < 200 || resposta.status >= 300 || resposta.corpo === null) {
    const erro = new Error('Não foi possível carregar os dados do pedido, tente novamente.');
    erro.status = 502;
    throw erro;
  }

  const pedido = resposta.corpo;

  if (pedido.status === 'pago' || pedido.status === 'cancelado') {
    const erro = new Error(`Este pedido já está com status "${pedido.status}".`);
    erro.status = 409;
    erro.pedido = pedido;
    throw erro;
  }

  if (pedido.expiraEm && new Date(pedido.expiraEm) < new Date()) {
    const erro = new Error('Este pedido expirou.');
    erro.status = 409;
    erro.pedido = pedido;
    throw erro;
  }

  return { contratante, pedido };
}

/**
 * Equivalente a `resolverPedido`, mas pra Assinatura — ver
 * API.md §4.2. Sem conceito de status/expiraEm (plano não
 * é um pedido com ciclo de vida, é só a definição de um produto
 * recorrente).
 */
export async function resolverPlano(contratanteId, planoId, { metodoRequerido, contratante: jaCarregado } = {}) {
  exigirIdImprevisivel(planoId, 'planoId');

  /* `contratante` já carregado entra por parâmetro em vez de ser buscado
     de novo — quem autentica por `X-Checkout-Key` (a troca de plano) já
     tem a linha inteira em mãos, e cada ida ao banco custou 213 ms
     medidos em 12/09/2026 (`tests/sem-consulta-repetida.js`). Sem isto,
     a troca faria duas leituras da MESMA linha.

     A guarda existe porque o atalho poderia calar a discordância: com um
     `contratante` de um lado e um `contratanteId` de outro, quem passasse
     a valer seria o objeto — o método habilitado e a `api_base_url`
     consultada seriam de OUTRO contratante, e o `contratanteId` viraria
     enfeite. Isso é um furo entre inquilinos esperando um segundo
     chamador desatento, e custa três linhas fechar agora. */
  if (jaCarregado && jaCarregado.id !== contratanteId) {
    /* SEM `.status` de propósito: isto é erro de programação, não
       validação de entrada, e `utils/erros.js` só devolve a mensagem
       crua ao cliente quando o `.status` está lá. Assim a frase fica no
       log e na tabela `erros`, e quem chamou recebe o genérico. */
    throw new Error('Contratante carregado não corresponde ao contratanteId pedido.');
  }

  const contratante = jaCarregado ?? await buscarContratante(contratanteId);
  if (!contratante) {
    const erro = new Error('Contratante não encontrado.');
    erro.status = 404;
    throw erro;
  }
  exigirMetodoHabilitado(contratante, metodoRequerido);

  const controlador = new AbortController();
  const timeoutId = setTimeout(() => controlador.abort(), TIMEOUT_MS);

  // Mesma troca do `resolverPedido` — ver a nota lá.
  let resposta;
  try {
    resposta = await puxarDoContratante(`${contratante.api_base_url}/plano/${planoId}`, {
      chave: contratante.api_key,
      signal: controlador.signal
    });
  } catch (erroFetch) {
    const erro = new Error('Não foi possível carregar os dados do plano, tente novamente.');
    erro.status = erroFetch instanceof RespostaRecusada ? 502 : 504;
    erro.cause = erroFetch;
    throw erro;
  } finally {
    clearTimeout(timeoutId);
  }

  if (resposta.status === 404) {
    const erro = new Error('Plano não encontrado.');
    erro.status = 404;
    throw erro;
  }

  if (resposta.status < 200 || resposta.status >= 300 || resposta.corpo === null) {
    const erro = new Error('Não foi possível carregar os dados do plano, tente novamente.');
    erro.status = 502;
    throw erro;
  }

  const plano = resposta.corpo;
  return { contratante, plano };
}

/* ------------------------------------------------------------------
   Autoteste — `node src/services/pedidoService.js`
   Só a parte pura (sem rede/banco): a regra de id imprevisível, que
   RECUSA requisição, e a de método habilitado.

   Precisa de um .env presente (mesmo com valores falsos): este módulo
   importa o cliente do Supabase no topo, e ele exige as variáveis pra
   ser construído — nada aqui chega a consultar o banco.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('pedidoService.js')) {
  const { strict: assertReal } = await import('node:assert');
  // Contador de verdade, não chumbado — ver a nota em
  // `utils/validadores.js`. Oito autotestes daqui tinham o número
  // escrito à mão, e três deles estavam errados.
  //
  // Envolve o `assert` num proxy para contar sem reescrever as chamadas.
  let checagens = 0;
  const assert = new Proxy(assertReal, {
    get(alvo, nome) {
      const valor = alvo[nome];
      if (typeof valor !== 'function') return valor;
      return (...argumentos) => { checagens += 1; return valor.apply(alvo, argumentos); };
    }
  });


  const recusa = (id) => {
    try { exigirIdImprevisivel(id, 'pedidoId'); return false; } catch { return true; }
  };

  // sequencial curto = enumerável = recusado
  assert.ok(recusa('1'), 'id 1');
  assert.ok(recusa('42'), 'id 42');
  assert.ok(recusa('1234567'), '7 dígitos ainda é pouco');

  // longo só de dígitos passa (timestamp, id interno grande)
  assert.ok(!recusa('12345678'), '8 dígitos passa');
  assert.ok(!recusa('1789023226000'), 'timestamp passa');

  // qualquer coisa com letra passa — não dá pra varrer
  assert.ok(!recusa('abc123'), 'alfanumérico passa');
  assert.ok(!recusa('550e8400-e29b-41d4-a716-446655440000'), 'uuid passa');
  assert.ok(!recusa('master'), 'slug passa');
  assert.ok(!recusa('PED-0001'), 'com prefixo passa');

  // vazio/nulo não é tratado aqui (a rota do Express nem casa sem o
  // parâmetro) — só não pode explodir
  assert.ok(!recusa(undefined), 'undefined não estoura');

  /* O atalho de `resolverPlano` não pode calar uma discordância entre o
     `contratante` passado e o `contratanteId` pedido: se calasse, quem
     valeria seria o objeto, e a rota trabalharia com a `api_base_url` e
     os métodos habilitados de OUTRO inquilino. */
  let recusouDivergencia = false;
  try {
    await resolverPlano('contratante-a', 'plano-x', { contratante: { id: 'contratante-b' } });
  } catch (erro) {
    recusouDivergencia = /não corresponde/.test(erro.message);
  }
  assert.ok(recusouDivergencia, 'contratante carregado de OUTRO id tem de ser recusado, não aceito em silêncio');

  /* Controle positivo: com os dois iguais, o atalho vale e a função
     segue (aqui ela falha na rede, que é depois da guarda). */
  let passouDaGuarda = false;
  try {
    await resolverPlano('contratante-a', 'plano-x', { contratante: { id: 'contratante-a', api_base_url: 'https://exemplo.test' } });
  } catch (erro) {
    passouDaGuarda = !/não corresponde/.test(erro.message);
  }
  assert.ok(passouDaGuarda, 'mesmo id passa da guarda — senão a guarda recusaria tudo');

  // método habilitado: lista ausente libera tudo (contratante antigo)
  assert.ok(metodoHabilitado({}, 'pix'), 'sem lista libera');
  assert.ok(metodoHabilitado({ metodos_habilitados: ['pix'] }, 'pix'), 'na lista libera');
  assert.ok(!metodoHabilitado({ metodos_habilitados: ['pix'] }, 'boleto'), 'fora da lista bloqueia');

  // --- Arquivar precisa parar de cobrar, não só sumir da lista ---
  /* A cláusula `.is('arquivado_em', null)` em `buscarContratante` e
     `buscarContratantePorChave` é o arquivamento inteiro: sem ela, um
     link antigo continua abrindo o checkout e gerando cobrança para um
     parceiro desligado, e a api_key dele continua autenticando estorno.
     Provar isso de verdade exigiria banco.

     O que dá para provar sem banco é que a cláusula continua lá — e é
     ela que alguém remove "para simplificar a consulta" numa
     refatoração, sem perceber que está religando a cobrança. Checagem
     grosseira, no texto-fonte, de propósito: grosseira e presente vale
     mais que elegante e inexistente. */
  const { readFileSync } = await import('node:fs');
  const fonte = readFileSync(new URL(import.meta.url), 'utf8');

  for (const nomeFuncao of ['buscarContratante', 'buscarContratantePorChave']) {
    const daDeclaracao = fonte.slice(fonte.indexOf(`export async function ${nomeFuncao}(`));
    const corpo = daDeclaracao.slice(0, daDeclaracao.indexOf('\n}'));
    assert.ok(
      corpo.includes(".is('arquivado_em', null)"),
      `${nomeFuncao} precisa recusar contratante arquivado — sem isso, arquivar vira só esconder da lista`
    );
  }

  console.log(`pedidoService: ${checagens} checagens OK`);
}
