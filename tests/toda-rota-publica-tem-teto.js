#!/usr/bin/env node
/**
 * tests/toda-rota-publica-tem-teto.js
 *
 * A skill `seguranca-san` pede limite de taxa em **toda rota pública que
 * faz trabalho** (toca banco, disco ou rede), mesmo devolvendo só um
 * `ok` — e nomeia como conferir: *"a lista de rotas limitadas se confere
 * contra a lista de rotas montadas (lição nº 23)"*.
 *
 * Isso vinha sendo conferido à mão, e à mão é assim que uma rota nova
 * nasce sem teto: quem monta a rota está pensando no que ela faz, não na
 * lista de prefixos limitados que mora em outro arquivo. Já aconteceu
 * duas vezes neste repositório em setembro — o `limitadorCriacao` ficou
 * sendo UMA instância compartilhada entre nove rotas (3ª rodada de
 * varredura, 16/09), e o limitador de criação estrangulava o polling de
 * status (1ª rodada). As duas foram achadas por leitura, não por teste.
 *
 * Aqui a conferência é automática: para cada rota montada, o caminho
 * completo tem de cair debaixo de algum prefixo com limitador. Rota nova
 * sem teto deixa a suíte vermelha no mesmo commit que a cria.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let checagens = 0;
const ok = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };
const igual = (a, b, mensagem) => { assert.deepEqual(a, b, mensagem); checagens += 1; };

const servidor = readFileSync(join(RAIZ, 'src', 'server.js'), 'utf8');

/* ------------------------------------------------------------------
   1. OS PREFIXOS QUE TÊM LIMITADOR
------------------------------------------------------------------ */

const PREFIXOS_LIMITADOS = [...servidor.matchAll(
  /app\.use\('(\/api\/[^']+)',\s*(?:criarLimitador\w+\(\)|rateLimit\()/g
)].map((m) => m[1]);

ok(PREFIXOS_LIMITADOS.length > 0, 'controle positivo: a varredura achou prefixos com limitador');

/* ------------------------------------------------------------------
   2. AS ROTAS MONTADAS

   `app.use('/api/checkout', rotasPedido)` + `router.get('/pedido/:a/:b')`
   = `/api/checkout/pedido/:a/:b`. As duas metades moram em arquivos
   diferentes, e é essa separação que faz a conferência à mão falhar.
------------------------------------------------------------------ */

const IMPORTES = Object.fromEntries(
  [...servidor.matchAll(/import\s+(\w+)\s+from\s+'\.\/routes\/(\w+)\.js'/g)].map((m) => [m[1], m[2]])
);
ok(Object.keys(IMPORTES).length > 0, 'controle positivo: a varredura achou os routers importados');

const MONTAGENS = [...servidor.matchAll(/app\.use\('(\/api[^']*)',\s*(\w+)\)/g)]
  .filter(([, , variavel]) => IMPORTES[variavel])
  .map(([, base, variavel]) => ({ base, arquivo: IMPORTES[variavel] }));

ok(MONTAGENS.length > 0, 'controle positivo: a varredura achou os routers montados');

/* DUAS FORMAS DE TER TETO, e a varredura precisa ver as duas.

   A primeira versão desta suíte só olhava os prefixos do `server.js` e
   acusou quatro rotas de Pix/Boleto que estão protegidas — elas montam o
   limitador POR ROTA, dentro do router, de propósito: cada uma tem uma
   criação (10/min, contra força bruta) e um polling (o front reconsulta a
   cada 3 s), e um prefixo único casaria as duas com o teto de criação,
   que o próprio polling esgotava em ~30 s.

   Um guarda que acusa o que está certo é pior que guarda nenhum: ele é
   desligado na primeira vez que atrapalha. A varredura foi corrigida; o
   código, não. */
const rotas = [];
for (const { base, arquivo } of MONTAGENS) {
  const fonte = readFileSync(join(RAIZ, 'src', 'routes', `${arquivo}.js`), 'utf8');
  /* Por LINHA, não por regex de argumentos: tentar recortar a lista de
     argumentos com `[^)]*` para no primeiro `)`, que é justamente o de
     `criarLimitadorCriacao()` — a primeira versão disto não reconhecia
     nenhum limitador por rota. Neste repositório cada rota é uma linha,
     então a linha é o recorte certo e é estável. */
  const declaradas = fonte.split('\n')
    .map((linha) => ({ linha, casou: /router\.(get|post|patch|put|delete)\('([^']+)'/.exec(linha) }))
    .filter(({ casou }) => casou);

  ok(declaradas.length > 0, `${arquivo}.js declara rota (controle positivo: a regex ainda casa)`);

  for (const { linha, casou } of declaradas) {
    rotas.push({
      metodo: casou[1].toUpperCase(),
      caminho: `${base}${casou[2]}`.replace(/\/$/, ''),
      // Limitador montado na própria linha da rota.
      tetoNaRota: /criarLimitador\w+\(\)|rateLimit\(/.test(linha),
      arquivo
    });
  }
}

ok(
  rotas.some((r) => r.tetoNaRota),
  'controle positivo: a varredura reconhece limitador montado POR ROTA (senão acusaria Pix e Boleto, que estão certos)'
);
ok(
  rotas.some((r) => !r.tetoNaRota),
  'controle positivo: e também reconhece rota SEM limitador na linha (senão aprovaria tudo)'
);

/* As rotas declaradas direto no `server.js` (hoje, `/api/saude`) contam
   igual — e esquecê-las seria o mesmo furo por outra porta. */
for (const [, metodo, caminho] of servidor.matchAll(/app\.(get|post|patch|put|delete)\('(\/api[^']+)'/g)) {
  rotas.push({ metodo: metodo.toUpperCase(), caminho });
}

ok(rotas.length >= 15, `controle positivo: a varredura achou as rotas (achou ${rotas.length})`);

/* ------------------------------------------------------------------
   3. CADA ROTA CAI DEBAIXO DE UM PREFIXO LIMITADO
------------------------------------------------------------------ */

function limitadorDe(caminho) {
  // O mais ESPECÍFICO primeiro, só para o relatório ficar legível — o
  // Express roda todos os que casam, e o mais apertado é que barra.
  return [...PREFIXOS_LIMITADOS]
    .sort((a, b) => b.length - a.length)
    .find((prefixo) => caminho === prefixo || caminho.startsWith(`${prefixo}/`));
}

const semTeto = rotas.filter((r) => !r.tetoNaRota && !limitadorDe(r.caminho));

igual(
  semTeto.map((r) => `${r.metodo} ${r.caminho}`), [],
  'rota pública montada sem nenhum limitador de taxa acima dela (lição nº 23 da seguranca-san)'
);

/* ------------------------------------------------------------------
   4. E O CONTRÁRIO: PREFIXO LIMITADO QUE NÃO PROTEGE ROTA NENHUMA

   Prefixo escrito errado — um `/api/checkout/cartoes` no lugar de
   `/cartao` — não dá erro, não aparece em log, e deixa a rota sem teto
   parecendo protegida. É o modo de falhar mais caro desta lista, porque
   passa por revisão de olho.
------------------------------------------------------------------ */

const orfaos = PREFIXOS_LIMITADOS.filter(
  (prefixo) => !rotas.some((r) => r.caminho === prefixo || r.caminho.startsWith(`${prefixo}/`))
);
ok(true, 'órfãos calculados sobre a lista completa de rotas');
igual(
  orfaos, [],
  'prefixo com limitador que não cobre rota nenhuma — provavelmente escrito errado, e a rota de verdade está sem teto'
);

/* ------------------------------------------------------------------
   5. O TETO DE LOGIN CONTINUA SENDO O MAIS APERTADO

   É a única rota onde a senha é conferida, e cada conferência custa
   ~830 ms de scrypt: sem teto apertado, adivinhar senha é também negação
   de serviço de graça. O número em si é exercitado por HTTP em
   `rotas-http-respondem-como-prometido.js`; aqui se trava que ele é o
   MENOR de todos.
------------------------------------------------------------------ */

const tetos = [...servidor.matchAll(/app\.use\('(\/api\/[^']+)',\s*rateLimit\(\{[^}]*?max:\s*(\d+)/gs)]
  .map((m) => ({ prefixo: m[1], max: Number(m[2]) }));

ok(tetos.length > 0, 'controle positivo: achou os tetos declarados direto no server.js');

const login = tetos.find((t) => t.prefixo === '/api/admin/sessao');
ok(login, 'a rota de sessão do admin tem teto próprio');
for (const outro of tetos) {
  if (outro.prefixo === login.prefixo) continue;
  ok(
    login.max <= outro.max,
    `o teto do login (${login.max}) não pode ser mais largo que o de ${outro.prefixo} (${outro.max})`
  );
}

console.log(`toda-rota-publica-tem-teto: ${checagens} checagens OK (${rotas.length} rotas, ${PREFIXOS_LIMITADOS.length} prefixos)`);
