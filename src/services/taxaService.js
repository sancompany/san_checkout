/**
 * SAN CHECKOUT v2 — src/services/taxaService.js
 * Fórmula completa (API.md §8). Nesta leva só o método
 * 'pix' é usado de verdade — a tabela já inclui os outros métodos
 * (cartão por faixa de parcela, boleto) prontos pra quando a pop-up
 * Asaas Checkout entrar na próxima leva.
 */

import { maximoDeParcelas, PISO_ASAAS } from '../utils/validadores.js';

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
 * um pedido de R$ 24,00 pedido em 12x fecha em R$ 26,15 com taxa e
 * precisa ser ofertado em 5x (parcela de R$ 5,23).
 *
 * Mas a taxa depende da FAIXA de parcelas (à vista 2,99%, 2-6x 3,49%,
 * 7-12x 3,99%), e o valor cobrado depende da taxa. Baixar as parcelas
 * baixa a faixa, que baixa o valor cobrado, que pode baixar de novo o
 * quanto cabe. Capar DEPOIS de calcular a taxa seria pior que não capar:
 * o comprador pagaria a taxa da faixa de 12x e só poderia usar 4x.
 *
 * O ponto fixo é decrescente (menos parcelas → faixa menor ou igual) e
 * o piso de uma parcela o encerra.
 *
 * O TETO DE TRÊS VOLTAS É MEDIDO, e aqui já esteve escrito "folga" e
 * depois "o exato necessário" — os dois chutes meus, os dois errados.
 * Varrendo cada centavo de R$ 0,01 a R$ 2.000,00 × 12 parcelas × isento
 * e não isento (4,8 milhões de casos por teto, em 17/09/2026):
 *
 *   | teto | viola o piso | sai pela contagem |
 *   |------|--------------|-------------------|
 *   |   1  |  1.260 casos |      73.733       |
 *   |   2  |       0      |       1.260       |
 *   |   3  |       0      |         0         |
 *   |   4  |       0      |         0         |
 *
 * Lidas juntas, as linhas dizem três coisas. **Uma volta erra**: base
 * R$ 8,41 pedida em 10x ofertaria 2x de R$ 4,885, abaixo do piso. **Duas
 * voltas acertam, mas só por causa do recálculo final** — 1.260 casos
 * terminam batendo no teto em vez de convergir. **Três é onde o laço
 * converge sozinho**, e quatro não muda nada: é o ponto fixo do próprio
 * teto.
 *
 * Por isso o número é 3 e não 2: depender da rede de segurança para
 * estar correto é diferente de tê-la para o caso de o desenho mudar. O
 * autoteste exige CONVERGÊNCIA, não só resultado certo — baixar este
 * número deixa a suíte vermelha mesmo sem produzir valor errado.
 *
 * O `voltasMaximas` existe SÓ PARA O AUTOTESTE, e por um motivo que a
 * sabotagem provou: com o teto real de 3, nenhuma entrada sai pela
 * contagem — então `convergiu` nunca é `false` e a rede de segurança
 * nunca é exercitada. Uma bandeira que é sempre `true` não verifica
 * nada, e uma guarda que nada alcança não tem prova. Baixando o teto, o
 * teste alcança os dois. Nenhum chamador de produção passa este
 * parâmetro, e a suíte varre o `src/` para garantir.
 *
 * @returns {{ parcelas: number, taxa: object, capado: boolean, convergiu: boolean }}
 *          `parcelas` é quantas OFERTAR (≤ as pedidas), `taxa` é a da
 *          faixa dessas parcelas, e `capado` diz se houve corte — quem
 *          chama pode querer contar isso.
 */
export const VOLTAS_DO_PONTO_FIXO = 3;

export function taxaComParcelasQueCabem(valorBase, parcelasPedidas, isentarTaxa = false, voltasMaximas = VOLTAS_DO_PONTO_FIXO) {
  // Uma vez, não duas: `capado` comparava contra a mesma expressão
  // recalculada, e duas cópias de uma conta é uma que um dia divergirá.
  const pedidas = Math.max(1, Number(parcelasPedidas) || 1);
  let parcelas = pedidas;
  let taxa;
  /* `false` significa que o laço acabou pelo teto de voltas em vez de
     convergir. Sai no retorno porque é o que o autoteste exige que
     NUNCA aconteça — sem expor isto, baixar o teto de voltas continuaria
     produzindo resultado certo (pela rede de segurança abaixo) e
     passaria por prova. */
  let convergiu = false;

  for (let volta = 0; volta < voltasMaximas; volta += 1) {
    taxa = calcularTaxa(valorBase, metodoCartaoPorParcelas(parcelas), parcelas, isentarTaxa);
    const cabem = maximoDeParcelas(taxa.valorCobrado);
    if (cabem >= parcelas) { convergiu = true; break; }
    parcelas = cabem;
  }

  /* A INVARIANTE, garantida por construção e não por raciocínio.

     O laço tem duas saídas: convergência (`break`) e contagem. Saindo
     pela contagem, `parcelas` já foi baixado mas `taxa` continua sendo a
     da volta anterior — e devolver as duas coisas juntas significa
     cobrar a taxa de uma faixa acima da que o comprador pode usar, que é
     exatamente o erro que capar antes da taxa existe para evitar.

     COM O TETO DE 3, NENHUMA ENTRADA DE HOJE CHEGA AQUI — medido: zero
     saídas pela contagem em 4,8 milhões de casos. Então remover este
     recálculo não deixa nenhum teste vermelho hoje, e ele fica mesmo
     assim, por uma razão concreta e não por precaução vaga: é ele que
     torna o teto de 2 CORRETO (a linha do meio da tabela acima). Ou
     seja, ele é o que faz a escolha do teto deixar de ser crítica.

     O par trabalha junto: se um dia entrar uma quarta faixa na tabela de
     taxa, o laço pode parar de convergir em três voltas — o autoteste
     fica vermelho avisando para subir o teto, e ENQUANTO ISSO o
     resultado continua certo por causa desta linha. Vermelho e correto
     ao mesmo tempo é melhor que vermelho e errado.

     Guarda não exercitada e declarada é dívida honesta; não declarada é
     a que alguém apaga achando que é código morto. */
  const taxaDaFaixaFinal = calcularTaxa(
    valorBase, metodoCartaoPorParcelas(parcelas), parcelas, isentarTaxa
  );

  return { parcelas, taxa: taxaDaFaixaFinal, capado: parcelas < pedidas, convergiu };
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
  // Contador de verdade, não chumbado — ver a nota em
  // `utils/validadores.js`. Oito autotestes daqui tinham o número
  // escrito à mão, e três deles estavam errados.
  //
  // Envolve o `assert` num proxy para contar sem reescrever as chamadas.
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

    /* A INVARIANTE, varrida em vez de argumentada: para TODA combinação
       de base e parcelas pedidas, a taxa devolvida tem de ser a da faixa
       das parcelas DEVOLVIDAS. Se o laço sair pela contagem em vez da
       convergência, isto pega — e pegaria também alguém acrescentando
       uma faixa na tabela, que é o caso em que o meu argumento sobre
       "três voltas bastam" deixaria de valer sem quebrar nada visível. */
    /* VARREDURA DENSA, e não uma lista de bases escrita à mão.

       A primeira versão desta varredura usava catorze bases escolhidas
       por mim, e ela aprovou uma sabotagem que reduzia o laço a UMA
       volta — porque nenhuma das catorze exercitava o caminho de mais de
       uma volta. Varrendo de centavo em centavo, 1.260 casos violam o
       piso nessa sabotagem; a minha lista não continha nenhum deles.
       Escolher casos à mão é escolher também o que não se testa.

       O passo de 7 centavos é primo em relação às faixas da taxa, então
       não sincroniza com nenhuma fronteira e cobre os três caminhos de
       volta — conferido pelos contadores no fim. */
    const violacoes = [];
    let combinacoes = 0;
    const voltasVistas = new Set();

    for (let centavos = 1; centavos <= 30000; centavos += 7) {
      const base = centavos / 100;
      for (const pedidas of [1, 2, 5, 6, 7, 11, 12]) {
        for (const isenta of [false, true]) {
          const r = taxaComParcelasQueCabem(base, pedidas, isenta);
          combinacoes += 1;

          const daFaixa = calcularTaxa(
            base, metodoCartaoPorParcelas(r.parcelas), r.parcelas, isenta
          ).valorCobrado;

          if (r.taxa.valorCobrado !== daFaixa) {
            violacoes.push(`base ${base}, pedidas ${pedidas}: taxa não é a da faixa de ${r.parcelas}x`);
          } else if (r.parcelas < 1 || r.parcelas > Math.max(1, pedidas)) {
            violacoes.push(`base ${base}, pedidas ${pedidas}: ofertou ${r.parcelas}x`);
          } else if (r.parcelas > 1 && r.taxa.valorCobrado / r.parcelas < PISO_ASAAS) {
            violacoes.push(
              `base ${base}, pedidas ${pedidas}: ${r.parcelas}x de ` +
              `R$ ${(r.taxa.valorCobrado / r.parcelas).toFixed(2)}, abaixo do piso`
            );
          }

          /* A INVARIANTE MAIS FORTE: convergir, não sobreviver. Com o
             teto em 2 o resultado continua certo (a rede de segurança
             cobre), então sem esta checagem baixar o teto passaria por
             prova — e passaria escondendo que o laço deixou de fechar
             sozinho. Medido: 1.260 casos saem pela contagem com teto 2. */
          if (!r.convergiu) {
            violacoes.push(`base ${base}, pedidas ${pedidas}: o laço acabou pelo teto de voltas, sem convergir`);
          }

          // Quantos desfechos diferentes a varredura tocou.
          if (r.capado) voltasVistas.add(r.parcelas === 1 ? 'ate-1' : 'intermediaria');
          else voltasVistas.add('convergiu-direto');
        }
      }
    }

    assert.deepEqual(violacoes.slice(0, 5), [], `${violacoes.length} violação(ões); as 5 primeiras acima`);

    /* CONTROLE POSITIVO DA BANDEIRA `convergiu`.

       Sem isto, trocar `let convergiu = false` por `= true` passava por
       prova — pego por sabotagem. A bandeira só significa algo se
       existir um caso em que ela é `false`, e com o teto real de 3
       nenhum caso é. Baixando o teto para 1, 1.260 casos param de
       convergir (medido), e a base R$ 8,41 é um deles. */
    const comTetoDeUmaVolta = taxaComParcelasQueCabem(8.41, 10, false, 1);
    assert.equal(comTetoDeUmaVolta.convergiu, false, 'com uma volta só, a base R$ 8,41 NÃO converge');
    assert.equal(
      taxaComParcelasQueCabem(8.41, 10, false).convergiu, true,
      'controle negativo: com o teto real de 3, a mesma base converge'
    );
    assert.equal(VOLTAS_DO_PONTO_FIXO, 3, 'o teto medido é 3 — ver a tabela no comentário da função');

    /* CONTROLE POSITIVO DA REDE DE SEGURANÇA (o recálculo final).

       Ela é inalcançável com o teto de 3, então removê-la também passava
       por prova. Com o teto baixado, o laço sai pela contagem — e é aí
       que se vê se a taxa devolvida é a da faixa das parcelas
       devolvidas, ou a da volta anterior. */
    for (const teto of [1, 2]) {
      const r = taxaComParcelasQueCabem(8.41, 10, false, teto);
      assert.equal(
        r.taxa.valorCobrado,
        calcularTaxa(8.41, metodoCartaoPorParcelas(r.parcelas), r.parcelas, false).valorCobrado,
        `saindo pela contagem (teto ${teto}), a taxa devolvida tem de ser a da faixa de ${r.parcelas}x`
      );
    }
    assert.ok(combinacoes >= 50000, `controle positivo: a varredura cobriu ${combinacoes} combinações`);
    assert.equal(
      voltasVistas.size, 3,
      `controle positivo: a varredura exercitou os três desfechos do ponto fixo (viu ${[...voltasVistas].join(', ')})`
    );

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
