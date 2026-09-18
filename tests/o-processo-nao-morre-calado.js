#!/usr/bin/env node
/**
 * tests/o-processo-nao-morre-calado.js
 *
 * UMA invariante, e ela é de operação:
 *
 *   **o processo não pode morrer sem deixar registro do motivo.**
 *
 * A captura de exceção da Lei 8 (`erroService` → tabela `erros`) pega o
 * que passa pelo `responderErro` de um controlador ou pelo tratador de
 * erro do Express. O que mata o processo fica de fora exatamente por
 * não passar por rota nenhuma:
 *
 *   - promessa rejeitada sem `catch` (`unhandledRejection`) — e este
 *     projeto tem fire-and-forget deliberado no caminho do dinheiro
 *     (aviso ao contratante, auditoria do webhook, expurgo, retentativa
 *     agendada por `setTimeout`);
 *   - exceção fora de requisição (`uncaughtException`) — callback de
 *     `setInterval`, de `setTimeout`, topo de módulo.
 *
 * Nos dois casos o Node imprime no stderr e **encerra**. Como o log do
 * Northflank só se lê pelo painel (`RUNBOOK` §7), sem os tratadores o
 * que sobra é um serviço reiniciando sem nenhuma linha em `erros`.
 *
 * POR QUE ISTO MERECE TESTE, E EM PROCESSO FILHO
 * Porque não dá para provar de dentro: o teste que checasse
 * `process.listenerCount` provaria que o tratador está registrado, não
 * que ele grava e mata. Então cada caso sobe o `server.js` DE VERDADE
 * num processo separado, quebra ele de propósito, e confere o código de
 * saída e a linha de log. É o mesmo princípio do teste da pessoa número
 * dois: exercitar, não ler.
 *
 * O `SUPABASE_URL` aponta para uma porta morta de propósito: a escrita
 * em `erros` falha, e o teste prova que a FALHA DELA não impede o
 * processo de morrer contando. Observabilidade que trava o
 * encerramento deixou de ser observabilidade.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

const AMBIENTE = {
  ...process.env,
  CHECKOUT_SEM_LISTEN: '1',
  SUPABASE_URL: 'http://127.0.0.1:1',
  SUPABASE_SERVICE_KEY: 'teste'
};

/** Sobe o server.js num filho e roda `quebra` depois de ele montar. */
function rodarFilho(quebra, ambiente = AMBIENTE) {
  const roteiro = `
    await import(${JSON.stringify(join(RAIZ, 'src/server.js'))});
    ${quebra}
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', roteiro], {
    cwd: RAIZ, env: ambiente, encoding: 'utf8', timeout: 30000
  });
}

/** Servidor que ACEITA a conexão e nunca responde — é como um banco
 *  pendurado se comporta, e é diferente de porta fechada: porta fechada
 *  falha na hora, banco mudo pendura. */
function servidorMudo() {
  const servidor = createServer((socket) => { socket.on('error', () => {}); });
  // `listen` é assíncrono: `address()` só existe depois do evento, e
  // ler antes devolve null (foi o primeiro erro deste teste).
  return new Promise((resolver) => {
    servidor.listen(0, '127.0.0.1', () => resolver(servidor));
  });
}

let checagens = 0;
const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

/* --- 1. promessa rejeitada sem catch ----------------------------- */
let r = rodarFilho("Promise.reject(new Error('rejeicao de propósito'));");
const saida1 = `${r.stdout ?? ''}${r.stderr ?? ''}`;

conferir(r.status === 1, `rejeição não observada tem que sair com código 1, veio ${r.status}`);
conferir(
  /unhandledRejection/.test(saida1),
  'e tem que DIZER o que foi, no log — sem isso o serviço reinicia sem motivo conhecido'
);
conferir(
  /rejeicao de propósito/.test(saida1),
  'com a mensagem do erro original, que é a única pista de onde consertar'
);
conferir(
  /o processo vai encerrar/.test(saida1),
  'e deixando claro que o encerramento é deliberado, não um segundo defeito'
);

/* A GRAVAÇÃO foi TENTADA, e não só o log impresso.
   Esta checagem entrou porque o teste passou sabotado: com o
   `registrarErro` arrancado do tratador, as três de cima continuavam
   verdes — sobrava um tratador que loga e mata, que é metade do que a
   Lei 8 pede. Aqui a prova é indireta e por isso funciona: o
   `SUPABASE_URL` aponta para porta morta, então a tentativa de escrita
   FALHA e deixa a própria marca no log. Sem a tentativa, a marca não
   existe. */
conferir(
  /erroService\.registrarErro/.test(saida1),
  'a gravação em `erros` tem que ser TENTADA — sem ela o tratador só loga, e log do Northflank se lê pelo painel'
);
/* E a gravação FALHOU (porta morta) sem impedir o encerramento — as
   duas coisas na mesma checagem, porque é o par que importa:
   observabilidade que trava o encerramento deixou de ser
   observabilidade. */
conferir(
  /erroService\.registrarErro\] .*(fetch failed|ECONNREFUSED|falhou em silêncio)/.test(saida1) && r.status === 1,
  'a gravação falhou (porta morta) e o processo morreu de qualquer forma'
);

/* --- 1b. e se a gravação PENDURAR? O teto tem que matar ----------
   Porta fechada falha na hora; banco pendurado é outra coisa — e o
   Supabase não tem teto de tempo próprio, que é a razão de existir
   `tests/nenhuma-chamada-de-saida-sem-teto.js`. Sem um timer que
   segure o processo até disparar, o encerramento fica pendurado junto,
   e o serviço não reinicia: fica de pé, num estado desconhecido, com o
   `/api/saude` respondendo 200.

   Este caso prova que o encerramento acontece mesmo com a escrita
   pendurada. Ele NÃO distingue timer referenciado de timer com
   `unref()` — medido: com o socket pendurado, o loop fica vivo e o
   timer com `unref()` dispara igual. A escolha de manter o timer
   referenciado é para a garantia não depender de outra coisa segurar o
   loop, e isso é desenho, não comportamento observável daqui. */
{
  const mudo = await servidorMudo();
  const porta = mudo.address().port;
  const comeco = Date.now();
  const filho = rodarFilho("Promise.reject(new Error('rejeicao com banco mudo'));", {
    ...AMBIENTE, SUPABASE_URL: `http://127.0.0.1:${porta}`
  });
  const decorrido = Date.now() - comeco;
  mudo.close();

  conferir(
    filho.status === 1,
    `com o banco pendurado o processo ainda tem que morrer com 1, veio ${filho.status} (${decorrido} ms)`
  );
  conferir(
    decorrido < 20000,
    `e morrer pelo teto, não pelo tempo do sistema operacional — levou ${decorrido} ms`
  );
}

/* --- 2. exceção fora de requisição ------------------------------ */
r = rodarFilho("setTimeout(() => { throw new Error('excecao de propósito'); }, 10);");
const saida2 = `${r.stdout ?? ''}${r.stderr ?? ''}`;

conferir(r.status === 1, `exceção fora de requisição sai com código 1, veio ${r.status}`);
conferir(/uncaughtException/.test(saida2), 'e diz que foi exceção não capturada');
conferir(/excecao de propósito/.test(saida2), 'com a mensagem original');

/* --- 3. CONTROLE POSITIVO: sem quebra, o processo não morre ------
   Sem este par, um tratador que chamasse `process.exit(1)` sempre
   passaria nos dois testes acima e derrubaria o serviço no boot. */
r = rodarFilho("console.log('subiu inteiro');");
const saida3 = `${r.stdout ?? ''}${r.stderr ?? ''}`;

conferir(r.status === 0, `boot normal sai com 0, veio ${r.status}`);
conferir(/subiu inteiro/.test(saida3), 'e o processo chega ao fim do roteiro');
conferir(
  !/vai encerrar/.test(saida3),
  'boot normal não pode imprimir encerramento — se imprime, o tratador está disparando sozinho'
);

console.log(`o-processo-nao-morre-calado: ${checagens} checagens OK`);
