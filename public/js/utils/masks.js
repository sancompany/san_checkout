export function apenasDigitos(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

export function mascararCpf(valor) {
  const d = apenasDigitos(valor).slice(0, 11);
  let saida = d;
  if (d.length > 9) saida = `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  else if (d.length > 6) saida = `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  else if (d.length > 3) saida = `${d.slice(0, 3)}.${d.slice(3)}`;
  return saida;
}

/** (00) 00000-0000 — celular com DDD; também aceita fixo (10 dígitos). */
export function mascararTelefone(valor) {
  const d = apenasDigitos(valor).slice(0, 11);
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
