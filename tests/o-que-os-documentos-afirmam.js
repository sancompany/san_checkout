#!/usr/bin/env node
/**
 * tests/o-que-os-documentos-afirmam.js
 *
 * Os números que os documentos afirmam, conferidos contra a realidade.
 *
 * ── Por que esta suíte existe ───────────────────────────────────────
 * "Um documento falso é pior que um documento ausente" é regra deste
 * repositório, e em 17/09/2026 ela foi violada três vezes pelo MESMO
 * número: o `CLAUDE.md` dizia 18 suítes quando eram 24, depois 24
 * quando eram 28, depois 30 quando eram 31. Duas dessas vezes fui eu
 * que corrigi à mão — e a terceira apareceu no mesmo dia, porque
 * corrigir à mão não impede a próxima.
 *
 * Número em prosa envelhece em silêncio: ninguém relê o mapa de
 * caminhos ao acrescentar uma suíte. Então o que se conserta não é o
 * número, é o fato de ele poder divergir sem ninguém ver.
 *
 * ── O que entra aqui, e o que não ───────────────────────────────────
 * Só afirmação que a máquina consegue conferir sem opinião: contagem,
 * lista, existência de arquivo. Nada de "o texto está claro" ou "a
 * decisão está bem explicada" — isso é leitura humana, e um teste que
 * finge medir isso é pior que não ter teste.
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
let checagens = 0;
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };
const igual = (a, b, m) => { assert.deepEqual(a, b, m); checagens += 1; };

const CLAUDE = readFileSync(join(RAIZ, 'CLAUDE.md'), 'utf8');
const RUNNER = readFileSync(join(RAIZ, 'tests', 'executar.js'), 'utf8');

/* ------------------------------------------------------------------
   1. A CONTAGEM DE SUÍTES
------------------------------------------------------------------ */

/* A lista do runner é a fonte: cada entrada é uma linha `  '…',`.
   Contá-la por regex aqui é aceitável porque o formato é o mesmo desde
   o começo, e o controle positivo abaixo acusa se deixar de casar. */
const suites = [...RUNNER.matchAll(/^ {2}'([^']+\.js)'/gm)].map((m) => m[1]);
ok(suites.length > 10, `controle positivo: achou a lista de suítes no runner (achou ${suites.length})`);
ok(
  suites.every((caminho) => existsSync(join(RAIZ, caminho))),
  `o runner lista suíte que não existe: ${suites.filter((c) => !existsSync(join(RAIZ, c)))}`
);

/* O número aparece em DOIS documentos, e a primeira versão desta suíte
   conferia só um. O `README.md` dizia "dezoito" enquanto o `CLAUDE.md`
   já dizia 32 — conferir um documento e não o outro é o mesmo erro em
   escala menor, porque quem lê o README acredita nele. */
/** Todo markdown do repositório, caminho relativo, sem `node_modules`. */
function arquivosMarkdown(raiz, prefixo = '') {
  const achados = [];
  for (const item of readdirSync(join(raiz, prefixo), { withFileTypes: true })) {
    if (item.name === 'node_modules' || item.name.startsWith('.')) continue;
    const rel = prefixo ? `${prefixo}/${item.name}` : item.name;
    if (item.isDirectory()) achados.push(...arquivosMarkdown(raiz, rel));
    else if (item.name.endsWith('.md')) achados.push(rel);
  }
  return achados;
}

const HISTORICOS = [
  'docs/erros/',            // o que deu errado, no mundo de quando deu
  'docs/legal-arquivado/',  // versões antigas de termos e política
  'docs/plano-execucao.md', // registro fechado de 10/09 (marcado no topo dele)
  'docs/lacunas-san-checkout-10-09-2026.md',
  'docs/relatorio-seguranca-09-09-2026.md',
  'docs/CODEX_CHECKOUT_AUDIT_2026-09-24.md', // relatório externo de uma data, gravado verbatim — descreve o mundo daquele commit
  'docs/CHECKOUT_FINAL_CONSOLIDATION_2026-09-24.md', // relatório de entrega de 24/09: as contagens são as daquele dia
  // Estação 6: a baseline e o relatório do Jules descrevem o commit 43635c4
  // e são CONGELADOS por decisão do dono ("NÃO alterar baseline histórica") —
  // corrigir a contagem deles seria reescrever o que foi observado.
  'docs/SECURITY_STATION_6_BASELINE_2026-09-25.md',
  'docs/SECURITY_STATION_6_JULES_REVIEW_2026-09-25.md'
];

const AFIRMAM = [
  ['CLAUDE.md', CLAUDE],
  ['README.md', readFileSync(join(RAIZ, 'README.md'), 'utf8')]
];
for (const [nome, texto] of AFIRMAM) {
  const afirmado = texto.match(/[Rr]oda as (\d+) suítes/);
  ok(afirmado, `o ${nome} afirma um número de suítes (se a linha mudou de forma, ajuste a regex)`);
  igual(
    Number(afirmado[1]), suites.length,
    `o ${nome} diz ${afirmado?.[1]} suítes e o runner lista ${suites.length} — ` +
    'o runner é a fonte; corrija a prosa'
  );
}

/* E AGORA A FORMA GERAL, que é a que faltava.

   A checagem acima olha DUAS frases, de forma conhecida, em DOIS
   arquivos. Em 18/09/2026 a varredura do projeto inteiro achou à mão o
   que ela não alcançava: o `RUNBOOK.md` — o documento que a pessoa
   número dois lê para operar — dizia **"as 32 suítes"** num comentário
   de comando, quando já eram 35. Número velho no RUNBOOK é pior que em
   qualquer outro lugar: ele é lido por quem não conhece o projeto e não
   tem como desconfiar.

   Então: QUALQUER "N suítes" em QUALQUER documento vivo tem de bater com
   o runner. A regra vale por número, não por frase, e documento novo
   entra coberto. */
const afirmacoesDeContagem = [];
for (const rel of arquivosMarkdown(RAIZ)) {
  if (HISTORICOS.some((h) => rel.startsWith(h))) continue;
  const texto = readFileSync(join(RAIZ, rel), 'utf8');
  for (const achado of texto.matchAll(/(\d+)\s+suítes/g)) {
    /* Número CITADO como erro passado não é afirmação: vários documentos
       daqui guardam o valor antigo de propósito ("o mapa dizia 18
       suítes"), porque o registro do erro é o que impede o próximo. O
       que se cobra é o número no presente. */
    const antes = texto.slice(Math.max(0, achado.index - 60), achado.index);
    if (/diz(ia|iam|endo)|afirma(va|ndo)|estava errado|era\s*$/.test(antes)) continue;
    afirmacoesDeContagem.push({ rel, numero: Number(achado[1]) });
  }
}
/* O controle positivo é 2 porque é o que existe de propósito: o
   `CLAUDE.md` e o `README.md` afirmam a contagem, e o `RUNBOOK.md`
   deixou de afirmá-la em 18/09 (a linha dele passou a dizer "as
   suítes" — documento que não carrega número não tem número para
   envelhecer). Se um dia a varredura achar ZERO, é porque a forma da
   frase mudou nos dois e a checagem virou decoração. */
ok(
  afirmacoesDeContagem.length >= 2,
  `controle positivo: a varredura acha as afirmações de contagem (achou ${afirmacoesDeContagem.length})`
);
igual(
  afirmacoesDeContagem.filter((a) => a.numero !== suites.length).map((a) => `${a.rel} diz ${a.numero}`),
  [],
  `documento vivo com número de suítes diferente do runner (${suites.length})`
);

/* E TODA SUÍTE que existe está no runner: teste que não roda é pior que
   nenhum, porque parece cobertura.

   Mas `tests/` também guarda FERRAMENTA de uso manual — o mock da API do
   contratante, que uma pessoa sobe num terminal separado. Ferramenta não
   tem assertiva e não deve entrar no `npm test`; tratá-la como suíte
   esquecida foi o primeiro veredito desta checagem, e era falso.

   A régua que separa as duas é a única honesta: **tem assertiva?** Tendo,
   é suíte e precisa rodar. Não tendo, é ferramenta — e aí o que se exige
   é que ela esteja documentada, senão é código órfão que ninguém sabe
   para que serve. */
const emDisco = readdirSync(join(RAIZ, 'tests'))
  .filter((n) => n.endsWith('.js') && n !== 'executar.js');
ok(emDisco.length > 10, `controle positivo: achou os arquivos de tests/ (achou ${emDisco.length})`);

const comAssertiva = [];
const ferramentas = [];
for (const nome of emDisco) {
  const fonte = readFileSync(join(RAIZ, 'tests', nome), 'utf8');
  (/\bassert\b/.test(fonte) ? comAssertiva : ferramentas).push(nome);
}
ok(comAssertiva.length > 10, `controle positivo: a maioria de tests/ é suíte (${comAssertiva.length})`);
ok(ferramentas.length >= 1, `controle positivo: e há ao menos uma ferramenta (${ferramentas.length})`);

igual(
  comAssertiva.filter((n) => !suites.includes(`tests/${n}`)), [],
  'arquivo com assertiva que o runner NÃO roda — parece cobertura e não é'
);

const DOCS = readdirSync(join(RAIZ, 'docs'))
  .filter((n) => n.endsWith('.md'))
  .map((n) => readFileSync(join(RAIZ, 'docs', n), 'utf8'))
  .join('\n') + CLAUDE + readFileSync(join(RAIZ, 'README.md'), 'utf8');

igual(
  ferramentas.filter((n) => !DOCS.includes(n)), [],
  'ferramenta em tests/ que nenhum documento menciona — código órfão'
);

/* E o cabeçalho de cada arquivo de `tests/` tem de apontar para ele
   mesmo. O mock dizia `mock/servidor-mock-pedido.js`, pasta que nunca
   existiu — quem procurasse o arquivo pelo caminho do próprio
   comentário não o acharia. */
const cabecalhoErrado = [];
for (const nome of emDisco) {
  const inicio = readFileSync(join(RAIZ, 'tests', nome), 'utf8').slice(0, 400);
  /* O caminho no INÍCIO da linha de comentário, com ou sem texto
     depois. A primeira versão exigia a linha inteira ser só o caminho, e
     por isso não pegava ` * tests/ajudantes.js — o que mais…` — a
     sabotagem passou. Só o primeiro caminho conta: citação a outro
     arquivo no meio do cabeçalho é legítima. */
  const citado = inicio.match(/^ \* ([\w./-]+\.js)(?=\s|$)/m);
  if (citado && citado[1] !== `tests/${nome}`) cabecalhoErrado.push(`${nome} diz "${citado[1]}"`);
}
igual(cabecalhoErrado, [], 'cabeçalho apontando para um caminho que não é o do próprio arquivo');

/* ------------------------------------------------------------------
   2. A TABELA DE SKILLS

   O `CLAUDE.md` afirma "são nove skills no plugin". Se o plugin estiver
   clonado (não está no CI), confere contra ele; se não, confere ao
   menos que a tabela tenha o número que o texto afirma.
------------------------------------------------------------------ */

const bloco = CLAUDE.slice(CLAUDE.indexOf('| a função que você está exercendo'));
const tabela = bloco.slice(0, bloco.indexOf('\n\n'));
const naTabela = [...new Set([...tabela.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]))].sort();

const quantasAfirma = CLAUDE.match(/São \*\*(\w+)\*\* skills no plugin/);
ok(quantasAfirma, 'o CLAUDE.md afirma quantas skills existem');
const PALAVRAS = { sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12 };
const numeroAfirmado = PALAVRAS[quantasAfirma[1]] ?? Number(quantasAfirma[1]);
ok(numeroAfirmado > 0, `o número de skills afirmado é legível ("${quantasAfirma[1]}")`);
igual(naTabela.length, numeroAfirmado, `a tabela lista ${naTabela.length} skills e o texto afirma ${numeroAfirmado}`);

const DIR_PLUGIN = join(RAIZ, '..', 'sancompany', 'plugin_san-co', 'plugins', 'san-co', 'skills');
if (existsSync(DIR_PLUGIN)) {
  const noPlugin = readdirSync(DIR_PLUGIN).sort();
  igual(naTabela, noPlugin, 'a tabela do CLAUDE.md bate exatamente com as skills do plugin');
  igual(noPlugin.length, numeroAfirmado, `o plugin tem ${noPlugin.length} skills e o texto afirma ${numeroAfirmado}`);
} else {
  /* Não é falha: o plugin não é clonado no CI. Mas dizer isso em voz
     alta importa — "passou" sem ter conferido contra a fonte é a
     confiança falsa que este repositório já pagou caro uma vez. */
  console.log('          (plugin não clonado aqui: a tabela NÃO foi conferida contra a fonte)');
}

/* ------------------------------------------------------------------
   3. OS ARQUIVOS QUE O CLAUDE.MD MANDA LER EXISTEM

   "Ponteiro envelhece calado" é o aviso da própria skill `revisar`.
   Um índice apontando para arquivo que não existe manda o próximo
   leitor procurar o que não está lá.
------------------------------------------------------------------ */


const apontados = [...CLAUDE.matchAll(/`((?:docs|supabase|src|public|scripts|tests)\/[\w./-]+\.(?:md|js|sql|mjs|css|html))`/g)]
  .map((m) => m[1]);
ok(apontados.length > 5, `controle positivo: achou caminhos citados no CLAUDE.md (achou ${apontados.length})`);

const sumidos = [...new Set(apontados)].filter((c) => !existsSync(join(RAIZ, c)));
igual(sumidos, [], 'o CLAUDE.md aponta para arquivo que não existe');

/* ------------------------------------------------------------------
   3b. E O MESMO VALE PARA TODO DOCUMENTO VIVO

   A checagem acima existia só para o `CLAUDE.md`, e em 18/09/2026 a
   varredura do projeto inteiro achou à mão o que ela não alcançava:
   `supabase/schema.sql` — arquivo que deixou de existir quando as
   migrations numeradas entraram — citado em TRÊS documentos, um deles
   o inventário de dados, que é documento legal (Lei 10). Quem fosse
   conferir onde uma coluna é definida não acharia nada.

   A varredura é por EXCLUSÃO, e a direção é deliberada: documento novo
   entra coberto: só sai quem está na lista de registro histórico. Um
   registro de erro de 11/09 descreve o mundo daquele dia, e citar nele
   um arquivo que existia é correto — o que se cobra ali é a moldura
   ("o arquivo existia na época"), não a existência hoje.
------------------------------------------------------------------ */



const vivos = arquivosMarkdown(RAIZ).filter((rel) => !HISTORICOS.some((h) => rel.startsWith(h)));
ok(vivos.length >= 10, `controle positivo: achou os documentos vivos (achou ${vivos.length})`);
ok(
  arquivosMarkdown(RAIZ).length > vivos.length,
  'controle positivo: e a lista de históricos exclui alguém — senão a exclusão é decorativa'
);

const quebrados = [];
for (const rel of vivos) {
  const texto = readFileSync(join(RAIZ, rel), 'utf8');
  const citados = [...texto.matchAll(/`((?:docs|supabase|src|public|scripts|tests|\.github)\/[\w./-]+\.(?:md|js|sql|mjs|sh|css|html|yml|json))`/g)]
    .map((m) => m[1]);
  for (const caminho of [...new Set(citados)]) {
    if (!existsSync(join(RAIZ, caminho))) quebrados.push(`${rel} → ${caminho}`);
  }
}
igual(quebrados, [], 'documento vivo aponta para arquivo que não existe');

/* ---- As duas evidências da Estação 6 são IMUTÁVEIS ----
   A baseline de segurança (Claude, antes de qualquer correção, `5ff3e93`)
   e a revisão independente (Jules, `591f5d7`, PR #49) são o que a
   remediação tem de responder. Reescrever uma delas depois apagaria o
   ponto de partida — o hash é o do commit original, conferido em
   25/09/2026. O resultado pós-correção mora em outro arquivo, o
   `SECURITY_STATION_6_REMEDIATION_2026-09-25.md`. */
const IMUTAVEIS = {
  'docs/SECURITY_STATION_6_BASELINE_2026-09-25.md': '23c8e6d472daced104e85157d9ee2028743401daf3bb9975ab14458c86795112',
  'docs/SECURITY_STATION_6_JULES_REVIEW_2026-09-25.md': 'e72670cf11c5c82c7c42570acadfaaf7138c20a45c64e8f665d3c23be6920af1'
};
for (const [arquivo, hash] of Object.entries(IMUTAVEIS)) {
  const caminho = join(RAIZ, arquivo);
  ok(existsSync(caminho), `${arquivo} existe`);
  ok(createHash('sha256').update(readFileSync(caminho)).digest('hex') === hash, `${arquivo} é o do commit original — evidência não se reescreve`);
}
ok(existsSync(join(RAIZ, 'docs/SECURITY_STATION_6_REMEDIATION_2026-09-25.md')), 'e o resultado pós-correção existe à parte');

/* ---- O ledger da remediação se conta sozinho ----
   Toda linha de achado (SEC, INFO, JULES, JX, NEW, C<n>-…) tem de terminar
   com UM estado final, e o total que a §15 afirma tem de ser o que as
   linhas somam. Contar à mão foi o que errou "28 FIXED" em 25/09/2026. */
const ESTADOS = ['FIXED', 'FALSE_POSITIVE', 'DUPLICATE', 'RISK_ACCEPTED', 'EXTERNAL_PENDING'];
const relatorio = readFileSync(join(RAIZ, 'docs/SECURITY_STATION_6_REMEDIATION_2026-09-25.md'), 'utf8');
const contagem = Object.fromEntries(ESTADOS.map((e) => [e, 0]));
const vistos = new Set();
const ESTADO_EM_NEGRITO = new RegExp(`\\*\\*(${ESTADOS.join('|')})\\*\\*`);
for (const linha of relatorio.split('\n')) {
  const m = linha.match(/^\| (SEC-\d+|INFO-\d+|JULES-\d+|JX-\d+|NEW-\d+|DIF-\d+|CP\d+-\d+|FP\d+[A-Z]+-\d+|C\d+-[A-Za-z0-9]+) \|/);
  /* Uma linha de tabela com estado final na última coluna e um id que o
     padrão não conhece ficava FORA da conta, calada — foi assim que as
     linhas FP1*-n nasceram sem entrar no total (25/09/2026). */
  if (!m) {
    const ultima = linha.startsWith('| ') ? linha.split('|').map((c) => c.trim()).filter(Boolean).at(-1) ?? '' : '';
    ok(!ESTADO_EM_NEGRITO.test(ultima) || !/^\| [A-Z][A-Za-z0-9]*-[A-Za-z0-9]+ \|/.test(linha), `ledger: linha com estado final e id fora do padrão contado — ${linha.slice(0, 40)}`);
    continue;
  }
  ok(!vistos.has(m[1]), `ledger: ${m[1]} aparece uma vez só`);
  vistos.add(m[1]);
  const celulas = linha.split('|').map((c) => c.trim()).filter(Boolean);
  const achados = ESTADOS.filter((e) => new RegExp(`\\*\\*${e}\\*\\*`).test(celulas.at(-1)));
  ok(achados.length === 1, `ledger: ${m[1]} tem exatamente um estado final na última coluna (tem ${achados.length})`);
  contagem[achados[0]] += 1;
}
const total = vistos.size;
const afirmado = relatorio.match(/TOTAL_LEDGER = (\d+) = FIXED (\d+) \+ FALSE_POSITIVE (\d+) \+ DUPLICATE (\d+) \+ RISK_ACCEPTED (\d+) \+ EXTERNAL_PENDING (\d+)/);
const calculado = `TOTAL_LEDGER = ${total} = FIXED ${contagem.FIXED} + FALSE_POSITIVE ${contagem.FALSE_POSITIVE} + DUPLICATE ${contagem.DUPLICATE} + RISK_ACCEPTED ${contagem.RISK_ACCEPTED} + EXTERNAL_PENDING ${contagem.EXTERNAL_PENDING}`;
ok(ESTADOS.reduce((soma, e) => soma + contagem[e], 0) === total, 'ledger: a soma dos cinco estados é o total');
ok(afirmado && afirmado[0] === calculado, `ledger: a §15 afirma o que as linhas somam — calculado: ${calculado}`);

console.log(`o-que-os-documentos-afirmam: ${checagens} checagens OK (${suites.length} suítes, ${naTabela.length} skills; ${calculado})`);
