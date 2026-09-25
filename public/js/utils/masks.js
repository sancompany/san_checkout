export function apenasDigitos(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

/** CPF ou CNPJ no mesmo campo — formata como CPF progressivo até 11
 *  dígitos; do 12º em diante, vira CNPJ progressivo. */
export function mascararDocumento(valor) {
  const d = apenasDigitos(valor).slice(0, 14);
  if (d.length > 11) {
    let saida = d;
    if (d.length > 12) saida = `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
    else saida = `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
    return saida;
  }
  let saida = d;
  if (d.length > 9) saida = `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  else if (d.length > 6) saida = `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  else if (d.length > 3) saida = `${d.slice(0, 3)}.${d.slice(3)}`;
  return saida;
}

/**
 * DDD + número, sem o código do país — a MESMA regra do servidor
 * (`normalizarTelefone`, `src/utils/validadores.js`). O autopreenchimento
 * entrega `+55 16 98765-4321`, e cortar os primeiros 11 dígitos lia `55`
 * como DDD (25/09/2026). 12 ou 13 dígitos começando por 55: o 55 é o
 * país. Número nacional com DDD 55 tem 10 ou 11, e fica como está.
 */
export function normalizarTelefone(valor) {
  const d = apenasDigitos(valor);
  return /^55\d{10,11}$/.test(d) ? d.slice(2) : d;
}

/** (00) 00000-0000 — celular com DDD; também aceita fixo (10 dígitos). */
export function mascararTelefone(valor) {
  const d = normalizarTelefone(valor).slice(0, 11);
  if (d.length > 10) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length > 6) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  if (d.length > 2) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  return d;
}

/** 00000-000 */
export function mascararCep(valor) {
  const d = apenasDigitos(valor).slice(0, 8);
  if (d.length > 5) return `${d.slice(0, 5)}-${d.slice(5)}`;
  return d;
}
