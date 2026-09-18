#!/usr/bin/env node
/**
 * SAN CHECKOUT — scripts/desempenho.mjs
 *
 * Mede LCP, CLS e INP nas telas do comprador, num Chromium de verdade,
 * com CPU e rede afuniladas, e falha com código 1 se estourar o
 * orçamento.
 *
 * ── O que este número É, e o que ele NÃO é ──────────────────────────
 * Core Web Vitals é definido como o **p75 dos usuários reais**. Isto
 * aqui não é isso, e chamar de p75 de campo seria mentira: é medição de
 * laboratório, com rede e CPU declaradas abaixo, e o "p75" é calculado
 * sobre as RODADAS desta execução — não sobre pessoas.
 *
 * Campo exigiria visitante real, e hoje não há: o checkout está em
 * sandbox e sem divulgação (a Estação 5 libera subir, não divulgar).
 * O Web Analytics da Cloudflare está ativo no domínio das telas e
 * reporta Core Web Vitals de visitante real — é onde o p75 de campo
 * vai aparecer quando houver tráfego, e o painel é do dono. Enquanto
 * isso, o que se pode ter é um **orçamento reprodutível**: um número
 * que cai junto com uma regressão, rodando no mesmo funil sempre.
 *
 * Não confundir os dois. Este script não substitui o painel, e o painel
 * não substitui este script: um mede gente de verdade sem controle de
 * ambiente, o outro mede ambiente controlado sem gente.
 *
 * ── Os limiares, e de onde vêm ──────────────────────────────────────
 * Os três limiares "bom" do Core Web Vitals (web.dev): LCP ≤ 2,5 s,
 * INP ≤ 200 ms, CLS ≤ 0,1. Valem no p75 de campo; usados aqui como teto
 * de laboratório eles são MAIS exigentes do que a régua real, porque o
 * funil é pior que o celular mediano. Estourar aqui é sinal para olhar,
 * não veredito de reprovação em campo.
 *
 * ── Por que INP é medido com clique de verdade ──────────────────────
 * INP só existe se houver interação. Script que "mede INP" sem clicar
 * mede zero e reporta verde — é a mesma família do verificador de
 * acessibilidade que auditava a tela de "Acesso não autorizado". Aqui
 * cada tela declara o que clicar, e a rodada é **inválida** quando
 * nenhum dos seletores pôde ser clicado, ou quando a página não recebeu
 * o clique.
 *
 * Interação SEM entrada de evento não é rodada inválida: o observador
 * tem piso de 16 ms e abaixo dele não existe entrada. Esse caso entra
 * como 16 ms — o teto do que ele pode ter sido — e aparece no relatório
 * dito em voz alta. A primeira versão tratava isso como falha, e
 * reprovou as páginas legais por serem rápidas.
 *
 * ── Também mede o peso das imagens ──────────────────────────────────
 * Passada estática antes do navegador: imagem referenciada por `<img>`
 * nas telas do comprador acima de 30 KB reprova. É o item "imagens
 * otimizadas" da prontidão, e existe porque o logo chegou aqui com
 * 127 KB para aparecer com 32 px de altura.
 *
 * Uso:  npm run desempenho
 *       npm run desempenho -- --rodadas 7
 *       npm run desempenho -- --tela assinatura --rodadas 3
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PEDIDO_DUBLE, PLANO_DUBLE, servir } from './ajudantesNavegador.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLICO = join(RAIZ, 'public');

const args = process.argv.slice(2);
const RODADAS = Number(args[args.indexOf('--rodadas') + 1]) > 0
  ? Number(args[args.indexOf('--rodadas') + 1])
  : 5;
/** `--tela <parte do nome>` roda só as telas que casam — para reconferir
 *  uma correção sem esperar a bateria inteira. Sem ele, roda todas. */
const FILTRO = args.includes('--tela') ? args[args.indexOf('--tela') + 1] : null;

/* ── O funil ───────────────────────────────────────────────────────
   Perfil de celular mediano em 4G lento, que é o que a prontidão
   operacional manda medir ("no celular de verdade", não no
   desktop de quem construiu). Os números são os do perfil móvel do
   Lighthouse, para o resultado ser comparável com o que qualquer
   auditoria de fora vai dizer. */
const FUNIL = {
  cpu: 4,                       // vezes mais lento que esta máquina
  downloadKbps: 1600,
  uploadKbps: 750,
  latenciaMs: 150,
  viewport: { width: 390, height: 844 }
};

const ORCAMENTO = { lcp: 2500, inp: 200, cls: 0.1 };

/** Duração mínima que o observador de `event` reporta, pela
 *  especificação. Interação mais rápida que isso não gera entrada. */
const PISO_DO_OBSERVADOR_MS = 16;

/* `PEDIDO_DUBLE` e `PLANO_DUBLE` vêm de `ajudantesNavegador.mjs`,
   compartilhado com `acessibilidade.mjs` — os dois nasceram com cópia
   própria e divergiram na formatação, então foram unificados em
   18/09/2026 (ciclo de revisão do projeto inteiro). Sem eles a tela vira
   "Acesso não autorizado" e mediríamos a página errada.

   `interagir` é o que produz INP. `exigeVisiveis` é o controle positivo
   de "a tela apareceu" — herdado da auditoria de acessibilidade, que já
   aprovou uma tela que não era a tela. */
/* `clicarEm` é uma LISTA de seletores tentados em ordem, e não um
   seletor fixo: a primeira versão deste arquivo mandava clicar em
   `#method-assinatura`, que **não existe** — a tela de assinatura
   reaproveita as linhas de método. Resultado: cinco rodadas de
   `page.click` estourando 30 s cada, e nenhuma medição. Lista com
   fallback + rodada inválida quando nada casa é o que impede "não
   mediu" de virar "passou".

   `exigeVisiveis` é o controle positivo de "a tela apareceu" — herdado
   da auditoria de acessibilidade, que já aprovou uma tela que não era
   a tela. */
const TELAS = [
  {
    nome: 'Checkout · pedido avulso',
    arquivo: 'index.html',
    query: '?c=testemaster&pedido=ped_desempenho',
    dublarPedido: true,
    exigeVisiveis: 10,
    /* Abrir um acordeão de método é a primeira coisa que o comprador
       faz, e é onde mora o custo: a linha monta o painel. */
    clicarEm: ['#method-cartao', '.method-row', 'h1']
  },
  {
    nome: 'Checkout · assinatura',
    arquivo: 'index.html',
    query: '?c=testemaster&assinatura=plano_auditoria',
    dublarPlano: true,
    exigeVisiveis: 8,
    clicarEm: ['.method-row', 'button:not([disabled])', 'h1']
  },
  {
    nome: 'Status do pedido',
    arquivo: 'status.html',
    exigeVisiveis: 1,
    clicarEm: ['h1', 'body']
  },
  {
    nome: 'Termos de Uso',
    arquivo: 'termos.html',
    exigeVisiveis: 1,
    clicarEm: ['h1']
  },
  {
    nome: 'Política de Privacidade',
    arquivo: 'privacidade.html',
    exigeVisiveis: 1,
    clicarEm: ['h1']
  }
];

/* O coletor roda ANTES de qualquer script da página, senão perde as
   entradas que acontecem no começo — que são justamente as que
   interessam. `buffered: true` cobre o resto. */
const COLETOR = () => {
  window.__vitais = { lcp: 0, cls: 0, eventos: [], entradasLcp: 0, cliques: 0, culpados: {} };

  /* O observador de `event` só reporta interação com duração ≥ 16 ms —
     é o piso da especificação, e abaixo dele não existe entrada. Então
     "nenhuma entrada" tem DOIS significados opostos: a interação não
     aconteceu, ou ela foi rápida demais para ser medida. Este contador
     separa os dois; sem ele, a primeira versão reprovou as páginas
     legais dizendo "INP não foi medido" quando o certo era "INP abaixo
     do piso de 16 ms". */
  addEventListener('click', () => { window.__vitais.cliques += 1; }, { capture: true });
  new PerformanceObserver((lista) => {
    for (const e of lista.getEntries()) {
      window.__vitais.entradasLcp += 1;
      window.__vitais.lcp = Math.max(window.__vitais.lcp, e.startTime + e.duration);
    }
  }).observe({ type: 'largest-contentful-paint', buffered: true });

  /* Um número de CLS sem dizer QUEM deslocou não conserta nada: a
     primeira versão reprovou a tela de assinatura com 0,409 e eu teria
     de adivinhar o elemento. A entrada traz `sources` com o nó — vira
     seletor legível aqui dentro, onde o nó existe. */
  const comoChamar = (no) => {
    if (!no || no.nodeType !== 1) return '(nó sem elemento)';
    const id = no.id ? `#${no.id}` : '';
    const classe = typeof no.className === 'string' && no.className
      ? `.${no.className.trim().split(/\s+/).join('.')}` : '';
    return `${no.tagName.toLowerCase()}${id}${classe}`;
  };

  new PerformanceObserver((lista) => {
    for (const e of lista.getEntries()) {
      /* Só deslocamento SEM interação recente conta como CLS — o que o
         usuário provocou clicando não é layout instável. */
      if (e.hadRecentInput) continue;
      window.__vitais.cls += e.value;
      for (const fonte of e.sources ?? []) {
        const chave = comoChamar(fonte.node);
        window.__vitais.culpados[chave] = (window.__vitais.culpados[chave] ?? 0) + e.value;
      }
    }
  }).observe({ type: 'layout-shift', buffered: true });

  new PerformanceObserver((lista) => {
    for (const e of lista.getEntries()) {
      window.__vitais.eventos.push({ nome: e.name, duracao: e.duration });
    }
  }).observe({ type: 'event', durationThreshold: 16, buffered: true });
};

/** p75 pelo método do percentil mais próximo, com a lista ordenada.
 *  Poucas amostras: interpolar daria falsa precisão. */
function p75(valores) {
  if (!valores.length) return null;
  const ordenada = [...valores].sort((a, b) => a - b);
  const i = Math.ceil(0.75 * ordenada.length) - 1;
  return ordenada[Math.max(0, i)];
}

/* ------------------------------------------------------------------
   ORÇAMENTO DE BYTES POR IMAGEM

   O item 5 da prontidão pede "imagens otimizadas", e isso não é opinião
   — é peso. Medido em 17/09/2026: o logo era um PNG de **1378x1378 e
   127 KB** exibido com 32 px de altura, na primeira tela do comprador,
   em dado móvel. Trocado por um de 192 px e 8,9 KB (o grande continua
   servindo o `og:image`, que é o único lugar onde tamanho grande tem
   função).

   Esta passada é estática e roda antes do navegador: ela lê o HTML das
   telas do comprador e reprova imagem referenciada acima do teto. Sem
   ela, alguém aponta o `src` de volta para o arquivo grande em três
   meses e ninguém vê — foi assim que ele chegou aqui. O `og:image` fica
   de fora de propósito: não é baixado por quem paga.
------------------------------------------------------------------ */
const TETO_DE_IMAGEM_KB = 30;

const pesadas = [];
for (const arquivo of [...new Set(TELAS.map((t) => t.arquivo))]) {
  const html = await readFile(join(PUBLICO, arquivo), 'utf8');
  /* Só `src` de `<img>`: `og:image` e ícone de favicon não entram no
     caminho de quem está pagando. */
  for (const [, caminho] of html.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    if (/^(https?:)?\/\//.test(caminho)) continue;   // externa: não é nossa para medir
    try {
      const bytes = (await readFile(join(PUBLICO, caminho))).length;
      if (bytes > TETO_DE_IMAGEM_KB * 1024) {
        pesadas.push(`${arquivo} → ${caminho}: ${(bytes / 1024).toFixed(0)} KB`);
      }
    } catch {
      pesadas.push(`${arquivo} → ${caminho}: não achei o arquivo`);
    }
  }
}

console.log(`=== imagens das telas do comprador: teto de ${TETO_DE_IMAGEM_KB} KB cada`);
if (pesadas.length) {
  for (const linha of pesadas) console.log(`   ❌ ${linha}`);
} else {
  console.log('   ✅ nenhuma acima do teto');
}
console.log('');

const { chromium } = await import('playwright');
const servidor = await servir(PUBLICO);
const base = `http://127.0.0.1:${servidor.address().port}`;
const executavel = process.env.CHROMIUM_EXECUTAVEL ?? '/opt/pw-browsers/chromium';
const navegador = await chromium.launch({ executablePath: executavel });

console.log(`=== desempenho no funil: CPU ${FUNIL.cpu}x mais lenta, ${FUNIL.downloadKbps} kbps, ${FUNIL.latenciaMs} ms de latência`);
console.log(`=== ${RODADAS} rodadas por tela, viewport ${FUNIL.viewport.width}x${FUNIL.viewport.height}\n`);

const resultado = [];
let reprovacoes = 0;

const ESCOLHIDAS = FILTRO
  ? TELAS.filter((t) => t.nome.toLowerCase().includes(FILTRO.toLowerCase()))
  : TELAS;
if (!ESCOLHIDAS.length) {
  console.error(`nenhuma tela casa com "${FILTRO}" — nomes: ${TELAS.map((t) => t.nome).join(' | ')}`);
  process.exit(1);
}

for (const tela of ESCOLHIDAS) {
  const amostras = { lcp: [], cls: [], inp: [] };
  const problemas = [];
  const culpados = {};
  let noPiso = 0;

  for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
    /* Contexto novo por rodada: contexto reaproveitado carrega cache de
       HTTP e de fonte, e a segunda rodada mediria outra coisa. */
    const contexto = await navegador.newContext({ viewport: FUNIL.viewport });
    const pagina = await contexto.newPage();
    await pagina.addInitScript(COLETOR);

    if (tela.dublarPedido) {
      await pagina.route('**/api/checkout/pedido/**', (rota) =>
        rota.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PEDIDO_DUBLE) }));
    }
    if (tela.dublarPlano) {
      await pagina.route('**/api/checkout/plano/**', (rota) =>
        rota.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PLANO_DUBLE) }));
    }

    const cdp = await contexto.newCDPSession(pagina);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: FUNIL.cpu });
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: FUNIL.latenciaMs,
      downloadThroughput: (FUNIL.downloadKbps * 1000) / 8,
      uploadThroughput: (FUNIL.uploadKbps * 1000) / 8
    });

    await pagina.goto(`${base}/${tela.arquivo}${tela.query ?? ''}`, { waitUntil: 'load' });
    await pagina.waitForTimeout(1200);

    const visiveis = await pagina.evaluate(() =>
      [...document.querySelectorAll('a[href],button,input,select,textarea')]
        .filter((e) => e.offsetParent !== null).length);
    if (visiveis < (tela.exigeVisiveis ?? 1)) {
      problemas.push(`rodada ${rodada}: só ${visiveis} elementos visíveis (esperado ${tela.exigeVisiveis}) — a tela não carregou`);
      await contexto.close();
      continue;
    }

    let clicou = null;
    for (const seletor of tela.clicarEm) {
      const alvo = await pagina.$(seletor);
      if (!alvo) continue;
      try {
        await alvo.click({ timeout: 3000 });
        clicou = seletor;
        break;
      } catch { /* invisível ou coberto: tenta o próximo da lista */ }
    }
    if (!clicou) {
      problemas.push(`rodada ${rodada}: nenhum dos seletores ${tela.clicarEm.join(', ')} pôde ser clicado — INP não medido`);
      await contexto.close();
      continue;
    }
    await pagina.waitForTimeout(600);

    const v = await pagina.evaluate(() => window.__vitais);

    /* Controles positivos: sem eles um erro de instrumentação vira
       "0 ms, tudo ótimo". Zero aqui é ausência de medição, não
       velocidade. */
    if (!v.entradasLcp) {
      problemas.push(`rodada ${rodada}: nenhuma entrada de LCP — não houve medição`);
      await contexto.close();
      continue;
    }
    if (!v.cliques) {
      problemas.push(`rodada ${rodada}: cliquei em "${clicou}" e a página não recebeu evento de clique — INP não foi medido`);
      await contexto.close();
      continue;
    }

    amostras.lcp.push(v.lcp);
    amostras.cls.push(v.cls);
    for (const [quem, quanto] of Object.entries(v.culpados ?? {})) {
      culpados[quem] = (culpados[quem] ?? 0) + quanto / RODADAS;
    }
    /* Clique houve (contador acima) e nenhuma entrada passou do piso de
       16 ms: o INP real é ≤ 16 ms, e registrar o piso é mais honesto que
       registrar zero. */
    if (v.eventos.length) {
      amostras.inp.push(Math.max(...v.eventos.map((e) => e.duracao)));
    } else {
      amostras.inp.push(PISO_DO_OBSERVADOR_MS);
      noPiso += 1;
    }
    await contexto.close();
  }

  const p = { lcp: p75(amostras.lcp), cls: p75(amostras.cls), inp: p75(amostras.inp) };
  const validas = amostras.lcp.length;

  /* Rodada inválida não é detalhe: com menos da metade das rodadas
     medidas, o p75 é ruído. */
  if (validas < Math.ceil(RODADAS / 2)) {
    reprovacoes += 1;
    console.log(`❌ ${tela.nome}: só ${validas} de ${RODADAS} rodadas mediram`);
    for (const m of problemas) console.log(`     ${m}`);
    resultado.push({ tela: tela.nome, p, validas, problemas });
    continue;
  }

  const estourou = [];
  if (p.lcp > ORCAMENTO.lcp) estourou.push(`LCP ${Math.round(p.lcp)} ms > ${ORCAMENTO.lcp}`);
  if (p.inp > ORCAMENTO.inp) estourou.push(`INP ${Math.round(p.inp)} ms > ${ORCAMENTO.inp}`);
  if (p.cls > ORCAMENTO.cls) estourou.push(`CLS ${p.cls.toFixed(3)} > ${ORCAMENTO.cls}`);
  if (estourou.length) reprovacoes += 1;

  console.log(
    `${estourou.length ? '❌' : '✅'} ${tela.nome.padEnd(28)} ` +
    `LCP ${String(Math.round(p.lcp)).padStart(5)} ms · ` +
    `INP ${String(Math.round(p.inp)).padStart(4)} ms · ` +
    `CLS ${p.cls.toFixed(3)}   (${validas}/${RODADAS} rodadas` +
    `${noPiso ? `, ${noPiso} com INP abaixo do piso de ${PISO_DO_OBSERVADOR_MS} ms` : ''})`
  );
  if (estourou.length) console.log(`     estourou: ${estourou.join('; ')}`);
  /* Quem deslocou, sempre que o CLS estourou ou passou da metade do
     teto: número sem culpado manda adivinhar, e adivinhar em CSS é
     como se mexe no que já estava bom. */
  if (p.cls > ORCAMENTO.cls / 2) {
    const piores = Object.entries(culpados).sort((a, b) => b[1] - a[1]).slice(0, 4);
    for (const [quem, quanto] of piores) {
      console.log(`     deslocou ${quanto.toFixed(3)}  ${quem}`);
    }
  }
  for (const m of problemas) console.log(`     ⚠ ${m}`);

  resultado.push({ tela: tela.nome, p, validas, problemas, estourou });
}

await navegador.close();
servidor.close();

console.log(`\nOrçamento: LCP ≤ ${ORCAMENTO.lcp} ms · INP ≤ ${ORCAMENTO.inp} ms · CLS ≤ ${ORCAMENTO.cls}`);
console.log('Lembrete: é laboratório, e o p75 é sobre as rodadas — não sobre usuários.');

/* Imagem pesada e tela fora do orçamento são reprovações diferentes, e
   a saída diz qual é qual — "1 tela fora do orçamento" quando o que
   estourou foi um PNG manda procurar no lugar errado. */
if (pesadas.length || reprovacoes) {
  console.error('');
  if (pesadas.length) console.error(`--- ${pesadas.length} imagem(ns) acima do teto de ${TETO_DE_IMAGEM_KB} KB ---`);
  if (reprovacoes) console.error(`--- ${reprovacoes} tela(s) fora do orçamento ---`);
  process.exit(1);
}
console.log(`\n${resultado.length} telas dentro do orçamento, e nenhuma imagem acima do teto.`);
