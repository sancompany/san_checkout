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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/* As duas coisas que este dublê NÃO copia à mão, e não pode copiar: a
   frase do piso e quantas parcelas cabem. Copiadas, elas viram a mentira
   do dia seguinte — o número muda no código e o dublê continua afirmando
   o antigo, com a auditoria verde por cima. Importar do dono é o que faz
   o dublê acompanhar sozinho. */
import { MENSAGEM_PISO_ASAAS } from '../src/utils/validadores.js';
import { taxaComParcelasQueCabem } from '../src/services/taxaService.js';
import { PEDIDO_DUBLE, PLANO_DUBLE, servir } from './ajudantesNavegador.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLICO = join(RAIZ, 'public');

/** As telas do COMPRADOR primeiro — é quem não escolheu estar aqui e
 *  não tem alternativa se a tela não funcionar. O painel é do operador,
 *  e entra depois porque a obrigação vale para ele também (Lei 5).
 *
 *  `PEDIDO_DUBLE` (e `PLANO_DUBLE`, mais abaixo) vêm de
 *  `ajudantesNavegador.mjs`, compartilhado com `desempenho.mjs` — os
 *  dois nasceram com cópia própria e divergiram na formatação, então
 *  foram unificados em 18/09/2026 (ciclo de revisão do projeto inteiro).
 *
 *  Precisa existir porque SEM ELE não há o que auditar: medido em
 *  17/09, o checkout sem parâmetros troca a página inteira por "Acesso
 *  não autorizado", e com parâmetros mas sem API deixa os 36 elementos
 *  no DOM com `offsetParent` nulo — todos invisíveis. Auditar aquilo
 *  devolve "zero violações" sobre uma tela que ninguém vê. */

/* ESTADOS NOVOS DE 17/09/2026, e a razão de estarem aqui: os dois
   nasceram nesta data e nenhum navegador os tinha visto. Auditar só o
   caminho felz é como o verificador reportou "0 violações" sobre a tela
   de "Acesso não autorizado" — parece evidência e não é. */

/** Pedido abaixo do piso de valor do provedor: a tela existe, diz o
 *  motivo, e NÃO tem formulário de pagamento (RN-28). */
const PEDIDO_ABAIXO_DO_PISO = {
  ...PEDIDO_DUBLE,
  pedido: { ...PEDIDO_DUBLE.pedido, valorCheio: 2, valorComDesconto: 2 },
  taxa: { taxaAsaas: 1.99, taxaPropria: 0.52, taxasTotais: 2.51, valorCobrado: 4.51 },
  maxParcelas: 1,
  bloqueio: { codigo: 'valor_abaixo_do_piso', mensagem: MENSAGEM_PISO_ASAAS }
};

/** Item sem preço: mostra travessão, nunca "R$ 0,00" — zero numa linha
 *  de item lê como brinde. */
const PEDIDO_COM_ITEM_SEM_PRECO = {
  ...PEDIDO_DUBLE,
  pedido: {
    ...PEDIDO_DUBLE.pedido,
    itens: [
      { nome: 'Camiseta preta M', quantidade: 1, valorUnitario: 79.9 },
      { nome: 'Brinde surpresa (sem preço informado)', quantidade: 1 }
    ]
  }
};

/** Pedido barato, mas pagável: a lista de parcelas tem de encurtar.
 *  A taxa e o `maxParcelas` vêm da MESMA função que o servidor usa — não
 *  de números que eu escrevi aqui olhando o resultado de uma vez. */
const BASE_POUCO_PARCELAVEL = 24;
const CABEM = taxaComParcelasQueCabem(BASE_POUCO_PARCELAVEL, 12, false);
const PEDIDO_POUCO_PARCELAVEL = {
  ...PEDIDO_DUBLE,
  pedido: {
    ...PEDIDO_DUBLE.pedido,
    valorCheio: BASE_POUCO_PARCELAVEL,
    valorComDesconto: BASE_POUCO_PARCELAVEL
  },
  taxa: CABEM.taxa,
  maxParcelas: CABEM.parcelas
};

/* E o dublê só serve se o cenário for o que se quer testar: se um dia a
   taxa mudar de tal forma que R$ 24,00 passe a caber em 12x, este estado
   deixa de exercitar o corte — e passaria verde sem testar nada. */
if (CABEM.parcelas >= 12) {
  console.error(
    `A base de R$ ${BASE_POUCO_PARCELAVEL},00 passou a caber em ${CABEM.parcelas}x: ` +
    'o estado "lista cortada" deixou de exercitar o corte. Baixe a base.'
  );
  process.exit(1);
}

/* A tela de ASSINATURA é outra tela, e carrega por outro endpoint
   (`/api/checkout/plano/:c/:id`, parâmetro `?assinatura=`). Sem ela a
   auditoria deixaria de fora justamente o fluxo de recorrência — o que
   o MostrAí usa. `PLANO_DUBLE` (formato real de `planoController`, o
   plano no topo e um `_checkout` com os dados do contratante) vem de
   `ajudantesNavegador.mjs`, importado no topo do arquivo. */

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

const { chromium } = await import('playwright');
const axeFonte = await readFile(join(RAIZ, 'node_modules/axe-core/axe.min.js'), 'utf8');

const servidor = await servir(PUBLICO);
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

/* --- OS ESTADOS NOVOS DE 17/09, em navegador de verdade -------------
   Cada um abre numa aba própria, com o seu dublê, e é auditado E
   CONFERIDO: não basta "0 violações", o estado tem de ter ACONTECIDO.
   Zero violação sobre uma tela que não é a tela é o erro que este
   script já cometeu uma vez. */
for (const estado of [
  {
    nome: 'Checkout · abaixo do valor mínimo (RN-28)',
    duble: PEDIDO_ABAIXO_DO_PISO,
    conferir: async (p) => {
      const titulo = await p.textContent('#order-title');
      const total = await p.textContent('#order-amount');
      const formulario = await p.$('.checkout-panel--form:not(.hidden)');
      if (!/valor mínimo/i.test(titulo ?? '')) return `o motivo não apareceu na tela (título: "${titulo}")`;
      if (!/—/.test(total ?? '')) return `o total devia ser travessão, veio "${total}"`;
      if (formulario) return 'o formulário de pagamento continuou visível numa compra que não pode acontecer';
      return null;
    }
  },
  {
    nome: 'Checkout · item sem preço mostra travessão',
    duble: PEDIDO_COM_ITEM_SEM_PRECO,
    conferir: async (p) => {
      const valores = await p.$$eval('.order-item-value', (es) => es.map((e) => e.textContent.trim()));
      if (valores.length < 2) return `esperava 2 linhas de item, vi ${valores.length}`;
      if (!valores.includes('—')) return `o item sem preço devia mostrar travessão, vi ${JSON.stringify(valores)}`;
      if (valores.some((v) => /R\$ 0,00/.test(v))) return `alguma linha mostrou "R$ 0,00": ${JSON.stringify(valores)}`;
      return null;
    }
  },
  {
    nome: 'Checkout · lista de parcelas cortada pelo servidor',
    duble: PEDIDO_POUCO_PARCELAVEL,
    conferir: async (p) => {
      await p.click('#method-cartao');
      await p.waitForTimeout(250);
      const opcoes = await p.$$eval('#cartao-parcelas option', (es) => es.map((e) => Number(e.value)));
      if (opcoes.length === 0) return 'a lista de parcelas ficou vazia';
      const maximo = Math.max(...opcoes);
      if (maximo !== PEDIDO_POUCO_PARCELAVEL.maxParcelas) {
        return `a lista devia terminar em ${PEDIDO_POUCO_PARCELAVEL.maxParcelas}x, terminou em ${maximo}x`;
      }
      return null;
    }
  }
]) {
  const aba = await contexto.newPage();
  await aba.route('**/api/checkout/pedido/**', (rota) =>
    rota.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(estado.duble) }));
  await aba.goto(`${base}/index.html?c=testemaster&pedido=ped_auditoria_a11y`, { waitUntil: 'load' });
  await aba.waitForTimeout(900);

  const problema = await estado.conferir(aba);
  if (problema) {
    extras.push({ nome: estado.nome, violations: [], naoAconteceu: problema });
    totalViolacoes += 1;
  } else {
    await aba.addScriptTag({ content: axeFonte });
    const { violations } = await aba.evaluate((r) => window.axe.run(document, r), REGRAS);
    extras.push({ nome: estado.nome, violations });
    totalViolacoes += violations.length;
  }
  await aba.close();
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
  /* `naoAconteceu` é mais grave que violação: significa que o estado
     não apareceu, e auditar o que não apareceu devolve verde falso. */
  if (e.naoAconteceu) {
    console.log(`✗ ${e.nome} — NÃO AUDITADO: ${e.naoAconteceu}`);
    continue;
  }
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
