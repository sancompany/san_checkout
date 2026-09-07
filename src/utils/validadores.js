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
