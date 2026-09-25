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

/** IPv4 em faixa privada, loopback, link-local ou reservada.
 *
 *  Desde 25/09/2026 (SEC-021) inclui as faixas RESERVADAS que não são
 *  internet de ninguém — documentação (TEST-NET-1/2/3), benchmarking
 *  (198.18/15), atribuições do IETF (192.0.0/24), multicast (224/4), o
 *  bloco reservado 240/4 e o broadcast. Nenhum contratante tem API
 *  nelas; aceitar é deixar o filtro com buraco para quem procura um. */
function ipv4Interno(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (a > 255 || b > 255 || c > 255 || Number(m[4]) > 255) return true; // malformado: recusa
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 127) return true;                         // loopback
  if (a === 0) return true;                           // 0.0.0.0/8
  if (a === 169 && b === 254) return true;            // link-local + metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT)
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24 (IETF), 192.0.2.0/24 (TEST-NET-1)
  if (a === 198 && (b === 18 || b === 19)) return true;          // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && c === 100) return true;           // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;            // TEST-NET-3
  if (a >= 224) return true;                                     // multicast, 240/4 reservado, broadcast
  return false;
}

/** As oito palavras de 16 bits de um IPv6 — com `::` expandido e um IPv4
 *  embutido no fim convertido. `null` quando não é IPv6. */
function palavrasIpv6(texto) {
  let h = texto;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const n = v4.slice(1).map(Number);
    if (n.some((x) => x > 255)) return null;
    h = `${h.slice(0, v4.index)}${((n[0] << 8) | n[1]).toString(16)}:${((n[2] << 8) | n[3]).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(h) || !h.includes(':')) return null;
  const partes = h.split('::');
  if (partes.length > 2) return null;
  const esquerda = partes[0] ? partes[0].split(':') : [];
  const direita = partes.length === 2 && partes[1] ? partes[1].split(':') : [];
  const faltam = 8 - esquerda.length - direita.length;
  if (partes.length === 1 ? esquerda.length !== 8 : faltam < 1) return null;
  const todas = [...esquerda, ...Array(partes.length === 2 ? faltam : 0).fill('0'), ...direita];
  if (todas.length !== 8 || todas.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  return todas.map((p) => parseInt(p, 16));
}

const ipv4DePalavras = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** IPv6 loopback, não especificado, ULA, link-local, multicast,
 *  documentação — e, desde 25/09/2026 (SEC-021), todo IPv6 que CARREGA um
 *  IPv4 dentro (mapeado `::ffff:a.b.c.d`, compatível `::a.b.c.d`, NAT64
 *  `64:ff9b::/96`, 6to4 `2002::/16`) é julgado pelo IPv4 que carrega. O
 *  parser da URL reescreve `[::ffff:127.0.0.1]` como `[::ffff:7f00:1]`,
 *  então a checagem por texto não o via. */
function ipv6Interno(host) {
  const h = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  const w = palavrasIpv6(h);
  if (!w) return /:/.test(h); // parece IPv6 e não parseia: recusa
  const zeros = (ate) => w.slice(0, ate).every((x) => x === 0);
  if (zeros(8)) return true;                                   // ::
  if (zeros(7) && w[7] === 1) return true;                     // ::1
  if ((w[0] & 0xfe00) === 0xfc00) return true;                 // fc00::/7 (ULA)
  if ((w[0] & 0xffc0) === 0xfe80) return true;                 // fe80::/10 (link-local)
  if ((w[0] & 0xff00) === 0xff00) return true;                 // ff00::/8 (multicast)
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true;         // 2001:db8::/32 (documentação)
  if (w[0] === 0x2001 && w[1] === 0x0000) return true;         // 2001::/32 (Teredo)
  if (w[0] === 0x0064 && w[1] === 0xff9b && w[2] === 0x0001) return true; // 64:ff9b:1::/48 (NAT64 local)
  if (zeros(5) && w[5] === 0xffff) return ipv4Interno(ipv4DePalavras(w[6], w[7])); // ::ffff:a.b.c.d
  if (zeros(6)) return ipv4Interno(ipv4DePalavras(w[6], w[7]));                    // ::a.b.c.d
  if (w[0] === 0x0064 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) {  // 64:ff9b::a.b.c.d
    return ipv4Interno(ipv4DePalavras(w[6], w[7]));
  }
  if (w[0] === 0x2002) return ipv4Interno(ipv4DePalavras(w[1], w[2]));             // 2002:aabb:ccdd::
  return false;
}

function hostInterno(hostname) {
  /* Ponto final é o mesmo nome (`localhost.` é `localhost` no DNS) — e o
     parser da URL o preserva, então ele passava por fora de toda regra de
     sufixo (SEC-021). */
  const host = String(hostname ?? '').toLowerCase().replace(/\.+$/, '');
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
 *
 * URL com credencial (`https://usuario:senha@host`) é recusada desde
 * 25/09/2026 (SEC-021): quem manda a nossa chave para um endereço não
 * manda também uma senha que veio no cadastro.
 */
export function alvoDeRedeSeguro(valor) {
  let url;
  try {
    url = new URL(String(valor ?? ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
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
  assert.ok(alvoDeRedeSeguro('https://8.8.8.8'), 'IP público literal passa');
  assert.ok(alvoDeRedeSeguro('https://[2606:4700:4700::1111]/'), 'IPv6 público literal passa');
  assert.ok(alvoDeRedeSeguro('https://api.parceiro.com.br:8443/hook'), 'porta não padrão num host público passa');

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

  /* --- SEC-021 (25/09/2026): as formas que passavam por fora ---
     Cada uma é o que o parser da URL ENTREGA em `hostname` — medido. */
  for (const [url, nome] of [
    ['https://[::ffff:127.0.0.1]/', 'IPv4 mapeado em IPv6 (vira [::ffff:7f00:1])'],
    ['https://[::ffff:169.254.169.254]/', 'metadata mapeada em IPv6'],
    ['https://[::ffff:a9fe:a9fe]/', 'metadata mapeada, já em hextets'],
    ['https://[::127.0.0.1]/', 'IPv4 compatível em IPv6'],
    ['https://[64:ff9b::a00:1]/', 'NAT64 carregando 10.0.0.1'],
    ['https://[64:ff9b:1::1]/', 'NAT64 de uso local'],
    ['https://[2002:a00:1::1]/', '6to4 carregando 10.0.0.1'],
    ['https://[ff02::1]/', 'IPv6 multicast'],
    ['https://[2001:db8::1]/', 'IPv6 de documentação'],
    ['https://[2001:0:4136:e378::1]/', 'Teredo'],
    ['https://[::]/', 'IPv6 não especificado'],
    ['https://localhost./', 'localhost com ponto final'],
    ['https://caixa.interno.local./', '.local com ponto final'],
    ['https://servico.internal./', '.internal com ponto final'],
    ['https://2130706433/', 'loopback em decimal (o parser o reescreve)'],
    ['https://0x7f.1/', 'loopback em hexa curto'],
    ['https://198.18.0.1/', 'benchmarking 198.18/15'],
    ['https://192.0.2.10/', 'TEST-NET-1'],
    ['https://198.51.100.7/', 'TEST-NET-2'],
    ['https://203.0.113.9/', 'TEST-NET-3'],
    ['https://192.0.0.8/', 'IETF 192.0.0/24'],
    ['https://224.0.0.1/', 'multicast IPv4'],
    ['https://240.0.0.1/', 'reservado 240/4'],
    ['https://255.255.255.255/', 'broadcast'],
    ['https://usuario:senha@api.parceiro.com.br/', 'credencial na URL'],
    ['https://usuario@api.parceiro.com.br/', 'usuário na URL']
  ]) {
    assert.ok(!alvoDeRedeSeguro(url), `recusa ${nome}`);
  }
  assert.ok(alvoDeRedeSeguro('https://[::ffff:8.8.8.8]/'), 'mapeado de IPv4 PÚBLICO passa — o critério é o IPv4 que ele carrega');
  assert.ok(alvoDeRedeSeguro('https://[2002:808:808::1]/'), '6to4 de IPv4 público passa');

  // 172.32 não é interno (só 16–31): é público, passa.
  assert.ok(alvoDeRedeSeguro('https://172.32.0.9'), '172.32 é público, passa');

  // --- lixo recusa ---
  assert.ok(!alvoDeRedeSeguro(''), 'vazio recusa');
  assert.ok(!alvoDeRedeSeguro(null), 'nulo recusa');
  assert.ok(!alvoDeRedeSeguro('não é url'), 'texto solto recusa');

  console.log(`alvoDeRede: ${checagens} checagens OK`);
}
