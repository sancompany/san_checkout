/**
 * SAN CHECKOUT — src/utils/assinaturaWebhook.js
 *
 * Assina o webhook que o San Checkout ENVIA pro contratante.
 *
 * Sem isso, quem descobrisse a `webhook_url` de um contratante podia
 * mandar um POST dizendo "status: confirmado" e a loja liberava o
 * pedido sem ninguém ter pago — a URL sozinha não prova nada. Note que
 * é o mesmo raciocínio que já protegia as outras três fronteiras deste
 * projeto (o webhook que a Asaas manda pra cá, o /estornar e o admin);
 * essa era a única seta que ainda saía sem credencial.
 *
 * O esquema é o mesmo que Stripe e Asaas usam: assina
 * `timestamp.corpo` em vez de só o corpo, pra que uma requisição
 * capturada não possa ser reenviada depois (replay). O contratante
 * recalcula com a `api_key` que ele já tem e compara.
 *
 * Usa só `node:crypto` — nenhuma dependência nova.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Fora dessa janela o contratante deve recusar, mesmo com assinatura
 *  válida — é o que transforma uma requisição capturada em lixo. */
export const JANELA_TOLERANCIA_SEGUNDOS = 300;

/**
 * @param {string} corpoCru — o JSON exatamente como vai no body
 * @param {string} segredo — a `api_key` do contratante
 * @param {number} timestamp — epoch em SEGUNDOS
 * @returns {string} assinatura no formato `sha256=<hex>`
 */
export function assinarPayload(corpoCru, segredo, timestamp) {
  const assinatura = createHmac('sha256', segredo)
    .update(`${timestamp}.${corpoCru}`)
    .digest('hex');
  return `sha256=${assinatura}`;
}

/**
 * Confere uma assinatura recebida. O San Checkout não usa isto no
 * fluxo normal (quem verifica é o contratante, no servidor dele) — vive
 * aqui pra servir de referência exata do algoritmo na documentação e
 * pra ser exercitada pelo autoteste no fim do arquivo.
 *
 * @returns {boolean}
 */
export function assinaturaValida(corpoCru, segredo, timestamp, assinaturaRecebida) {
  const agora = Math.floor(Date.now() / 1000);
  if (Math.abs(agora - Number(timestamp)) > JANELA_TOLERANCIA_SEGUNDOS) return false;

  const esperada = assinarPayload(corpoCru, segredo, timestamp);

  // Comparação em tempo constante — mesmo motivo do `compararSeguro` em
  // validadores.js: comparar string com === vaza, pelo tempo de
  // resposta, quantos caracteres iniciais o atacante acertou.
  const a = Buffer.from(esperada);
  const b = Buffer.from(String(assinaturaRecebida ?? ''));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------
   Autoteste — `node src/utils/assinaturaWebhook.js`
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('assinaturaWebhook.js')) {
  const { strict: assertReal } = await import('node:assert');
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


  const corpo = JSON.stringify({ pedidoId: 'abc', status: 'confirmado' });
  const segredo = 'chave-de-teste';
  const agora = Math.floor(Date.now() / 1000);

  const assinatura = assinarPayload(corpo, segredo, agora);
  assert.ok(assinatura.startsWith('sha256='), 'formato do prefixo');
  assert.ok(assinaturaValida(corpo, segredo, agora, assinatura), 'assinatura própria vale');

  // corpo adulterado: é o ataque principal — trocar o status pra
  // "confirmado" sem pagar
  const adulterado = JSON.stringify({ pedidoId: 'abc', status: 'confirmado', valorCobrado: 0.01 });
  assert.ok(!assinaturaValida(adulterado, segredo, agora, assinatura), 'corpo adulterado é recusado');

  // segredo errado (quem não tem a api_key não consegue forjar)
  assert.ok(!assinaturaValida(corpo, 'chave-errada', agora, assinatura), 'segredo errado é recusado');

  // replay: assinatura legítima, mas velha
  const velho = agora - JANELA_TOLERANCIA_SEGUNDOS - 1;
  assert.ok(!assinaturaValida(corpo, segredo, velho, assinarPayload(corpo, segredo, velho)), 'replay é recusado');

  // assinatura de tamanho diferente não pode estourar o timingSafeEqual
  assert.ok(!assinaturaValida(corpo, segredo, agora, 'sha256=curta'), 'tamanho diferente é recusado');

  console.log(`assinaturaWebhook: ${checagens} checagens OK`);
}
