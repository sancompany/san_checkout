/**
 * SAN CHECKOUT v2 — src/utils/validadores.js
 * Nunca confiar só na validação do front — este arquivo é a checagem
 * que não dá pra pular chamando a API direto.
 */

import { timingSafeEqual } from 'node:crypto';

/** Compara duas strings em tempo constante — usado em toda comparação
 *  de credencial/token vindo de fora (admin, webhook), pra não vazar
 *  por timing quantos caracteres bateram antes de falhar. */
export function compararSeguro(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function cpfValido(valor) {
  const cpf = String(valor ?? '').replace(/\D/g, '');
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const calcularDigito = (base) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (base.length + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  if (calcularDigito(cpf.slice(0, 9)) !== Number(cpf[9])) return false;
  if (calcularDigito(cpf.slice(0, 10)) !== Number(cpf[10])) return false;
  return true;
}

export function cnpjValido(valor) {
  const cnpj = String(valor ?? '').replace(/\D/g, '');
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const calcularDigito = (base, pesos) => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * pesos[i];
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const pesos2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  if (calcularDigito(cnpj.slice(0, 12), pesos1) !== Number(cnpj[12])) return false;
  if (calcularDigito(cnpj.slice(0, 13), pesos2) !== Number(cnpj[13])) return false;
  return true;
}

/** CPF (pessoa física) ou CNPJ (pessoa jurídica) no mesmo campo — a
 *  Asaas aceita os dois por baixo do mesmo `cpfCnpj`. Detecção
 *  automática só pelo tamanho (11 = CPF, 14 = CNPJ); qualquer outro
 *  tamanho é inválido. Usado em todo lugar que antes só aceitava CPF
 *  (Pix, Boleto, Cartão, Assinatura, cancelamento). */
export function documentoValido(valor) {
  const digitos = String(valor ?? '').replace(/\D/g, '');
  if (digitos.length === 11) return cpfValido(digitos);
  if (digitos.length === 14) return cnpjValido(digitos);
  return false;
}

export function emailValido(valor) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(valor ?? '').trim());
}

export function valorValido(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0 && numero <= 100000;
}

export function telefoneValido(valor) {
  const telefone = String(valor ?? '').replace(/\D/g, '');
  return telefone.length === 10 || telefone.length === 11;
}

export function cepValido(valor) {
  const cep = String(valor ?? '').replace(/\D/g, '');
  return cep.length === 8;
}
