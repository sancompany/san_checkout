/**
 * public/js/utils/cep.js
 * Busca endereço a partir do CEP via ViaCEP (API pública, sem chave) —
 * usado só pra Cartão/Assinatura, porque a Asaas exige endereço
 * completo como antifraude no Asaas Checkout (confirmado em sandbox:
 * "O campo address deve ser informado" sem isso).
 *
 * IMPORTANTE: o campo `city` que a Asaas espera é o CÓDIGO IBGE do
 * município (número), não o nome — confirmado no schema oficial
 * (CheckoutSessionCustomerDataDTO, exemplo "city": 4205407). O ViaCEP é
 * o que devolve esse código pronto (campo `ibge`) — por isso o CEP não
 * é só conveniência de UX aqui, é a única fonte prática desse código
 * sem manter uma tabela de municípios própria.
 */

import { apenasDigitos } from './masks.js';

/**
 * @param {string} cep
 * @returns {Promise<{ logradouro, bairro, cidade, uf, ibge } | null>}
 *   null quando o CEP não existe ou a busca falha (rede fora, ViaCEP
 *   indisponível) — quem chamar decide como avisar o usuário.
 */
export async function buscarEnderecoPorCep(cep) {
  const digitos = apenasDigitos(cep);
  if (digitos.length !== 8) return null;

  try {
    const resposta = await fetch(`https://viacep.com.br/ws/${digitos}/json/`);
    if (!resposta.ok) return null;

    const dados = await resposta.json();
    if (dados.erro) return null;

    return {
      logradouro: dados.logradouro ?? '',
      bairro: dados.bairro ?? '',
      cidade: dados.localidade ?? '',
      uf: dados.uf ?? '',
      ibge: dados.ibge ?? ''
    };
  } catch {
    return null;
  }
}
