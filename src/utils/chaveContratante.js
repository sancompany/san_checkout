/**
 * SAN CHECKOUT v2 — src/utils/chaveContratante.js
 * A `api_key` de um contratante: como nasce, e num lugar só.
 *
 * Existem dois momentos em que uma chave é criada — o cadastro e a
 * troca — e eles precisam produzir exatamente o mesmo tipo de segredo.
 * Duplicar `randomBytes(...)` nos dois seria duplicar uma decisão de
 * segurança, que é o tipo de duplicação que envelhece torto: alguém
 * melhora um lado e o outro fica para trás, sem ninguém notar, porque
 * chave fraca funciona igual a chave forte.
 *
 * 24 bytes = 192 bits de aleatoriedade de fonte criptográfica, em 48
 * caracteres hex. Não é derivada de nada (nem do id, nem do nome, nem
 * do relógio): chave previsível a partir de dado público é o mesmo que
 * não ter chave.
 */

import { randomBytes } from 'node:crypto';

export const BYTES_DA_CHAVE = 24;

export function gerarApiKey() {
  return randomBytes(BYTES_DA_CHAVE).toString('hex');
}

/* ------------------------------------------------------------------ */

if (process.argv[1]?.endsWith('chaveContratante.js')) {
  const { default: assertReal } = await import('node:assert/strict');
  /* O número de checagens era CHUMBADO no `console.log` do fim, e já
     estava errado — acrescentar assertiva não mexia nele. Contador
     chumbado é documento falso barato de produzir e caro de notar, e em
     17/09/2026 oito autotestes deste repositório tinham um. O proxy
     conta sem precisar reescrever as chamadas que já estavam aqui. */
  let checagens = 0;
  const assert = new Proxy(assertReal, {
    get(alvo, nome) {
      const valor = alvo[nome];
      if (typeof valor !== 'function') return valor;
      return (...argumentos) => { checagens += 1; return valor.apply(alvo, argumentos); };
    }
  });


  const chave = gerarApiKey();

  assert.equal(chave.length, BYTES_DA_CHAVE * 2, 'a chave tem 48 caracteres hex');
  assert.match(chave, /^[0-9a-f]+$/, 'a chave é hex minúsculo, sem separador');

  // Repetição é o único defeito que quebraria tudo em silêncio: duas
  // chaves iguais fariam a de um contratante autenticar o estorno de
  // outro. 500 amostras não provam a fonte, mas pegam o erro que
  // importa — alguém trocar `randomBytes` por algo com estado ou
  // semente fixa.
  const amostras = new Set(Array.from({ length: 500 }, () => gerarApiKey()));
  assert.equal(amostras.size, 500, 'nenhuma chave se repete em 500 gerações');

  console.log(`chaveContratante: ${checagens} checagens OK`);
}
