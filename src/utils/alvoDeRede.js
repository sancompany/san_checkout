/**
 * SAN CHECKOUT v2 — src/utils/alvoDeRede.js
 *
 * Um endereço só é aceito como alvo de requisição de saída do checkout
 * (api_base_url e webhook_url de contratante) se for seguro nos dois
 * sentidos que importam aqui:
 *
 *   1. HTTPS obrigatório. O backend manda a `X-Checkout-Key` do
 *      contratante no header ao resolver pedido/plano
 *      (`pedidoService.js`) e assina a notificação com a mesma chave
 *      (`webhookController.js`). Sobre `http://`, essa chave — o segredo
 *      que autentica consulta e ESTORNO — viaja em claro. `urlValida`
 *      antiga aceitava http, então cadastrar um contratante com base
 *      `http://…` vazava a chave dele em toda ida à API.
 *
 *   2. Sem host interno. O alvo é resolvido pelo servidor, dentro da
 *      rede do provedor. Um endereço apontando para `169.254.169.254`
 *      (metadata da nuvem), `localhost`, ou faixa privada faz o checkout
 *      buscar recurso interno e devolver o corpo pro chamador — SSRF. O
 *      cadastro é do admin, então isto é defesa em profundidade: fecha o
 *      vetor se a credencial de admin um dia vazar, e recusa o engano
 *      honesto de apontar para um serviço interno.
 *
 * Bloqueio por LITERAL de IP e por nome óbvio, não por resolução de DNS:
 * resolver aqui abriria porta para DNS rebinding e travaria o cadastro
 * numa consulta de rede. O alvo verdadeiro precisa ser público de
 * qualquer forma; o que esta função recusa é o que nunca deveria ser
 * cadastrado.
 */

/** IPv4 em faixa privada, loopback, link-local ou reservada. */
function ipv4Interno(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return true; // malformado: recusa
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 127) return true;                         // loopback
  if (a === 0) return true;                           // 0.0.0.0/8
  if (a === 169 && b === 254) return true;            // link-local + metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT)
  return false;
}

/** IPv6 loopback, ULA (fc00::/7) ou link-local (fe80::/10). Aceita a
 *  forma com colchetes que a URL usa (`[::1]`) — o hostname do WHATWG já
 *  vem sem eles, mas guardamos contra as duas. */
function ipv6Interno(host) {
  const h = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;      // fc00::/7 (ULA)
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;      // fe80::/10 (link-local)
  return false;
}

function hostInterno(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === 'metadata' || host === 'metadata.google.internal') return true;
  if (ipv4Interno(host)) return true;
  if (ipv6Interno(host)) return true;
  return false;
}

/**
 * @returns {boolean} true só quando `valor` é uma URL https com host
 * público — o único tipo de endereço que pode receber a chave de um
 * contratante e ser buscado pelo servidor com segurança.
 */
export function alvoDeRedeSeguro(valor) {
  let url;
  try {
    url = new URL(String(valor ?? ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (hostInterno(url.hostname)) return false;
  return true;
}

/* ====================================================================
   AUTOTESTE — `node src/utils/alvoDeRede.js`
   Roda junto com os outros em `npm test` (tests/executar.js).
   ==================================================================== */
if (process.argv[1]?.endsWith('alvoDeRede.js')) {
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


  // --- público https passa ---
  assert.ok(alvoDeRedeSeguro('https://contratante-teste.brunosanches-bhs.workers.dev'), 'worker público passa');
  assert.ok(alvoDeRedeSeguro('https://api.parceiro.com.br/checkout'), 'domínio público com caminho passa');
  assert.ok(alvoDeRedeSeguro('https://198.51.100.7'), 'IP público literal passa');

  // --- http recusa (a chave viajaria em claro) ---
  assert.ok(!alvoDeRedeSeguro('http://api.parceiro.com.br'), 'http recusa');
  assert.ok(!alvoDeRedeSeguro('ftp://x.com'), 'esquema exótico recusa');
  assert.ok(!alvoDeRedeSeguro('file:///etc/passwd'), 'file recusa');

  // --- host interno recusa (SSRF) ---
  assert.ok(!alvoDeRedeSeguro('https://169.254.169.254/latest/meta-data/'), 'metadata da nuvem recusa');
  assert.ok(!alvoDeRedeSeguro('https://metadata.google.internal/'), 'metadata por nome recusa');
  assert.ok(!alvoDeRedeSeguro('https://localhost:3001/pedido'), 'localhost recusa');
  assert.ok(!alvoDeRedeSeguro('https://127.0.0.1'), 'loopback recusa');
  assert.ok(!alvoDeRedeSeguro('https://10.0.0.5'), '10/8 recusa');
  assert.ok(!alvoDeRedeSeguro('https://172.16.0.9'), '172.16/12 recusa');
  assert.ok(!alvoDeRedeSeguro('https://192.168.1.1'), '192.168/16 recusa');
  assert.ok(!alvoDeRedeSeguro('https://100.64.0.1'), 'CGNAT recusa');
  assert.ok(!alvoDeRedeSeguro('https://[::1]/'), 'IPv6 loopback recusa');
  assert.ok(!alvoDeRedeSeguro('https://[fd00::1]/'), 'IPv6 ULA recusa');
  assert.ok(!alvoDeRedeSeguro('https://caixa.interno.local/'), '.local recusa');
  assert.ok(!alvoDeRedeSeguro('https://servico.internal/'), '.internal recusa');

  // 172.32 não é interno (só 16–31): é público, passa.
  assert.ok(alvoDeRedeSeguro('https://172.32.0.9'), '172.32 é público, passa');

  // --- lixo recusa ---
  assert.ok(!alvoDeRedeSeguro(''), 'vazio recusa');
  assert.ok(!alvoDeRedeSeguro(null), 'nulo recusa');
  assert.ok(!alvoDeRedeSeguro('não é url'), 'texto solto recusa');

  console.log(`alvoDeRede: ${checagens} checagens OK`);
}
