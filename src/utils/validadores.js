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
  cep: 16,
  /* ENDEREÇO — mesma razão do `nome`: texto livre que a Asaas aceita e
     grava sem teto próprio, e que antes só era checado por presença
     (achado no ciclo de revisão do projeto inteiro em 18/09/2026, junto
     do `telefone` sem validação em três rotas — ver abaixo). Números
     folgados para o dado real: rua e complemento não passam de umas
     dezenas de caracteres; `uf` é sempre 2 letras. */
  endereco: 200,
  enderecoNumero: 20,
  complemento: 100,
  bairro: 100,
  cidade: 100,
  uf: 2,
  /* IDENTIFICADOR DE PEDIDO E DE PLANO — 128.
     Eles não vinham com teto nenhum, e é o caso da lição nº 24 (teto
     mora no validador, não em cada controlador): entram por parâmetro
     de URL e por corpo, viram caminho de uma requisição HTTP ao
     contratante e literal de consulta no banco. 128 é folgado para o
     que existe de verdade — UUID tem 36, hash SHA-256 em hex tem 64 —,
     e o que passa disso não é id: é carga. */
  id: 128
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

/**
 * O `documento` guardado e o `documento` buscado precisam ser a MESMA
 * string, e até 17/09/2026 não eram.
 *
 * `documentoValido` tira a pontuação para VALIDAR, mas devolve só
 * `true`/`false` — quem grava gravava o texto cru do corpo da
 * requisição. Então `552.085.198-01` e `55208519801` são o mesmo CPF,
 * passam os dois na validação, e viram duas chaves diferentes no banco.
 *
 * O dano não é cosmético, e está no caminho do dinheiro: a assinatura é
 * localizada por `contratante_id + plano_id + documento`
 * (`API.md` §5.5). Quem assinasse mandando o CPF pontuado e depois
 * pedisse cancelamento mandando só dígitos receberia `404` — assinatura
 * incancelável pela API, exatamente o furo de mão única que a RN de
 * 15/09 corrigiu por outro caminho. E vale nos dois sentidos.
 *
 * Passava despercebido porque a máscara do front tira a pontuação antes
 * de enviar — as 13 linhas em produção em 17/09/2026 são todas só
 * dígitos, conferido. Mas a máscara é do navegador, e a API é pública:
 * quem chama direto manda o que quiser. Achado pelo ciclo da skill
 * `revisar` enquanto se escrevia a rotina de expurgo, que precisava
 * casar documento para atender pedido de titular.
 *
 * A normalização é para DÍGITOS porque é o formato que já está gravado
 * (nenhuma linha precisa ser convertida) e o que a Asaas espera em
 * `cpfCnpj`.
 */
export function normalizarDocumento(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

export function emailValido(valor) {
  if (!passaNoTeto(valor, TETOS.email)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(valor ?? '').trim());
}

export function valorValido(valor) {
  const numero = Number(valor);
  return Number.isFinite(numero) && numero > 0 && numero <= 100000;
}

/**
 * PISO DE VALOR DA ASAAS — R$ 5,00 sobre o valor COBRADO.
 *
 * MEDIDO em 17/09/2026 de dentro do contêiner de produção, contra o
 * sandbox, com controle positivo em R$ 5,00 exato (que passa nos seis
 * caminhos). Sem o controle, um 400 qualquer passaria por "piso":
 *
 *   POST /v3/payments      PIX          2,50 → 400 "O valor da cobrança (R$ 2,50) menos o valor do desconto (R$ 0,00) não pode ser menor que R$ 5,00."
 *   POST /v3/payments      BOLETO       2,50 → 400 "O valor mínimo para cobranças via Boleto Bancário é R$ 5,00."
 *   POST /v3/payments      CREDIT_CARD  2,50 → 400 "O valor mínimo para cobranças via Cartão de Crédito é R$ 5,00."
 *   POST /v3/payments      UNDEFINED    2,50 → 400 "... forma de pagamento Pergunte ao Cliente é R$ 5,00."
 *   POST /v3/subscriptions CREDIT_CARD  2,50 → 400 "O valor mínimo para cobranças via cartão de crédito é R$ 5,00."
 *   POST /v3/checkouts     CREDIT_CARD  2,50 → 400 (mesma mensagem do Pix)
 *   os seis, em 5,00        → 200 (e as cobranças criadas foram apagadas)
 *
 * NÃO é a mesma regra de `valorValido`, e os dois têm de coexistir:
 * `valorValido` guarda o valor que VEM do contratante (aceita de
 * R$ 0,01, porque um item barato dentro de um pedido maior é legítimo);
 * este guarda o que VAI para a Asaas, depois da taxa. Um pedido de
 * R$ 4,00 fecha em R$ 5,53 e passa; um de R$ 2,00 fecha em R$ 3,48 e
 * não passa.
 *
 * O piso mora numa constante e não espalhado: se a Asaas mexer nele, o
 * lugar de trocar é um só. Não vem de variável de ambiente de
 * propósito — é regra do provedor, não configuração nossa, e a
 * mensagem ao comprador cita o número.
 */
export const PISO_ASAAS = 5;

/** Compara em CENTAVOS, que é a unidade que a Asaas lê. `valorCobrado`
 *  já chega arredondado em 2 casas de `calcularTaxa`; comparar em reais
 *  com ponto flutuante deixaria 4,999999999 passar por 5. */
export function valorCobradoAceitavel(valorCobrado) {
  const numero = Number(valorCobrado);
  if (!Number.isFinite(numero)) return false;
  return Math.round(numero * 100) >= PISO_ASAAS * 100;
}

/**
 * QUANTAS PARCELAS CABEM NUM VALOR — o piso da Asaas é POR PARCELA.
 *
 * Medido em 17/09/2026, e foi um buraco na primeira medição: eu havia
 * medido o piso só com UMA parcela. Com `installmentCount`, a Asaas
 * aplica os R$ 5,00 a cada parcela, não ao total:
 *
 *   POST /v3/payments  totalValue 10,00 em 12x (parcela 0,83) → 400
 *   POST /v3/payments  totalValue 24,00 em 12x (parcela 2,00) → 400
 *   POST /v3/payments  totalValue 60,00 em 12x (parcela 5,00) → 200
 *
 * E o pior detalhe: `POST /v3/checkouts` **aceita** a sessão nos três
 * casos (medido). Ou seja, a pop-up abre, o comprador escolhe 12x,
 * digita o cartão — e só então a cobrança é recusada, dentro da pop-up,
 * com mensagem da Asaas. É o mesmo dano do piso sobre o total, só mais
 * fundo no caminho, e a checagem do total não o alcança.
 *
 * Por isso a correção NÃO é recusar: é ofertar menos parcelas. Recusar
 * um pedido de R$ 24,00 porque alguém pediu 12x seria perder uma venda
 * que a Asaas faz em 5x (R$ 26,15 com taxa, parcela de R$ 5,23 —
 * conferido) sem reclamar. Recusar o que o provedor aceita é a falha
 * que este arquivo evita em `nomeValido` e `telefoneValido` pelo mesmo
 * motivo.
 */
/**
 * O teto de parcelas do CHECKOUT — regra nossa, não da Asaas.
 *
 * Ele morava em três lugares: no validador de entrada do cartão
 * (`parcelasValidas`), na lista do `public/index.html`, e no cálculo de
 * `maxParcelas` no `pedidoController`. Três cópias de um número é uma
 * cópia a mais do que dá para manter em acordo — e o modo de falhar é
 * silencioso: a tela oferece 12, o backend aceita 10, e ninguém percebe
 * até alguém escolher 11.
 *
 * O HTML continua listando as opções (é markup, não pode importar
 * daqui), mas quem MANDA é este número: o servidor devolve `maxParcelas`
 * e a tela corta a lista. Se os dois discordarem, o servidor ganha.
 */
export const MAXIMO_DE_PARCELAS_DO_CHECKOUT = 12;

export function parcelasValidas(valor) {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero >= 1 && numero <= MAXIMO_DE_PARCELAS_DO_CHECKOUT;
}

export function maximoDeParcelas(valorCobrado) {
  const numero = Number(valorCobrado);
  if (!Number.isFinite(numero) || numero <= 0) return 1;
  // Em centavos, como a Asaas lê — ver `valorCobradoAceitavel`.
  return Math.max(1, Math.floor(Math.round(numero * 100) / (PISO_ASAAS * 100)));
}

/** Uma frase só, e ela é mostrada ao COMPRADOR — por isso diz o que
 *  fazer ("peça um link"), não o nome do provedor: quem está na tela
 *  não tem contrato com a Asaas e não pode fazer nada com esse nome. */
export const MENSAGEM_PISO_ASAAS =
  `O valor mínimo para pagamento é de R$ ${PISO_ASAAS},00. ` +
  'Este link está abaixo disso — peça um link novo ao vendedor.';

/**
 * REGRA MEDIDA contra a Asaas em 17/09/2026 (24 combinações, de dentro
 * do contêiner de produção, `POST /v3/checkouts` com
 * `customerData.phone`; as sessões criadas foram canceladas).
 *
 * A `docs/pendencias.md` dizia que a Asaas recusa "número de dígito
 * repetido". NÃO É VERDADE, e escrever o validador contra essa frase
 * teria recusado comprador legítimo: `11988888888` e `11911111111`
 * passam. O que ela recusa de verdade:
 *
 *   recusa 400            aceita 200
 *   11999999999           11988888888   11911111111   11999999998
 *   11099999999           11990000000   11922222222   11912345678
 *   11899999999           1133334444    1132165498    21999998888
 *   1111111111            1112345678    1122223333    1162345678
 *   1900000000            1192345678    9933334444    2033334444
 *   00999999999
 *   0199999999
 *   1033334444
 *
 * Três regras explicam os 24 pontos, e nenhuma delas é "dígito repetido":
 *   1. DDD (os dois primeiros dígitos) >= 11 — `10`, `01` e `00` caem.
 *   2. Com 11 dígitos (celular), o dígito depois do DDD tem de ser `9`
 *      — `11099999999` e `11899999999` caem por isso, não por repetição.
 *   3. A parte LOCAL (depois do DDD) não pode ser um único dígito
 *      repetido — `999999999`, `11111111` e `00000000` caem.
 *      Repare que a regra é sobre a parte local: `11988888888` tem oito
 *      `8` seguidos e passa, porque o local é `988888888`.
 *
 * O que fica DE FORA de propósito, embora não exista no Brasil: a Asaas
 * aceita DDD inexistente (`20`) e prefixo de fixo inexistente (`1`,
 * `6`). Recusar aqui o que o provedor aceita é bloquear comprador
 * legítimo no caminho do dinheiro — mesma razão de `nomeValido` só
 * olhar tamanho. Este validador recusa o que a Asaas recusaria, e nada
 * além.
 */
/**
 * Telefone brasileiro na forma ÚNICA: DDD + número, só dígitos, sem o
 * código do país.
 *
 * Existe por causa do autopreenchimento do navegador (relatado pelo
 * dono em 25/09/2026): ele entrega `+55 16 98765-4321`, e cortar os
 * primeiros 11 dígitos lia `55` como DDD. Regra: tira tudo que não é
 * dígito; se sobraram 12 ou 13 começando por `55`, o `55` é o país e
 * sai. O comprimento é o que desfaz a ambiguidade com o DDD 55 (RS):
 * número nacional com DDD 55 tem 10 ou 11 dígitos, nunca 12 ou 13.
 *
 *   16987654321 · (16) 98765-4321 · +55 16 98765-4321 · 55 16 98765-4321
 *   → todos `16987654321`
 */
export function normalizarTelefone(valor) {
  const digitos = String(valor ?? '').replace(/\D/g, '');
  return /^55\d{10,11}$/.test(digitos) ? digitos.slice(2) : digitos;
}

export function telefoneValido(valor) {
  if (!passaNoTeto(valor, TETOS.telefone)) return false;
  const telefone = normalizarTelefone(valor);
  if (telefone.length !== 10 && telefone.length !== 11) return false;

  if (Number(telefone.slice(0, 2)) < 11) return false;

  const local = telefone.slice(2);
  if (telefone.length === 11 && local[0] !== '9') return false;
  if (/^(\d)\1*$/.test(local)) return false;

  return true;
}

export function cepValido(valor) {
  if (!passaNoTeto(valor, TETOS.cep)) return false;
  const cep = String(valor ?? '').replace(/\D/g, '');
  return cep.length === 8;
}

/**
 * Teto de tamanho para os campos de endereço — sem formato, porque a
 * Asaas trata rua/bairro/cidade como texto livre e quem valida o
 * conteúdo é o antifraude dela. Recebe um objeto { campo: valor } e
 * confere cada um contra o teto do MESMO nome em `TETOS`; campo ausente
 * (`undefined`, ex. `complemento` opcional) passa — quem exige presença
 * é o controlador, não este validador.
 */
export function camposDeEnderecoDentroDoTeto(campos) {
  return Object.entries(campos).every(
    ([campo, valor]) => valor === undefined || passaNoTeto(valor, TETOS[campo])
  );
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

/**
 * Recusa id fora do teto — usado nas TRÊS portas por onde um id de
 * pedido ou de plano entra no sistema: os resolvedores que chamam a API
 * do contratante (`pedidoService`), a busca de assinatura
 * (`assinaturaService`) e a busca de cobrança por pedido
 * (`cobrancaService`).
 *
 * Mora aqui, e a guarda fica nas funções compartilhadas em vez de em
 * cada controlador, por duas razões: a skill `construir` manda corrigir
 * na raiz ("uma guarda na função compartilhada é um diff menor que uma
 * guarda em cada chamador, e não deixa os chamadores irmãos quebrados"),
 * e chamador novo nasce coberto.
 *
 * Lança com `.status` para `utils/erros.js` devolver 400 e a mensagem —
 * ela é segura de mostrar, e ajuda quem integra a entender a recusa.
 */
export function exigirIdNoTeto(id, rotulo) {
  if (passaNoTeto(id, TETOS.id)) return;
  const erro = new Error(`O ${rotulo} excede o tamanho máximo de ${TETOS.id} caracteres.`);
  erro.status = 400;
  throw erro;
}

export { TETOS as TETOS_DE_CAMPO };

/* ====================================================================
   AUTOTESTE — `node src/utils/validadores.js`
   Roda junto com os outros em `npm test` (tests/executar.js).
   ==================================================================== */
if (process.argv[1]?.endsWith('validadores.js')) {
  const assertReal = (await import('node:assert/strict')).default;

  /* CONTADOR DE VERDADE — a explicação canônica, e os outros autotestes
     apontam para cá.

     O número de checagens era CHUMBADO no `console.log` do fim, e
     acrescentar assertiva não mexia nele. Em 17/09/2026 oito autotestes
     deste repositório tinham um, e três mentiam: este dizia 40 e tinha
     91, `taxaService` dizia 13 e tinha 28, e `senhaAdmin` dizia 22 e
     tinha 20 — este último SUPERESTIMANDO, que é a direção pior, porque
     anuncia cobertura que não existe.

     Contador chumbado é documento falso barato de produzir e caro de
     notar: ninguém confere um número num log verde. O proxy existe para
     contar sem reescrever as dezenas de chamadas `assert.ok(...)` que já
     estavam aqui — reescrever todas seria um diff grande por um ganho
     que a envolvente dá de graça. */
  let checagens = 0;
  const assert = new Proxy(assertReal, {
    get(alvo, nome) {
      const valor = alvo[nome];
      if (typeof valor !== 'function') return valor;
      return (...argumentos) => { checagens += 1; return valor.apply(alvo, argumentos); };
    }
  });

  // --- documento ---
  assert.ok(documentoValido('111.444.777-35'), 'CPF válido pontuado');
  assert.ok(documentoValido('11144477735'), 'CPF válido só dígitos');
  assert.ok(!documentoValido('11111111111'), 'CPF de dígito repetido recusa');
  assert.ok(!documentoValido('11144477734'), 'CPF de dígito errado recusa');
  assert.ok(documentoValido('11.222.333/0001-81'), 'CNPJ válido');
  assert.ok(!documentoValido('11222333000180'), 'CNPJ de dígito errado recusa');
  assert.ok(!documentoValido(''), 'vazio recusa');
  assert.ok(!documentoValido(null), 'nulo recusa');

  /* --- NORMALIZAÇÃO DO DOCUMENTO ---
     A regra é "o que se grava e o que se busca têm de ser a mesma
     string". Sem ela, assinatura criada com CPF pontuado não é
     encontrada por quem manda só dígitos — e a rota de cancelar
     responde 404 sobre uma assinatura que existe e está cobrando. */
  assert.equal(normalizarDocumento('552.085.198-01'), '55208519801', 'CPF pontuado vira dígitos');
  assert.equal(normalizarDocumento('55208519801'), '55208519801', 'CPF já em dígitos não muda');
  assert.equal(normalizarDocumento('  552 085 198 01 '), '55208519801', 'espaço e separador solto também somem');
  assert.equal(normalizarDocumento('11.222.333/0001-81'), '11222333000181', 'CNPJ pontuado vira dígitos');
  assert.equal(
    normalizarDocumento('552.085.198-01'), normalizarDocumento('55208519801'),
    'as duas formas do MESMO documento colapsam na mesma chave — é o ponto inteiro'
  );
  assert.equal(normalizarDocumento(null), '', 'nulo vira string vazia, não "null"');
  assert.equal(normalizarDocumento(undefined), '', 'ausente idem');

  // --- e-mail ---
  assert.ok(emailValido('a@b.co'), 'e-mail mínimo passa');
  assert.ok(!emailValido('sem-arroba'), 'sem arroba recusa');
  assert.ok(!emailValido('a@b'), 'sem ponto no domínio recusa');

  /* --- TELEFONE ---
     Cada linha é um ponto MEDIDO contra a Asaas em 17/09/2026 (ver a
     tabela no comentário de `telefoneValido`). O teste antigo afirmava
     `telefoneValido('(11) 99999-9999')` — e esse é exatamente o número
     que a Asaas RECUSA. O teste travava o bug no lugar de pegá-lo. */
  assert.ok(telefoneValido('(11) 98765-4321'), 'celular realista passa');

  /* --- TELEFONE COM CÓDIGO DO PAÍS (autopreenchimento, 25/09/2026) ---
     O navegador preenche `+55 16 98765-4321`; as quatro formas são o
     MESMO telefone, e o `55` nunca vira DDD. */
  for (const forma of ['16987654321', '(16) 98765-4321', '+55 16 98765-4321', '55 16 98765-4321', '+55 (16) 98765-4321', ' 16 98765 4321 ', '+55-16-98765-4321']) {
    assert.equal(normalizarTelefone(forma), '16987654321', `"${forma}" normaliza para o mesmo telefone`);
    assert.ok(telefoneValido(forma), `"${forma}" é válido`);
  }
  assert.equal(normalizarTelefone('+55 16 3333-4444'), '1633334444', 'fixo com +55: 10 dígitos depois do país');
  assert.equal(normalizarTelefone('5533334444'), '5533334444', 'DDD 55 (RS), fixo nacional com 10 dígitos: o 55 é DDD e FICA');
  assert.equal(normalizarTelefone('55987654321'), '55987654321', 'DDD 55, celular nacional com 11 dígitos: o 55 é DDD e FICA');
  assert.equal(normalizarTelefone('+55 55 98765-4321'), '55987654321', 'país + DDD 55: só o primeiro 55 sai');
  assert.ok(!telefoneValido('+55 16 99999-9999'), 'o exemplo do autopreenchimento com a parte local toda de 9 continua recusado — a Asaas recusa');
  assert.ok(!telefoneValido('+1 415 555 0100'), 'número estrangeiro não vira brasileiro');
  assert.ok(!telefoneValido('+55 16 9876'), 'curto demais com +55 continua inválido');
  assert.ok(!telefoneValido('55 16 98765-43210'), '14 dígitos: não é brasileiro, não é cortado');
  assert.ok(telefoneValido('11988888888'), 'celular com 8 repetidos passa — a Asaas aceita');
  assert.ok(telefoneValido('11911111111'), 'celular com 1 repetidos passa — a Asaas aceita');
  assert.ok(telefoneValido('11999999998'), 'celular quase todo 9 passa');
  assert.ok(telefoneValido('11990000000'), 'celular com zeros passa');
  assert.ok(telefoneValido('1133334444'), 'fixo com pares repetidos passa');
  assert.ok(telefoneValido('1112345678'), 'fixo com prefixo 1 passa — a Asaas aceita, então nós também');
  assert.ok(telefoneValido('1162345678'), 'fixo com prefixo 6 passa — idem');
  assert.ok(telefoneValido('2033334444'), 'DDD 20 passa — não existe no Brasil, mas a Asaas aceita');
  assert.ok(telefoneValido('9933334444'), 'DDD 99 passa');

  assert.ok(!telefoneValido('11999999999'), 'celular todo 9 recusa — a Asaas recusa');
  assert.ok(!telefoneValido('(11) 99999-9999'), 'e recusa também pontuado');
  assert.ok(!telefoneValido('1111111111'), 'fixo todo 1 recusa');
  assert.ok(!telefoneValido('1900000000'), 'fixo com local todo zero recusa');
  assert.ok(!telefoneValido('11099999999'), 'celular que não começa em 9 recusa');
  assert.ok(!telefoneValido('11899999999'), 'celular começando em 8 recusa');
  assert.ok(!telefoneValido('00999999999'), 'DDD 00 recusa');
  assert.ok(!telefoneValido('0199999999'), 'DDD 01 recusa');
  assert.ok(!telefoneValido('1033334444'), 'DDD 10 recusa');
  assert.ok(!telefoneValido('999999999'), '9 dígitos recusa');
  assert.ok(!telefoneValido('119876543210'), '12 dígitos recusa');

  // --- CEP ---
  assert.ok(cepValido('01310-100'), 'CEP pontuado passa');
  assert.ok(!cepValido('0131010'), 'CEP de 7 dígitos recusa');

  /* --- ENDEREÇO ---
     Achado no ciclo de revisão do projeto inteiro em 18/09/2026: até
     aqui só `cep` tinha teto — `endereco`, `bairro`, `cidade` etc.
     eram checados só por presença, e um deles de 100 KB atravessava. */
  assert.ok(
    camposDeEnderecoDentroDoTeto({ endereco: 'Rua Tal', enderecoNumero: '123', bairro: 'Centro', cidade: 'SP', uf: 'SP' }),
    'endereço realista passa'
  );
  assert.ok(
    !camposDeEnderecoDentroDoTeto({ endereco: 'A'.repeat(300) }),
    'endereço acima do teto recusa'
  );
  assert.ok(
    !camposDeEnderecoDentroDoTeto({ bairro: 'A'.repeat(300) }),
    'bairro acima do teto recusa — o teto é POR CAMPO, não só do endereco'
  );
  assert.ok(
    camposDeEnderecoDentroDoTeto({ endereco: 'Rua Tal', complemento: undefined }),
    'campo ausente (ex.: complemento opcional) passa — quem exige presença é o controlador'
  );

  // --- valor ---
  assert.ok(valorValido(0.01), 'centavo passa');
  assert.ok(!valorValido(0), 'zero recusa');
  assert.ok(!valorValido(-1), 'negativo recusa');
  assert.ok(!valorValido(100001), 'acima do teto recusa');
  assert.ok(!valorValido('abc'), 'texto recusa');

  /* --- PISO DA ASAAS ---
     Separado de `valorValido` de propósito: são duas perguntas
     diferentes, e confundi-las é o bug. `valorValido` olha o que veio
     do contratante; `valorCobradoAceitavel` olha o que vai para a
     Asaas. Os dois valores medidos (2,50 recusado, 5,00 aceito) estão
     aqui como fronteira. */
  assert.equal(PISO_ASAAS, 5, 'o piso medido é R$ 5,00');
  assert.ok(valorCobradoAceitavel(5), 'R$ 5,00 exato passa — foi o controle positivo da medição');
  assert.ok(valorCobradoAceitavel(5.01), 'acima do piso passa');
  assert.ok(valorCobradoAceitavel(9.5), 'o valor do ped_completo passa');
  assert.ok(!valorCobradoAceitavel(2.5), 'R$ 2,50 recusa — foi o valor recusado pela Asaas');
  assert.ok(!valorCobradoAceitavel(4.99), 'um centavo abaixo do piso recusa');
  assert.ok(!valorCobradoAceitavel(0), 'zero recusa');
  assert.ok(!valorCobradoAceitavel(null), 'nulo recusa');
  assert.ok(!valorCobradoAceitavel(undefined), 'ausente recusa');
  assert.ok(!valorCobradoAceitavel('abc'), 'texto recusa');
  assert.ok(!valorCobradoAceitavel(NaN), 'NaN recusa');
  // A comparação é em centavos: em reais, 4,995 arredonda para 5,00 na
  // Asaas, e reprovar aqui recusaria algo que ela aceita.
  assert.ok(valorCobradoAceitavel(4.995), 'valor que a Asaas lê como 5,00 passa');
  assert.ok(!valorCobradoAceitavel(4.994), 'valor que a Asaas lê como 4,99 recusa');
  assert.ok(
    MENSAGEM_PISO_ASAAS.includes('R$ 5,00') && !MENSAGEM_PISO_ASAAS.toLowerCase().includes('asaas'),
    'a mensagem cita o valor e não cita o provedor — quem lê é o comprador'
  );

  /* --- O PISO É POR PARCELA ---
     Cada linha é um ponto medido (ver o comentário de
     `maximoDeParcelas`). A regra é "nenhuma parcela abaixo de R$ 5,00",
     e o efeito é ofertar menos parcelas, nunca recusar a venda. */
  assert.equal(maximoDeParcelas(60), 12, 'R$ 60,00 cabem 12x de R$ 5,00 — foi o caso aceito na medição');
  /* ATENÇÃO À UNIDADE: o argumento é o valor COBRADO, não o do pedido.
     R$ 24,00 cobrados cabem 4x. Um PEDIDO de R$ 24,00 é outra conta —
     fecha em R$ 26,15 com taxa e sai em 5x —, e quem a faz é
     `taxaService.taxaComParcelasQueCabem`. Confundir as duas unidades é
     fácil, e é por isso que o rótulo diz qual é. */
  assert.equal(maximoDeParcelas(24), 4, 'R$ 24,00 COBRADOS cabem 4x (12x daria R$ 2,00, e a Asaas recusou isso na medição)');
  assert.equal(maximoDeParcelas(10), 2, 'R$ 10,00 cabem 2x');
  assert.equal(maximoDeParcelas(59.99), 11, 'um centavo abaixo de 60 cai para 11x');
  assert.equal(maximoDeParcelas(5), 1, 'no piso, só à vista');
  assert.equal(maximoDeParcelas(4.99), 1, 'abaixo do piso devolve 1 — quem recusa é `valorCobradoAceitavel`, não esta função');
  assert.equal(maximoDeParcelas(0), 1, 'zero devolve 1, nunca 0 (0 parcela não existe)');
  assert.equal(maximoDeParcelas(null), 1, 'nulo idem');
  assert.equal(maximoDeParcelas('abc'), 1, 'texto idem');
  assert.ok(
    maximoDeParcelas(1e9) > MAXIMO_DE_PARCELAS_DO_CHECKOUT,
    'valor alto não é limitado por esta função — o teto de parcelas é regra nossa, e mora em MAXIMO_DE_PARCELAS_DO_CHECKOUT'
  );

  /* O teto do checkout, e o validador que o usa. Os dois moravam no
     controlador, e o número estava escrito em três lugares. */
  assert.equal(MAXIMO_DE_PARCELAS_DO_CHECKOUT, 12, 'o teto de parcelas do checkout é 12');
  assert.ok(parcelasValidas(1), '1 parcela passa');
  assert.ok(parcelasValidas(MAXIMO_DE_PARCELAS_DO_CHECKOUT), 'o teto passa');
  assert.ok(!parcelasValidas(MAXIMO_DE_PARCELAS_DO_CHECKOUT + 1), 'uma acima do teto recusa');
  assert.ok(!parcelasValidas(0), 'zero recusa');
  assert.ok(!parcelasValidas(-1), 'negativo recusa');
  assert.ok(!parcelasValidas(1.5), 'fracionário recusa');
  assert.ok(!parcelasValidas('abc'), 'texto recusa');
  assert.ok(!parcelasValidas(null), 'nulo recusa');

  /* A fronteira, em centavos: R$ 15,00 dão 3x exatas; R$ 14,99 não. */
  assert.equal(maximoDeParcelas(15), 3, 'R$ 15,00 dão 3x de R$ 5,00 cravados');
  assert.equal(maximoDeParcelas(14.99), 2, 'R$ 14,99 já não dão 3x');

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

  console.log(`validadores: ${checagens} checagens OK`);
}
