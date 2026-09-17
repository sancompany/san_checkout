/**
 * SAN CHECKOUT v2 — src/utils/retornoSeguro.js
 *
 * Decide se o `returnUrl` que veio na URL do checkout pode receber o
 * comprador depois do pagamento.
 *
 * ── Por que isto existe, e por que é rígido ────────────────────────
 *
 * `returnUrl` é o vetor clássico de OPEN REDIRECT. O parâmetro vem da
 * barra de endereço, ou seja: de quem montou o link, que não é
 * necessariamente o contratante. Um checkout que redireciona para
 * qualquer endereço vira lavanderia de phishing —
 *
 *     https://checkout.sancocore.com.br/?c=loja&pedido=…&returnUrl=https://golpe.tld
 *
 * — com o domínio confiável na frente, o cadeado certo, e o destino
 * escolhido pelo atacante. O comprador (e o filtro de e-mail dele) vê o
 * nosso domínio; quem recebe é outro. O dano não é nosso servidor: é a
 * reputação do domínio que cobra dinheiro.
 *
 * ── A regra ────────────────────────────────────────────────────────
 *
 * O destino só é honrado se a ORIGEM dele estiver na lista do próprio
 * contratante daquele checkout:
 *
 *   1. a origem de `api_base_url` — sempre permitida, e de graça: é o
 *      endereço que já recebe a `X-Checkout-Key` dele a cada resolução
 *      de pedido. Mandar o comprador para lá não concede confiança
 *      nenhuma que já não estivesse concedida;
 *   2. mais o que estiver em `retorno_dominios` (migration 0005),
 *      cadastrado no admin. Existe porque o caso comum é a API viver em
 *      `api.loja.com.br` e a vitrine em `www.loja.com.br` — exigir host
 *      idêntico quebraria o uso real e empurraria o integrador para
 *      alguma gambiarra pior.
 *
 * ── Como a comparação é feita, e por que assim ──────────────────────
 *
 * Por `URL.origin` do WHATWG, nunca por texto. Toda a família de
 * bypasses de open redirect é feita para enganar comparação textual:
 *
 *   endsWith('loja.com')      ← https://loja.com.golpe.tld
 *   startsWith('https://loja.com') ← https://loja.com.golpe.tld
 *   includes('loja.com')      ← https://golpe.tld/?volta=https://loja.com
 *                               https://golpe.tld#https://loja.com
 *   host cru                  ← https://loja.com@golpe.tld  (host é golpe.tld)
 *   split('/')[2]             ← https:/\golpe.tld  (a barra invertida
 *                               vira barra em esquema especial)
 *
 * `origin` é `protocolo + host + porta` já normalizado pelo parser:
 * maiúscula vira minúscula, IDN vira punycode, porta default some,
 * userinfo não entra. Comparar isso com `Set.has` não tem borda solta —
 * e o que sai daqui é RE-SERIALIZADO a partir do objeto parseado, nunca
 * o texto que entrou, porque normalizar é o passo que mata contrabando.
 *
 * ── O que isto NÃO protege ──────────────────────────────────────────
 *
 * Contratante que cadastrar um domínio hostil em `retorno_dominios`
 * redireciona para lá. Isso não é open redirect: é parte confiável
 * abusando do próprio cadastro — ele já recebe dinheiro, já tem
 * `api_key`, e o cadastro é feito pelo dono no admin. A fronteira de
 * confiança é o cadastro, e ela é a mesma de `webhook_url`.
 */

import { alvoDeRedeSeguro } from './alvoDeRede.js';

/**
 * Teto de tamanho. Não há destino legítimo de 2 KB, e sem teto isto
 * seria um texto sem limite indo parar num `href` e num `location`.
 */
const LIMITE_TAMANHO = 2048;

/**
 * A origem de um endereço cadastrado, ou null se ele não servir como
 * destino. Passa pelo `alvoDeRedeSeguro` — o mesmo guarda de
 * `api_base_url`/`webhook_url` — então exige https e host público, e
 * recusa `javascript:`, `data:`, `file:`, http em claro e host interno.
 *
 * O caminho é DESCARTADO de propósito: a lista é de origens, não de
 * páginas. Cadastrar `https://loja.com.br/obrigado` permite a origem
 * `https://loja.com.br` inteira — está escrito no API.md assim.
 */
export function origemPermitida(valor) {
  const texto = String(valor ?? '');
  if (!texto || texto.length > LIMITE_TAMANHO) return null;
  if (!alvoDeRedeSeguro(texto)) return null;
  try {
    return new URL(texto).origin;
  } catch {
    return null;
  }
}

/**
 * Monta o conjunto de origens que este contratante pode receber de
 * volta. `api_base_url` entra sempre; `retorno_dominios` acrescenta.
 *
 * @param {{ api_base_url?: string, retorno_dominios?: string[] }} contratante
 * @returns {Set<string>} origens normalizadas
 */
export function origensDeRetorno(contratante) {
  const permitidas = new Set();

  const daApi = origemPermitida(contratante?.api_base_url);
  if (daApi) permitidas.add(daApi);

  const extras = contratante?.retorno_dominios;
  if (Array.isArray(extras)) {
    for (const entrada of extras) {
      const origem = origemPermitida(entrada);
      if (origem) permitidas.add(origem);
    }
  }

  return permitidas;
}

/**
 * O destino aprovado, ou null.
 *
 * null é resposta normal, não erro: link sem `returnUrl`, ou com um
 * destino de fora da lista, continua sendo um checkout que funciona —
 * só não oferece o botão de voltar. Recusar a compra porque o parâmetro
 * decorativo está errado seria transformar um detalhe de navegação em
 * falha de pagamento.
 *
 * @param {string} valor — o `returnUrl` cru, como veio da barra de endereço
 * @param {object} contratante — a linha do contratante daquele checkout
 * @param {{ pedidoId?: string }} [contexto] — o que anexar ao destino
 * @returns {string|null} URL absoluta https, normalizada, ou null
 */
export function retornoSeguro(valor, contratante, { pedidoId } = {}) {
  const texto = String(valor ?? '');
  if (!texto || texto.length > LIMITE_TAMANHO) return null;

  let url;
  try {
    url = new URL(texto);
  } catch {
    return null; // relativo, `//host` sem esquema, ou lixo
  }

  // https + host público. Mata javascript:, data:, file:, http: e host
  // interno antes de qualquer comparação.
  if (!alvoDeRedeSeguro(url.href)) return null;

  // `https://loja.com.br@golpe.tld` já cairia na comparação de origem
  // (o host ali é `golpe.tld`), mas userinfo num destino de navegação só
  // serve para confundir quem lê a barra de endereço. Não há uso
  // legítimo: recusa direto.
  if (url.username || url.password) return null;

  if (!origensDeRetorno(contratante).has(url.origin)) return null;

  // O id do pedido vai junto para o contratante saber em qual pedido
  // aterrissar. Só o id — NUNCA o status. Query string é escrita por
  // quem quiser: `?status=pago` no endereço faria o integrador
  // desavisado dar por paga uma compra que ninguém pagou. Quem diz se
  // pagou é o webhook assinado ou a consulta autenticada (API.md §5).
  if (pedidoId) url.searchParams.set('pedido', String(pedidoId));

  // Re-serializado a partir do parseado — nunca o texto de entrada.
  return url.toString();
}

/* ====================================================================
   AUTOTESTE — `node src/utils/retornoSeguro.js`
   Roda junto com os outros em `npm test` (tests/executar.js).

   Os casos negativos aqui são a suíte de ataque de open redirect: cada
   um é um bypass real, que funciona contra uma comparação textual.
   ==================================================================== */
if (process.argv[1]?.endsWith('retornoSeguro.js')) {
  const assertReal = (await import('node:assert/strict')).default;
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


  const LOJA = {
    api_base_url: 'https://api.loja.com.br',
    retorno_dominios: ['https://www.loja.com.br', 'https://loja.com.br']
  };

  const ok = (valor, contratante = LOJA) => retornoSeguro(valor, contratante) !== null;

  /* ---------- o caso feliz ---------- */
  assert.ok(ok('https://www.loja.com.br/obrigado'), 'domínio cadastrado passa');
  assert.ok(ok('https://loja.com.br/pedido/123'), 'apex cadastrado passa');
  assert.ok(ok('https://api.loja.com.br/volta'), 'origem da api_base_url passa de graça');
  assert.ok(ok('https://www.loja.com.br/ok?a=1&b=2#secao'), 'query e fragmento preservados');
  assert.ok(ok('https://www.loja.com.br'), 'origem nua, sem caminho, passa');

  /* ---------- OPEN REDIRECT: os bypasses clássicos ---------- */
  assert.ok(!ok('https://golpe.tld'), 'domínio de fora recusa');
  assert.ok(!ok('https://loja.com.br.golpe.tld'), 'sufixo colado (fura endsWith) recusa');
  assert.ok(!ok('https://golpe.tld/?volta=https://www.loja.com.br'), 'domínio na query (fura includes) recusa');
  assert.ok(!ok('https://golpe.tld#https://www.loja.com.br'), 'domínio no fragmento (fura includes) recusa');
  assert.ok(!ok('https://www.loja.com.br@golpe.tld'), 'userinfo disfarçando host (fura leitura humana) recusa');
  assert.ok(!ok('https://www.loja.com.br:senha@golpe.tld/'), 'userinfo com senha recusa');
  assert.ok(!ok('https:/\\golpe.tld'), 'barra invertida (fura split) recusa');
  assert.ok(!ok('//golpe.tld'), 'protocolo-relativo recusa');
  assert.ok(!ok('/caminho/interno'), 'caminho relativo recusa');
  assert.ok(!ok('https://wwwXloja.com.br'), 'host parecido recusa');
  assert.ok(!ok('https://www.loja.com.br.evil/'), 'TLD trocado recusa');

  /* ---------- esquema: nada que execute, nada em claro ---------- */
  assert.ok(!ok('javascript:alert(document.cookie)'), 'javascript: recusa');
  assert.ok(!ok('JaVaScRiPt:alert(1)'), 'javascript: com caixa trocada recusa');
  assert.ok(!ok('data:text/html,<script>alert(1)</script>'), 'data: recusa');
  assert.ok(!ok('file:///etc/passwd'), 'file: recusa');
  assert.ok(!ok('http://www.loja.com.br/obrigado'), 'http em claro recusa mesmo com host certo');

  /* ---------- porta e caixa: normalização do parser ---------- */
  assert.ok(ok('https://WWW.LOJA.COM.BR/obrigado'), 'host em maiúscula normaliza e passa');
  assert.ok(ok('https://www.loja.com.br:443/x'), 'porta 443 explícita é a default, passa');
  assert.ok(!ok('https://www.loja.com.br:8443/x'), 'porta diferente é outra origem, recusa');

  /* ---------- host interno, mesmo se alguém cadastrar ---------- */
  assert.ok(!ok('https://localhost/volta', { api_base_url: 'https://localhost' }), 'localhost recusa');
  assert.ok(
    !ok('https://169.254.169.254/', { api_base_url: 'https://169.254.169.254' }),
    'metadata da nuvem recusa'
  );

  /* ---------- lixo e ausência ---------- */
  assert.ok(!ok(''), 'vazio recusa');
  assert.ok(!ok(null), 'nulo recusa');
  assert.ok(!ok(undefined), 'indefinido recusa');
  assert.ok(!ok('não é url'), 'texto solto recusa');
  assert.ok(!ok(`https://www.loja.com.br/${'a'.repeat(3000)}`), 'acima do teto de tamanho recusa');

  /* ---------- contratante sem nada cadastrado não aceita retorno ---------- */
  assert.ok(!ok('https://www.loja.com.br/x', {}), 'contratante sem cadastro recusa tudo');
  assert.ok(!ok('https://www.loja.com.br/x', { retorno_dominios: 'não é array' }), 'lista malformada recusa');
  assert.ok(
    !ok('https://www.loja.com.br/x', { api_base_url: 'http://api.loja.com.br' }),
    'api_base_url em http não vira origem permitida'
  );

  /* ---------- o id do pedido vai junto; o status NÃO ---------- */
  const comPedido = retornoSeguro('https://www.loja.com.br/obrigado', LOJA, { pedidoId: 'ped_abc123' });
  assert.equal(comPedido, 'https://www.loja.com.br/obrigado?pedido=ped_abc123', 'anexa o id do pedido');
  assert.ok(!/status/.test(comPedido), 'NUNCA anexa status — query string não prova pagamento');

  const jaTinhaPedido = retornoSeguro('https://www.loja.com.br/ok?pedido=antigo', LOJA, { pedidoId: 'novo' });
  assert.equal(jaTinhaPedido, 'https://www.loja.com.br/ok?pedido=novo', 'sobrescreve pedido já existente');

  const pedidoHostil = retornoSeguro('https://www.loja.com.br/ok', LOJA, { pedidoId: 'a&b=c#d' });
  assert.equal(
    pedidoHostil,
    'https://www.loja.com.br/ok?pedido=a%26b%3Dc%23d',
    'id do pedido é escapado, não injeta parâmetro nem fragmento'
  );

  /* ---------- bytes de controle: normalizar é sanear ----------
     CR, LF e TAB no meio da URL são a tentativa de contrabandear
     cabeçalho ou partir o host. O parser do WHATWG os REMOVE ao
     parsear, e o que devolvemos é o objeto re-serializado — então o
     valor saneado é o que sai, e nenhum byte de controle sobrevive.
     É por isso que devolver `url.toString()` e não o texto de entrada
     é regra, e não estilo. */
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const TAB = String.fromCharCode(9);

  const semControle = (valor) => {
    const saida = retornoSeguro(valor, LOJA);
    if (saida === null) return true; // recusado também serve
    return ![...saida].some((c) => c === CR || c === LF || c === TAB);
  };

  assert.ok(semControle(`https://www.loja.com.br/${CR}${LF}Set-Cookie: x=1`), 'CRLF no caminho não sobrevive');
  assert.ok(semControle(`https://www.loja.com.br/a${CR}b`), 'CR isolado não sobrevive');
  assert.ok(semControle(`https://www.loja.com.br/a${LF}b`), 'LF isolado não sobrevive');

  // Host partido por CRLF vira outro host — e outro host é outra origem.
  assert.ok(!ok(`https://www.loja.com.br${CR}${LF}.golpe.tld/`), 'CRLF partindo o host recusa');
  assert.ok(!ok(`https://www.loja.com.br${TAB}@golpe.tld/`), 'TAB antes de userinfo recusa');

  /* ---------- a saída é sempre re-serializada ---------- */
  assert.equal(
    retornoSeguro('https://WWW.LOJA.COM.BR:443/a/../b', LOJA),
    'https://www.loja.com.br/b',
    'saída normalizada, não o texto de entrada'
  );

  /* ---------- origensDeRetorno ---------- */
  assert.equal(origensDeRetorno(LOJA).size, 3, 'três origens distintas');
  assert.equal(origensDeRetorno({}).size, 0, 'contratante vazio não tem origem');
  assert.equal(
    origensDeRetorno({ api_base_url: 'https://api.loja.com.br/v1/base' }).size,
    1,
    'caminho da api_base_url some, sobra a origem'
  );

  console.log(`retornoSeguro: ${checagens} checagens OK`);
}
