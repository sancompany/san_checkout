/**
 * SAN CHECKOUT v2 — src/services/taxaService.js
 * Fórmula completa (API.md §8). Nesta leva só o método
 * 'pix' é usado de verdade — a tabela já inclui os outros métodos
 * (cartão por faixa de parcela, boleto) prontos pra quando a pop-up
 * Asaas Checkout entrar na próxima leva.
 */

import { maximoDeParcelas } from '../utils/validadores.js';

const TAXA_PERCENTUAL_PROPRIA = Number(process.env.TAXA_PERCENTUAL ?? 0.9) / 100;
const TAXA_FIXA_PROPRIA = Number(process.env.TAXA_FIXA ?? 0.5);

/**
 * Tabela de PARTIDA — taxa pública da Asaas. Deixou de ser a fonte da
 * verdade e virou rede de segurança: `sincronizarTaxasAsaas()` abaixo
 * substitui esses números pelos da conta de verdade
 * (`GET /v3/myAccount/fees/`). Se a Asaas reajustar, ou se você
 * negociar taxa melhor por volume, o valor certo passa a valer sozinho
 * — antes, o checkout continuaria cobrando o número velho do comprador
 * sem erro nenhum.
 */
const TAXA_ASAAS_PADRAO = {
  pix: { fixa: 1.99, percentual: 0 },
  boleto: { fixa: 1.99, percentual: 0 },
  cartao_debito: { fixa: 0.35, percentual: 0.0189 },
  cartao_credito_avista: { fixa: 0.49, percentual: 0.0299 },
  cartao_credito_2_6: { fixa: 0.49, percentual: 0.0349 },
  cartao_credito_7_12: { fixa: 0.49, percentual: 0.0399 }
};

let TAXA_ASAAS_POR_METODO = { ...TAXA_ASAAS_PADRAO };

/* ------------------------------------------------------------------
   Sincronização com as taxas reais da conta
------------------------------------------------------------------ */

/** A Asaas manda percentual como 2.99 (por cento); aqui dentro tudo é
 *  fração (0.0299). O guard existe porque errar essa conversão numa
 *  rota de dinheiro cobra 100x a mais ou a menos — se um dia a Asaas
 *  mudar a convenção, o valor continua sendo interpretado certo. */
function comoFracao(percentual) {
  const n = Number(percentual);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const fracao = n > 1 ? n / 100 : n;
  // 2.99/100 vira 0.029900000000000003 em ponto flutuante. Some no
  // arredondamento final do valor cobrado, mas sujaria a tabela nos
  // logs; 6 casas é folga sobre as 4 que a Asaas usa em percentual.
  return Math.round(fracao * 1e6) / 1e6;
}

/** Promoção só vale enquanto não expirou. Sem data, trata como vigente
 *  (a Asaas só manda o campo quando existe promoção). */
function promocaoVigente(dataExpiracao) {
  if (!dataExpiracao) return true;
  return new Date(dataExpiracao) > new Date();
}

function valorComPromocao(padrao, promocional, expiracao) {
  const temPromo = promocional !== undefined && promocional !== null && promocaoVigente(expiracao);
  return Number(temPromo ? promocional : padrao);
}

/**
 * Converte a resposta da Asaas (schema `MyAccountGetAccountFeesPaymentDTO`)
 * pro formato interno `{ fixa, percentual }`.
 *
 * Nota sobre o Pix: a Asaas também informa `monthlyCreditsWithoutFee`
 * (transações grátis no mês). NÃO modelamos isso de propósito — a taxa
 * exibida ao comprador mudaria no meio do mês, quando a cota acabasse,
 * e dois compradores pagariam valores diferentes pelo mesmo produto.
 * A cota vira margem, não desconto no checkout.
 */
function converterTaxasDaAsaas(pagamento) {
  const convertida = {};

  if (pagamento?.pix) {
    const pix = pagamento.pix;
    const fixa = valorComPromocao(pix.fixedFeeValue, pix.fixedFeeValueWithDiscount, pix.discountExpiration);
    convertida.pix = { fixa: Number(fixa) || 0, percentual: comoFracao(pix.percentageFee) };
  }

  if (pagamento?.bankSlip) {
    const boleto = pagamento.bankSlip;
    const fixa = valorComPromocao(boleto.defaultValue, boleto.discountValue, boleto.expirationDate);
    convertida.boleto = { fixa: Number(fixa) || 0, percentual: 0 };
  }

  if (pagamento?.debitCard) {
    convertida.cartao_debito = {
      fixa: Number(pagamento.debitCard.operationValue) || 0,
      percentual: comoFracao(pagamento.debitCard.defaultPercentage)
    };
  }

  if (pagamento?.creditCard) {
    const cartao = pagamento.creditCard;
    const fixa = Number(cartao.operationValue) || 0;
    const faixa = (padrao, promo) => ({
      fixa,
      percentual: comoFracao(valorComPromocao(padrao, promo, cartao.discountExpiration))
    });

    convertida.cartao_credito_avista = faixa(cartao.oneInstallmentPercentage, cartao.discountOneInstallmentPercentage);
    convertida.cartao_credito_2_6 = faixa(cartao.upToSixInstallmentsPercentage, cartao.discountUpToSixInstallmentsPercentage);
    convertida.cartao_credito_7_12 = faixa(cartao.upToTwelveInstallmentsPercentage, cartao.discountUpToTwelveInstallmentsPercentage);
  }

  return convertida;
}

/**
 * Busca as taxas da conta e passa a usá-las. Chamada no boot e a cada
 * 24h (server.js). Falhou? Mantém o que já estava valendo — a tabela
 * padrão nunca deixa o checkout sem número.
 *
 * Import dinâmico do asaasService pra evitar ciclo: asaasService não
 * importa daqui, mas isto mantém o módulo carregável isolado (o
 * autoteste no fim do arquivo depende disso).
 */
export async function sincronizarTaxasAsaas() {
  try {
    const { buscarTaxasDaConta } = await import('./asaasService.js');
    const pagamento = await buscarTaxasDaConta();
    const convertida = converterTaxasDaAsaas(pagamento);

    if (Object.keys(convertida).length === 0) {
      console.error('[taxaService] Asaas respondeu sem taxas reconhecíveis — mantendo a tabela padrão.');
      return false;
    }

    TAXA_ASAAS_POR_METODO = { ...TAXA_ASAAS_PADRAO, ...convertida };
    console.log('[taxaService] taxas sincronizadas com a conta Asaas:', JSON.stringify(TAXA_ASAAS_POR_METODO));
    return true;
  } catch (erro) {
    console.error('[taxaService] falha ao sincronizar taxas, seguindo com a tabela padrão:', erro.message);
    return false;
  }
}

/** Exportado só pro autoteste — não use no fluxo normal. */
export const _internos = { converterTaxasDaAsaas, comoFracao };

/** Faixa de % própria por parcela — 1x-3x fixo, escalando ×1,5 depois. */
function percentualPropriaPorParcela(parcelas) {
  if (parcelas <= 3) return TAXA_PERCENTUAL_PROPRIA;
  if (parcelas <= 6) return TAXA_PERCENTUAL_PROPRIA * 1.5;
  if (parcelas <= 9) return TAXA_PERCENTUAL_PROPRIA * 1.5 * 1.5;
  return TAXA_PERCENTUAL_PROPRIA * 1.5 * 1.5 * 1.5; // 10x-12x
}

/**
 * Mapeia o número de parcelas pra tabela de taxaAsaas por FAIXA —
 * atenção: essa faixa NÃO é a mesma da taxaPropria acima (Asaas usa
 * avista/2-6/7-12; nossa taxa própria escala em 1-3/4-6/7-9/10-12).
 * São duas tabelas independentes, de propósito.
 */
export function metodoCartaoPorParcelas(parcelas) {
  if (parcelas <= 1) return 'cartao_credito_avista';
  if (parcelas <= 6) return 'cartao_credito_2_6';
  return 'cartao_credito_7_12';
}

/**
 * A TAXA E O NÚMERO DE PARCELAS SE DETERMINAM UM AO OUTRO — e é por isso
 * que isto é um ponto fixo e não uma conta.
 *
 * A Asaas recusa PARCELA abaixo de R$ 5,00, não só total (medido em
 * 17/09/2026 — ver `maximoDeParcelas` em `utils/validadores.js`). Então
 * um pedido de R$ 24,00 pedido em 12x precisa ser ofertado em 4x.
 *
 * Mas a taxa depende da FAIXA de parcelas (à vista 2,99%, 2-6x 3,49%,
 * 7-12x 3,99%), e o valor cobrado depende da taxa. Baixar as parcelas
 * baixa a faixa, que baixa o valor cobrado, que pode baixar de novo o
 * quanto cabe. Capar DEPOIS de calcular a taxa seria pior que não capar:
 * o comprador pagaria a taxa da faixa de 12x e só poderia usar 4x.
 *
 * O ponto fixo é decrescente (menos parcelas → faixa menor ou igual) e
 * o piso de uma parcela o encerra. Três voltas são folga sobre as três
 * faixas que existem.
 *
 * @returns {{ parcelas: number, taxa: object, capado: boolean }}
 *          `parcelas` é quantas OFERTAR (≤ as pedidas), `taxa` é a da
 *          faixa dessas parcelas, e `capado` diz se houve corte — quem
 *          chama pode querer contar isso.
 */
export function taxaComParcelasQueCabem(valorBase, parcelasPedidas, isentarTaxa = false) {
  let parcelas = Math.max(1, Number(parcelasPedidas) || 1);
  let taxa;

  for (let volta = 0; volta < 3; volta += 1) {
    taxa = calcularTaxa(valorBase, metodoCartaoPorParcelas(parcelas), parcelas, isentarTaxa);
    const cabem = maximoDeParcelas(taxa.valorCobrado);
    if (cabem >= parcelas) break;
    parcelas = cabem;
  }

  return { parcelas, taxa, capado: parcelas < Math.max(1, Number(parcelasPedidas) || 1) };
}

function arredondar(valor) {
  return Math.round(valor * 100) / 100;
}

/**
 * @param {number} valorBase — valorComDesconto + frete do pedido
 * @param {string} metodo — 'pix' | 'boleto' | 'cartao_debito' | 'cartao_credito_avista' | 'cartao_credito_2_6' | 'cartao_credito_7_12'
 * @param {number} parcelas — só relevante pra cartão de crédito
 * @param {boolean} isentarTaxa — vem do pedido; zera as duas taxas se true
 */
export function calcularTaxa(valorBase, metodo, parcelas = 1, isentarTaxa = false) {
  if (isentarTaxa) {
    return { taxaAsaas: 0, taxaPropria: 0, taxasTotais: 0, valorCobrado: arredondar(valorBase) };
  }

  const tabela = TAXA_ASAAS_POR_METODO[metodo];
  if (!tabela) throw new Error(`Método de pagamento desconhecido: ${metodo}`);

  const taxaAsaas = arredondar(valorBase * tabela.percentual + tabela.fixa);

  const percentualPropria = metodo.startsWith('cartao_credito')
    ? percentualPropriaPorParcela(parcelas)
    : TAXA_PERCENTUAL_PROPRIA;
  const taxaPropria = arredondar(valorBase * percentualPropria + TAXA_FIXA_PROPRIA);

  const taxasTotais = arredondar(taxaAsaas + taxaPropria);
  const valorCobrado = arredondar(valorBase + taxasTotais);

  return { taxaAsaas, taxaPropria, taxasTotais, valorCobrado };
}

/* ------------------------------------------------------------------
   Autoteste — `node src/services/taxaService.js`
   Cobre a conversão das taxas da Asaas, que é rota de dinheiro: errar
   a escala do percentual cobra 100x a mais ou a menos.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('taxaService.js')) {
  const { strict: assertReal } = await import('node:assert');
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

  const { converterTaxasDaAsaas, comoFracao } = _internos;

  // escala: 2.99 é "por cento", 0.0299 já é fração
  assert.equal(comoFracao(2.99), 0.0299);
  assert.equal(comoFracao(0.0299), 0.0299);
  assert.equal(comoFracao(null), 0);

  // resposta no formato real da Asaas (schema MyAccountGetAccountFees*)
  const daAsaas = converterTaxasDaAsaas({
    pix: { fixedFeeValue: 1.49, percentageFee: 0 },
    bankSlip: { defaultValue: 2.49 },
    creditCard: {
      operationValue: 0.49,
      oneInstallmentPercentage: 2.5,
      upToSixInstallmentsPercentage: 3.1,
      upToTwelveInstallmentsPercentage: 3.7
    }
  });
  assert.deepEqual(daAsaas.pix, { fixa: 1.49, percentual: 0 });
  assert.deepEqual(daAsaas.boleto, { fixa: 2.49, percentual: 0 });
  assert.deepEqual(daAsaas.cartao_credito_avista, { fixa: 0.49, percentual: 0.025 });
  assert.deepEqual(daAsaas.cartao_credito_7_12, { fixa: 0.49, percentual: 0.037 });

  // promoção vigente vence a taxa cheia; promoção expirada é ignorada
  const futuro = new Date(Date.now() + 86400000).toISOString();
  const passado = new Date(Date.now() - 86400000).toISOString();
  assert.equal(converterTaxasDaAsaas({ bankSlip: { defaultValue: 2.49, discountValue: 1.99, expirationDate: futuro } }).boleto.fixa, 1.99);
  assert.equal(converterTaxasDaAsaas({ bankSlip: { defaultValue: 2.49, discountValue: 1.99, expirationDate: passado } }).boleto.fixa, 2.49);

  // resposta vazia/estranha não derruba nada — vira {} e o chamador
  // mantém a tabela padrão
  assert.deepEqual(converterTaxasDaAsaas(null), {});
  assert.deepEqual(converterTaxasDaAsaas({}), {});

  // a conta em si continua batendo com a tabela padrão
  const t = calcularTaxa(100, 'pix', 1, false);
  assert.equal(t.taxaAsaas, 1.99);
  assert.equal(t.valorCobrado, 100 + t.taxasTotais);
  assert.deepEqual(calcularTaxa(100, 'pix', 1, true), { taxaAsaas: 0, taxaPropria: 0, taxasTotais: 0, valorCobrado: 100 });


  /* ---- O PISO POR PARCELA ----
     A Asaas recusa PARCELA abaixo de R$ 5,00, não só total (medido em
     17/09/2026 — `POST /v3/payments` totalValue 24,00 em 12x, parcela de
     R$ 2,00, deu 400; em 60,00, parcela de R$ 5,00, deu 200). E a
     `POST /v3/checkouts` ACEITA a sessão assim, então a recusa só
     apareceria dentro da pop-up, com o cartão já digitado.

     O que se testa aqui é o PONTO FIXO: a taxa depende da faixa de
     parcelas e as parcelas dependem do valor com taxa. */
  {
    const caro = taxaComParcelasQueCabem(1000, 12);
    assert.equal(caro.parcelas, 12, 'pedido caro mantém as 12 parcelas pedidas');
    assert.equal(caro.capado, false, 'e não é marcado como capado');
    assert.ok(caro.taxa.valorCobrado / 12 >= 5, 'cada parcela fica acima do piso');

    const barato = taxaComParcelasQueCabem(24, 12);
    assert.ok(barato.parcelas < 12, `pedido de R$ 24,00 em 12x é capado (ficou em ${barato.parcelas}x)`);
    assert.equal(barato.capado, true, 'e é marcado como capado');
    assert.ok(
      barato.taxa.valorCobrado / barato.parcelas >= 5,
      `nenhuma parcela ofertada fica abaixo do piso (ficou R$ ${(barato.taxa.valorCobrado / barato.parcelas).toFixed(2)})`
    );

    /* A TAXA ACOMPANHA O CORTE. É o ponto inteiro de capar antes: se a
       taxa continuasse sendo a da faixa de 12x, o comprador pagaria por
       um parcelamento que não pode usar. */
    const taxaDe12x = calcularTaxa(24, metodoCartaoPorParcelas(12), 12, false);
    assert.ok(
      barato.taxa.valorCobrado < taxaDe12x.valorCobrado,
      'a taxa cobrada é a da faixa das parcelas OFERTADAS, não a da faixa pedida'
    );
    assert.equal(
      barato.taxa.valorCobrado,
      calcularTaxa(24, metodoCartaoPorParcelas(barato.parcelas), barato.parcelas, false).valorCobrado,
      'e bate exatamente com a faixa das parcelas ofertadas'
    );

    /* Nunca zero, nunca negativo: 0 parcela não existe, e quem recusa
       valor abaixo do piso é o guarda do total, não esta função. */
    assert.equal(taxaComParcelasQueCabem(1, 12).parcelas, 1, 'valor mínimo cai para 1 parcela, não para 0');
    assert.equal(taxaComParcelasQueCabem(100, 1).parcelas, 1, 'quem pede 1 parcela recebe 1');
    assert.equal(taxaComParcelasQueCabem(100, 0).parcelas, 1, 'pedido de 0 parcelas vira 1');

    /* Isenção de taxa muda o valor cobrado, então muda o quanto cabe —
       e o ponto fixo tem de ver isso. */
    const isento = taxaComParcelasQueCabem(60, 12, true);
    assert.equal(isento.taxa.valorCobrado, 60, 'com isenção, o valor cobrado é o base');
    assert.equal(isento.parcelas, 12, 'e R$ 60,00 isentos dão 12x de R$ 5,00 cravados');
    const isentoQuase = taxaComParcelasQueCabem(59.99, 12, true);
    assert.equal(isentoQuase.parcelas, 11, 'um centavo abaixo, 11x');
  }

  console.log(`taxaService: ${checagens} checagens OK`);
}
