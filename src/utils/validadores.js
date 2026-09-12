/**
 * SAN CHECKOUT v2 — src/utils/validadores.js
 * Nunca confiar só na validação do front — este arquivo é a checagem
 * que não dá pra pular chamando a API direto.
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * TETO DE TAMANHO POR CAMPO.
 *
 * Achado no ciclo de segurança da Estação 6 (11/09/2026): um `nome` de
 * 100 KB passava por toda a validação e seguia para a Asaas. O único
 * teto que existia era o global de 100 KB do `express.json()` — ou
 * seja, o limite do CORPO INTEIRO virava, na prática, o limite de um
 * campo só. O `maxlength` do formulário não conta: ele não existe para
 * quem chama a API direto, que é exatamente o caso que esta camada
 * existe para cobrir.
 *
 * O teto mora AQUI, e não em cada controller, porque são seis arquivos
 * chamando estes mesmos validadores. Regra repetida em seis lugares é
 * regra que um dia vale em cinco.
 *
 * Os números não são redondos por estética: 254 é o máximo de um
 * endereço de e-mail na RFC 5321, e os demais são o campo real com
 * folga para pontuação e formatação — CPF pontuado tem 14 caracteres,
 * telefone com DDD e traço tem 15.
 */
const TETOS = {
  nome: 150,
  email: 254,
  documento: 32,
  telefone: 32,
  cep: 16
};

/** Longo demais é recusa, não truncamento: truncar aceitaria um dado
 *  que o comprador não digitou e mandaria isso para a Asaas. */
function passaNoTeto(valor, teto) {
  return String(valor ?? '').length <= teto;
}

/** Compara duas strings em tempo constante — usado em toda comparação
 *  de credencial/token vindo de fora (admin, webhook), pra não vazar
 *  por timing quantos caracteres bateram antes de falhar. */
export function compararSeguro(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));

  /* VAZIO NUNCA BATE COM VAZIO.
     Sem esta linha, `compararSeguro(undefined, undefined)` devolve
     `true`: os dois viram '', os tamanhos batem, e `timingSafeEqual` de
     dois buffers vazios é verdadeiro. Ou seja, credencial ausente
     casando com header ausente — a falha abre em vez de fechar, e abre
     exatamente no cenário mais provável de todos, que é uma variável de
     ambiente faltando no deploy.

     Hoje os dois chamadores (verificarAdminKey e verificarWebhookAsaas)
     devolvem 503 antes de chegar aqui quando a env não existe, então
     isto não é buraco aberto — é o buraco que o TERCEIRO chamador
     herdaria por escrever uma linha a menos. A guarda mora na primitiva
     porque é ela que promete "comparação segura"; quem promete, cumpre
     sozinha.

     Achado no autoteste desta função, no ciclo da Estação 6 em
     11/09/2026.

     O retorno antecipado entrega, por tempo, que um dos lados é vazio —
     e isso é aceitável: "está configurado?" não é segredo, e os
     chamadores já respondem 503 em alto e bom som nesse caso. O que
     precisa ser constante é a comparação entre dois valores reais. */
  if (bufA.length === 0 || bufB.length === 0) return false;

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
  if (!passaNoTeto(valor, TETOS.documento)) return false;
  const digitos = String(valor ?? '').replace(/\D/g, '');
  if (digitos.length === 11) return cpfValido(digitos);
  if (digitos.length === 14) return cnpjValido(digitos);
  return false;
}

export function emailValido(valor) {
  if (!passaNoTeto(valor, TETOS.email)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(valor ?? '').trim());
}

export function valorValido(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0 && numero <= 100000;
}

export function telefoneValido(valor) {
  if (!passaNoTeto(valor, TETOS.telefone)) return false;
  const telefone = String(valor ?? '').replace(/\D/g, '');
  return telefone.length === 10 || telefone.length === 11;
}

export function cepValido(valor) {
  if (!passaNoTeto(valor, TETOS.cep)) return false;
  const cep = String(valor ?? '').replace(/\D/g, '');
  return cep.length === 8;
}

/**
 * `nome` nunca teve validador — só era checado por ser verdadeiro, o
 * que aceitava tanto "a" quanto 100 KB de texto. É o campo que vai
 * para a Asaas como nome do cliente e volta impresso no boleto.
 *
 * Só tamanho, de propósito: nome de pessoa não tem formato. Regra de
 * "letras e espaços" recusa nome com apóstrofo, hífen, número de
 * sufixo e caractere de outro alfabeto — recusar comprador legítimo no
 * caminho do dinheiro é pior que aceitar um nome esquisito.
 */
export function nomeValido(valor) {
  const nome = String(valor ?? '').trim();
  return nome.length >= 2 && nome.length <= TETOS.nome;
}

export { TETOS as TETOS_DE_CAMPO };

/* ====================================================================
   AUTOTESTE — `node src/utils/validadores.js`
   Roda junto com os outros em `npm test` (tests/executar.js).
   ==================================================================== */
if (process.argv[1]?.endsWith('validadores.js')) {
  const assert = (await import('node:assert/strict')).default;

  // --- documento ---
  assert.ok(documentoValido('111.444.777-35'), 'CPF válido pontuado');
  assert.ok(documentoValido('11144477735'), 'CPF válido só dígitos');
  assert.ok(!documentoValido('11111111111'), 'CPF de dígito repetido recusa');
  assert.ok(!documentoValido('11144477734'), 'CPF de dígito errado recusa');
  assert.ok(documentoValido('11.222.333/0001-81'), 'CNPJ válido');
  assert.ok(!documentoValido('11222333000180'), 'CNPJ de dígito errado recusa');
  assert.ok(!documentoValido(''), 'vazio recusa');
  assert.ok(!documentoValido(null), 'nulo recusa');

  // --- e-mail ---
  assert.ok(emailValido('a@b.co'), 'e-mail mínimo passa');
  assert.ok(!emailValido('sem-arroba'), 'sem arroba recusa');
  assert.ok(!emailValido('a@b'), 'sem ponto no domínio recusa');

  // --- telefone e CEP ---
  assert.ok(telefoneValido('(11) 99999-9999'), 'celular com DDD passa');
  assert.ok(telefoneValido('1133334444'), 'fixo com DDD passa');
  assert.ok(!telefoneValido('999999999'), '9 dígitos recusa');
  assert.ok(cepValido('01310-100'), 'CEP pontuado passa');
  assert.ok(!cepValido('0131010'), 'CEP de 7 dígitos recusa');

  // --- valor ---
  assert.ok(valorValido(0.01), 'centavo passa');
  assert.ok(!valorValido(0), 'zero recusa');
  assert.ok(!valorValido(-1), 'negativo recusa');
  assert.ok(!valorValido(100001), 'acima do teto recusa');
  assert.ok(!valorValido('abc'), 'texto recusa');

  // --- nome ---
  assert.ok(nomeValido('Ana'), 'nome curto passa');
  assert.ok(nomeValido("Maria D'Ávila-Souza Jr."), 'apóstrofo, hífen e sufixo passam');
  assert.ok(nomeValido('李小龍'), 'outro alfabeto passa');
  assert.ok(!nomeValido('A'), 'uma letra recusa');
  assert.ok(!nomeValido('   '), 'só espaço recusa');
  assert.ok(!nomeValido(''), 'vazio recusa');

  /* --- OS TETOS ---
     Esta é a parte que o ciclo de segurança da Estação 6 encontrou
     aberta em produção: um `nome` de 100 KB atravessava toda a
     validação e seguia para a Asaas, porque o único teto existente era
     o do corpo inteiro no `express.json()`.

     Cada asserção abaixo vale por um campo. Se alguém apagar o
     `passaNoTeto` de um deles "porque não fazia nada", o teste que cai
     aponta exatamente qual. */
  const CEM_KB = 'a'.repeat(100000);

  assert.ok(!nomeValido(CEM_KB), 'nome de 100 KB tem que ser recusado');
  assert.ok(!emailValido(`${'a'.repeat(300)}@b.co`), 'e-mail acima de 254 recusa');
  assert.ok(emailValido(`${'a'.repeat(240)}@bc.co`), 'e-mail de 247 ainda passa');
  assert.ok(!documentoValido(`${' '.repeat(100)}11144477735`), 'documento longo recusa mesmo com CPF válido dentro');
  assert.ok(!telefoneValido(`${' '.repeat(100)}11999999999`), 'telefone longo recusa mesmo com número válido dentro');
  assert.ok(!cepValido(`${' '.repeat(100)}01310100`), 'CEP longo recusa mesmo com CEP válido dentro');

  /* Os dois últimos são o ponto fino: sem o teto, `replace(/\D/g,'')`
     descarta o lixo e o campo passa — um documento de 100 KB seria
     aceito como CPF válido. O teto tem que vir ANTES da normalização,
     nunca depois. */

  // --- comparação em tempo constante ---
  assert.ok(compararSeguro('abc', 'abc'), 'iguais batem');
  assert.ok(!compararSeguro('abc', 'abd'), 'diferentes não batem');
  assert.ok(!compararSeguro('abc', 'abcd'), 'tamanhos diferentes não batem');
  assert.ok(!compararSeguro('', ''), 'vazio NÃO bate com vazio — env faltando não pode virar acesso');
  assert.ok(!compararSeguro(undefined, undefined), 'nulo NÃO bate com nulo');
  assert.ok(!compararSeguro(undefined, 'segredo'), 'header ausente não bate com segredo');
  assert.ok(!compararSeguro('segredo', ''), 'segredo não bate com vazio');

  console.log('validadores: 40 checagens OK');
}
