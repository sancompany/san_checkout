#!/usr/bin/env node
/**
 * SAN CHECKOUT — scripts/acessibilidade.mjs
 *
 * Roda o axe-core (WCAG 2.2 AA) contra as telas, num Chromium de
 * verdade, e falha com código 1 se achar violação.
 *
 * ── Por que navegador de verdade, e não jsdom ───────────────────────
 * Contraste é um dos itens que a lei exige nominalmente, e contraste só
 * se calcula com layout e cor computada. Em jsdom o axe simplesmente
 * não roda essa checagem — e um verificador que silenciosamente pula o
 * item exigido é pior que nenhum, porque devolve "sem violações".
 *
 * ── A obrigação ─────────────────────────────────────────────────────
 * LBI (Lei 13.146/2015, art. 63) + Decreto 9.405/2018: acessibilidade é
 * obrigação legal para site de empresa com sede no país, **inclusive
 * ME, EPP e MEI**. Padrão exigível: WCAG 2.2 AA. Não há multa
 * administrativa própria; o risco é ação civil pública e individual.
 * A skill `legal` cobra isto na estação 6.
 *
 * ── O que ele NÃO substitui ─────────────────────────────────────────
 * Verificador automático pega a maior parte, não tudo. Fora do alcance
 * dele: ordem de foco que faz sentido, texto alternativo que descreve a
 * imagem certa, e "nada informado só por cor" quando a cor vem com um
 * rótulo que o axe não sabe ler. Esses ficam na revisão humana, e o que
 * foi conferido à mão está em `docs/funcional.md` §11.
 *
 * Uso:  npm run acessibilidade
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLICO = join(RAIZ, 'public');

/** As telas do COMPRADOR primeiro — é quem não escolheu estar aqui e
 *  não tem alternativa se a tela não funcionar. O painel é do operador,
 *  e entra depois porque a obrigação vale para ele também (Lei 5). */
/* `PEDIDO_DUBLE` é a resposta de `GET /api/checkout/pedido/:c/:id`, com
   o formato real de `pedidoController` (contratanteNome,
   metodosHabilitados, pedido, taxa, retornoUrl).

   Precisa existir porque SEM ELE não há o que auditar: medido em
   17/09, o checkout sem parâmetros troca a página inteira por "Acesso
   não autorizado", e com parâmetros mas sem API deixa os 36 elementos
   no DOM com `offsetParent` nulo — todos invisíveis. Auditar aquilo
   devolve "zero violações" sobre uma tela que ninguém vê. */
const PEDIDO_DUBLE = {
  contratanteNome: 'Loja de Teste',
  metodosHabilitados: ['pix', 'boleto', 'cartao', 'assinatura'],
  pedido: {
    tipo: 'produto',
    descricao: 'Camiseta preta — tamanho M',
    itens: [{ descricao: 'Camiseta preta M', quantidade: 1, valor: 89.9 }],
    valorCheio: 89.9,
    desconto: 0,
    valorComDesconto: 89.9,
    frete: 0
  },
  taxa: { taxaAsaas: 1.99, taxaPropria: 2.7, taxasTotais: 4.69, valorCobrado: 94.59 },
  retornoUrl: null
};

/* A tela de ASSINATURA é outra tela, e carrega por outro endpoint
   (`/api/checkout/plano/:c/:id`, parâmetro `?assinatura=`). Sem ela a
   auditoria deixaria de fora justamente o fluxo de recorrência — o que
   o MostrAí usa. Formato real de `planoController`: o plano no topo e um
   `_checkout` com os dados do contratante. */
const PLANO_DUBLE = {
  id: 'plano_auditoria',
  nome: 'Plano Mensal de Teste',
  descricao: 'Acesso completo, renovação automática',
  valor: 49.9,
  ciclo: 'MONTHLY',
  _checkout: {
    metodosHabilitados: ['assinatura'],
    contratanteNome: 'Loja de Teste',
    retornoUrl: null
  }
};

const TELAS = [
  { arquivo: 'index.html', nome: 'Checkout', publico: 'comprador',
    query: '?c=testemaster&pedido=ped_auditoria_a11y', dublarPedido: true,
    exigeVisiveis: 10 },
  { arquivo: 'index.html', nome: 'Checkout · assinatura', publico: 'comprador',
    query: '?c=testemaster&assinatura=plano_auditoria', dublarPlano: true,
    exigeVisiveis: 8 },
  { arquivo: 'status.html', nome: 'Status do pedido', publico: 'comprador' },
  { arquivo: 'termos.html', nome: 'Termos de Uso', publico: 'comprador' },
  { arquivo: 'privacidade.html', nome: 'Política de Privacidade', publico: 'comprador' },
  { arquivo: '404.html', nome: 'Página não encontrada', publico: 'comprador' },
  { arquivo: 'pagamento-popup-fechar.html', nome: 'Fechar pop-up', publico: 'comprador' },
  { arquivo: 'admin.html', nome: 'Painel administrativo', publico: 'operador' }
];

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function servir() {
  const servidor = createServer(async (req, res) => {
    // `normalize` + prefixo conferido: sem isso um `..%2f` no caminho lê
    // arquivo fora de `public/`. Servidor de teste também é servidor.
    const caminho = normalize(join(PUBLICO, decodeURIComponent(req.url.split('?')[0])));
    if (!caminho.startsWith(PUBLICO)) { res.writeHead(403).end(); return; }

    try {
      const corpo = await readFile(caminho);
      res.writeHead(200, { 'Content-Type': TIPOS[extname(caminho)] ?? 'application/octet-stream' });
      res.end(corpo);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('nao encontrado');
    }
  });
  return new Promise((ok) => servidor.listen(0, '127.0.0.1', () => ok(servidor)));
}

const { chromium } = await import('playwright');
const axeFonte = await readFile(join(RAIZ, 'node_modules/axe-core/axe.min.js'), 'utf8');

const servidor = await servir();
const base = `http://127.0.0.1:${servidor.address().port}`;

// Largura de celular: é como a maioria paga, e é onde alvo pequeno e
// texto apertado aparecem. WCAG 2.2 trouxe "Target Size (Minimum)"
// justamente por isso.
/* Aponta para o Chromium que já existe na máquina em vez de baixar um.
   A versão do Playwright espera um build mais novo que o pré-instalado,
   e `npx playwright install` num ambiente efêmero é download de centenas
   de MB a cada execução. `CHROMIUM_EXECUTAVEL` permite trocar o caminho
   sem editar este arquivo. */
const executavel = process.env.CHROMIUM_EXECUTAVEL ?? '/opt/pw-browsers/chromium';
const navegador = await chromium.launch({ executablePath: executavel });
const contexto = await navegador.newContext({ viewport: { width: 390, height: 844 } });

const REGRAS = { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } };

let totalViolacoes = 0;
const relatorio = [];

for (const tela of TELAS) {
  const pagina = await contexto.newPage();
  const errosDeConsole = [];
  pagina.on('pageerror', (e) => errosDeConsole.push(e.message));

  if (tela.dublarPedido) {
    await pagina.route('**/api/checkout/pedido/**', (rota) =>
      rota.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PEDIDO_DUBLE) }));
  }
  if (tela.dublarPlano) {
    await pagina.route('**/api/checkout/plano/**', (rota) =>
      rota.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PLANO_DUBLE) }));
  }

  await pagina.goto(`${base}/${tela.arquivo}${tela.query ?? ''}`, { waitUntil: 'load' });
  // O checkout monta pedaços por JS; sem esperar, o axe audita um
  // esqueleto que ninguém vê.
  await pagina.waitForTimeout(900);

  /* A GUARDA CONTRA APROVAÇÃO VAZIA.
     A primeira versão deste script reportou "Checkout — 0 violações"
     auditando a tela de "Acesso não autorizado", porque sem os
     parâmetros a página se substitui por ela. Zero violação numa tela
     que não é a tela é pior que violação nenhuma: parece evidência.
     Agora a tela tem de PROVAR que apareceu, ou o verificador reprova. */
  const visiveis = await pagina.evaluate(() =>
    [...document.querySelectorAll('a[href],button,input,select,textarea')]
      .filter((e) => e.offsetParent !== null).length);

  let naoAuditou = null;
  if (tela.exigeVisiveis && visiveis < tela.exigeVisiveis) {
    naoAuditou = `só ${visiveis} elementos interativos visíveis (esperado ao menos ${tela.exigeVisiveis}) — a tela não carregou, e auditá-la assim daria falso verde`;
    totalViolacoes += 1;
  }

  await pagina.addScriptTag({ content: axeFonte });
  const { violations } = await pagina.evaluate((r) => window.axe.run(document, r), REGRAS);

  totalViolacoes += violations.length;
  relatorio.push({ tela, violations, errosDeConsole, visiveis, naoAuditou });
  await pagina.close();
}

/* ------------------------------------------------------------------
   Os ESTADOS do checkout, e as duas coisas que o axe não mede.

   Auditar só o estado inicial deixa de fora onde os problemas moram:
   acordeão aberto, campo com erro, painel que aparece depois. E a lei
   cobra nominalmente duas coisas que nenhuma regra do axe cobre —
   **foco visível** e **navegação inteira por teclado**.
------------------------------------------------------------------ */
const extras = [];
const pagina = await contexto.newPage();
await pagina.route('**/api/checkout/pedido/**', (rota) =>
  rota.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PEDIDO_DUBLE) }));
await pagina.goto(`${base}/index.html?c=testemaster&pedido=ped_auditoria_a11y`, { waitUntil: 'load' });
await pagina.waitForTimeout(900);
await pagina.addScriptTag({ content: axeFonte });

/* --- cada acordeão de método pagamento, aberto --- */
const metodos = await pagina.$$eval('.method-row', (bs) => bs.map((b) => b.id));
for (const id of metodos) {
  await pagina.click(`#${id}`);
  await pagina.waitForTimeout(250);
  const { violations } = await pagina.evaluate((r) => window.axe.run(document, r), REGRAS);
  extras.push({ nome: `Checkout · método "${id}" aberto`, violations });
  totalViolacoes += violations.length;
}

/* --- foco visível e alcance por teclado ---------------------------
   Percorre a página só com Tab, como quem não usa mouse. Para cada
   parada: o elemento tem de ser identificável E tem de mostrar que
   está focado. Indicador só pelo estilo padrão do navegador conta —
   o que não conta é `outline: none` sem nada no lugar, que é o jeito
   mais comum de quebrar isto sem perceber. */
await pagina.evaluate(() => document.body.focus());
const paradas = [];
for (let i = 0; i < 60; i += 1) {
  await pagina.keyboard.press('Tab');
  const parada = await pagina.evaluate(() => {
    const e = document.activeElement;
    if (!e || e === document.body) return null;
    const s = getComputedStyle(e);
    const temContorno = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
    const temSombra = s.boxShadow !== 'none' && s.boxShadow !== '';
    const temBorda = s.borderColor !== '' && parseFloat(s.borderWidth) > 0;
    return {
      elemento: `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : ''}`,
      focoVisivel: temContorno || temSombra || temBorda,
      // Nome acessível: rótulo, aria-label, ou texto. Sem isso, quem
      // navega por teclado ou leitor de tela não sabe onde está.
      temNome: Boolean(
        e.getAttribute('aria-label') ||
        e.labels?.length ||
        e.textContent?.trim() ||
        e.getAttribute('title') ||
        e.getAttribute('alt')
      )
    };
  });
  if (parada) paradas.push(parada);
}

const semFoco = paradas.filter((p) => !p.focoVisivel);
const semNome = paradas.filter((p) => !p.temNome);
/* Zero paradas não é "tudo certo", é "não medi nada" — e foi o que a
   primeira versão reportou como dois tiques verdes. */
const tabulouDeVerdade = paradas.length >= 10;
await pagina.close();

await navegador.close();
servidor.close();

console.log('=== acessibilidade — axe-core, WCAG 2.2 AA, Chromium 390x844 ===\n');

for (const { tela, violations, errosDeConsole } of relatorio) {
  const item = relatorio.find((x) => x.tela === tela);
  const marca = violations.length === 0 && !item.naoAuditou ? '✓' : '✗';
  console.log(`${marca} ${tela.nome} (${tela.arquivo}, ${tela.publico}) — ${violations.length} violação(ões), ${item.visiveis} elementos interativos visíveis`);
  if (item.naoAuditou) console.log(`    ✗ NÃO AUDITADA: ${item.naoAuditou}`);

  for (const v of violations) {
    console.log(`    [${v.impact}] ${v.id}: ${v.help}`);
    console.log(`        ${v.helpUrl}`);
    for (const no of v.nodes.slice(0, 4)) {
      console.log(`        → ${no.target.join(' ')}`);
      const resumo = (no.failureSummary ?? '').split('\n').filter(Boolean).slice(1, 3);
      for (const linha of resumo) console.log(`          ${linha.trim()}`);
    }
    if (v.nodes.length > 4) console.log(`        … e outros ${v.nodes.length - 4} elementos`);
  }

  if (errosDeConsole.length) {
    console.log(`    ⚠ erro de JavaScript na página: ${errosDeConsole[0]}`);
  }
}

/* --- os estados --- */
console.log('');
console.log('--- estados do checkout ---');
for (const e of extras) {
  console.log(`${e.violations.length === 0 ? '✓' : '✗'} ${e.nome} — ${e.violations.length} violação(ões)`);
  for (const v of e.violations) {
    console.log(`    [${v.impact}] ${v.id}: ${v.help}`);
    for (const no of v.nodes.slice(0, 3)) console.log(`        → ${no.target.join(' ')}`);
  }
}

/* --- teclado --- */
console.log('');
console.log('--- navegação por teclado (só Tab, sem mouse) ---');
console.log(`  ${tabulouDeVerdade ? '✓' : '✗'} ${paradas.length} paradas alcançadas${tabulouDeVerdade ? '' : ' — POUCAS DEMAIS: o Tab não percorreu a tela, então as duas linhas abaixo não medem nada'}`);
if (!tabulouDeVerdade) totalViolacoes += 1;
console.log(`  ${semFoco.length === 0 ? '✓' : '✗'} foco visível em todas`);
for (const p of semFoco.slice(0, 8)) console.log(`      → sem indicador de foco: ${p.elemento}`);
console.log(`  ${semNome.length === 0 ? '✓' : '✗'} nome acessível em todas`);
for (const p of semNome.slice(0, 8)) console.log(`      → sem nome acessível: ${p.elemento}`);
totalViolacoes += semFoco.length + semNome.length;

console.log('');
console.log(totalViolacoes === 0
  ? 'SEM VIOLAÇÕES — nas regras que o axe cobre. Ordem de foco, qualidade do texto\nalternativo e "nada só por cor" continuam sendo revisão humana.'
  : `${totalViolacoes} violação(ões) — corrigir antes de fechar a estação 6.`);

process.exit(totalViolacoes === 0 ? 0 : 1);
