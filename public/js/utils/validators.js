import { apenasDigitos, normalizarTelefone } from './masks.js';

function validarCpf(valor) {
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

function validarCnpj(valor) {
  const cnpj = apenasDigitos(valor);
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

/** CPF ou CNPJ no mesmo campo — detecção automática só pelo tamanho
 *  (11 = CPF, 14 = CNPJ), espelhando src/utils/validadores.js. */
export function validarDocumento(valor) {
  const digitos = apenasDigitos(valor);
  if (digitos.length === 11) return validarCpf(digitos);
  if (digitos.length === 14) return validarCnpj(digitos);
  return false;
}

export function validarEmail(valor) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(valor ?? '').trim());
}

export function validarObrigatorio(valor) {
  return String(valor ?? '').trim().length > 0;
}

export function validarTelefone(valor) {
  const digitos = normalizarTelefone(valor);
  return digitos.length === 10 || digitos.length === 11;
}

export function validarCep(valor) {
  return apenasDigitos(valor).length === 8;
}
