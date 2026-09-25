#!/usr/bin/env node
/**
 * tests/nenhuma-chamada-de-saida-sem-teto.js
 *
 * Toda chamada de rede que sai deste servidor precisa de um teto de
 * tempo. `fetch` sem `signal` espera **para sempre** — não existe
 * timeout padrão.
 *
 * ── Por que isto virou teste, em 15/09/2026 ─────────────────────────
 *
 * A varredura daquele dia achou dois `fetch` sem teto, os dois no
 * caminho do dinheiro, os dois invisíveis até o dia em que o outro lado
 * pendurar:
 *
 *   1. `webhookController.tentarNotificar` — a notificação para o
 *      endpoint do CONTRATANTE. O receptor aguarda o processamento antes
 *      de responder `200` à Asaas, e a Asaas conta resposta lenta como
 *      falha: 15 seguidas e ela PAUSA A FILA da conta inteira
 *      (`CONSTRAINTS.md` §2.3). Um contratante que aceita a conexão e
 *      cala derrubaria a confirmação de pagamento de todos os outros.
 *      Medido: com `await` e sem teto, o fluxo ficava preso
 *      indefinidamente; com teto, 10 s; sem aguardar, ~0.
 *
 *   2. `asaasService.chamarAsaas` — por onde passa TODA chamada à
 *      Asaas: gerar Pix, consultar status, estornar, cancelar
 *      assinatura. A Asaas fora do ar pendurava o comprador esperando o
 *      QR Code, com o navegador desistindo sozinho e o servidor
 *      continuando a segurar o socket.
 *
 * `pedidoService` já fazia certo desde o começo (45 s no pull do
 * contratante) — o que prova que a regra era conhecida e simplesmente
 * não foi aplicada nos outros dois. Por isso a checagem é automática e
 * varre o diretório inteiro: memória não escala, `grep` sim.
 *
 * A checagem é no TEXTO-FONTE, e grosseira de propósito — grosseira e
 * presente vale mais que elegante e inexistente, mesmo argumento do
 * guarda de `arquivado_em` em `pedidoService.js`.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { arquivosJs } from './ajudantes.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGEM = join(RAIZ, 'src');
/* `functions/` também sai para a rede (o proxy do admin no Pages, SEC-015)
   — varrer só o `src/` deixaria de fora justamente o código novo. */
const PASTAS = [ORIGEM, join(RAIZ, 'functions')];
const todos = () => PASTAS.flatMap((p) => arquivosJs(p));

/** Quantas linhas depois do `fetch(` ainda contam como "a mesma chamada". */
const JANELA_DA_CHAMADA = 14;


let chamadas = 0;
const semTeto = [];

for (const caminho of todos()) {
  const linhas = readFileSync(caminho, 'utf8').split('\n');

  linhas.forEach((linha, i) => {
    // Só a CHAMADA de fetch, não a palavra em comentário ou em texto.
    if (!/(?:await |= |return )fetch\(/.test(linha)) return;
    if (/^\s*(\*|\/\/)/.test(linha)) return;

    chamadas += 1;
    const janela = linhas.slice(i, i + JANELA_DA_CHAMADA).join('\n');
    /* Aceita as duas formas de passar: `signal: controlador.signal` e a
       abreviada `signal,` (quando a variável já se chama `signal`).
       Exigir só os dois pontos dava alarme falso em
       `puxarDoContratante.js`, que usa a abreviada — e alarme falso num
       guarda de segurança é o caminho mais curto para alguém desligar o
       guarda. A borda `\b` antes impede casar `sinal` ou `xsignal`. */
    if (!/\bsignal\s*[:,}]/.test(janela)) {
      semTeto.push(`${relative(RAIZ, caminho)}:${i + 1} — ${linha.trim()}`);
    }
  });
}

assert.ok(chamadas > 0, 'nenhuma chamada de saída encontrada — o teste está procurando no lugar errado');

assert.deepEqual(
  semTeto, [],
  'chamada de saída sem teto de tempo (fetch sem `signal`): ela espera para sempre se o outro lado pendurar.\n' +
  '        Use AbortController + setTimeout, como em pedidoService.js.\n' +
  `        Sem teto:\n        - ${semTeto.join('\n        - ')}`
);

/* Os três tetos conhecidos continuam existindo e continuam diferentes —
   cada um responde a uma pressão diferente, e igualar todos seria perder
   o motivo de cada um. */
const tetos = [
  ['src/services/pedidoService.js', 'TIMEOUT_MS = 45000', 'pull do contratante: tolera cold start de hospedagem gratuita, com o comprador esperando a tela'],
  ['src/services/outboxService.js', 'TIMEOUT_NOTIFICACAO_MS = 10_000', 'aviso ao contratante (outbox, desde 24/09/2026): um endpoint pendurado não pode travar a fila dos outros contratantes'],
  ['src/services/asaasService.js', 'TIMEOUT_ASAAS_MS = 20_000', 'chamada à Asaas: acima do pior tempo de sandbox, abaixo da paciência de quem está pagando']
];

for (const [arquivo, declaracao, porque] of tetos) {
  const fonte = readFileSync(join(RAIZ, arquivo), 'utf8');
  assert.ok(
    fonte.includes(declaracao),
    `${arquivo} deveria declarar \`${declaracao}\` — ${porque}`
  );
}

/* ------------------------------------------------------------------
   QUEM RECEBE O `signal` DE FORA PRECISA DE GUARDA DE EXECUÇÃO

   A varredura acima é de texto e não vê VALOR: `signal: undefined`
   passaria por ela sem teto nenhum. Sabotagem provou isso em 17/09/2026.

   Mas o buraco não é igual em todo lugar, e a diferença é estrutural:

   - quem CRIA o `AbortController` na própria função (`asaasService`,
     `webhookController`) não tem como passar `undefined` — o
     controlador nasce duas linhas acima, e a única falha possível é
     apagar a linha do `signal`, que a varredura de texto pega;
   - quem RECEBE o `signal` por parâmetro (`puxarDoContratante`) depende
     de o chamador ter passado algo. Aí `undefined` é erro plausível, a
     varredura de texto fica satisfeita, e o `fetch` espera para sempre
     no endereço de um terceiro.

   Então a regra é essa: recebe de fora, checa em execução. Endurecer o
   outro caso seria cerimônia onde não há risco.
------------------------------------------------------------------ */

let recebemDeFora = 0;
for (const caminho of todos()) {
  const fonte = readFileSync(caminho, 'utf8');
  if (!/(?:await |= |return )fetch\(/.test(fonte)) continue;
  if (fonte.includes('new AbortController()')) continue;

  recebemDeFora += 1;
  assert.ok(
    /if \(!signal\)\s*throw/.test(fonte),
    `${relative(RAIZ, caminho)} recebe o \`signal\` de fora e não recusa a chamada sem ele — ` +
    '`signal: undefined` passa pela varredura de texto e não tem teto nenhum'
  );
}

assert.ok(
  recebemDeFora >= 1,
  `controle positivo: a varredura precisa ACHAR quem recebe o signal de fora (achou ${recebemDeFora})`
);

console.log(
  `nenhuma-chamada-de-saida-sem-teto: ${chamadas} chamadas de saída, todas com teto — ` +
  `${tetos.length} tetos conferidos, ${recebemDeFora} com guarda de execução`
);
