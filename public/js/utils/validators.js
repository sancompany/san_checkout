import { apenasDigitos } from './masks.js';

export function validarCpf(valor) {
  const cpf = apenasDigitos(valor);
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

export function validarEmail(valor) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(valor ?? '').trim());
}

export function validarObrigatorio(valor) {
  return String(valor ?? '').trim().length > 0;
}

export function validarTelefone(valor) {
  const digitos = apenasDigitos(valor);
  return digitos.length === 10 || digitos.length === 11;
}

export function validarCep(valor) {
  return apenasDigitos(valor).length === 8;
}
