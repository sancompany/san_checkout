/**
 * SAN CHECKOUT v2 — src/services/taxaService.js
 * Fórmula completa (VISAO_COMPLETA.md seção 6). Nesta leva só o método
 * 'pix' é usado de verdade — a tabela já inclui os outros métodos
 * (cartão por faixa de parcela, boleto) prontos pra quando a pop-up
 * Asaas Checkout entrar na próxima leva.
 */

const TAXA_PERCENTUAL_PROPRIA = Number(process.env.TAXA_PERCENTUAL ?? 0.9) / 100;
const TAXA_FIXA_PROPRIA = Number(process.env.TAXA_FIXA ?? 0.5);

const TAXA_ASAAS_POR_METODO = {
  pix: { fixa: 1.99, percentual: 0 },
  boleto: { fixa: 1.99, percentual: 0 },
  cartao_debito: { fixa: 0.35, percentual: 0.0189 },
  cartao_credito_avista: { fixa: 0.49, percentual: 0.0299 },
  cartao_credito_2_6: { fixa: 0.49, percentual: 0.0349 },
  cartao_credito_7_12: { fixa: 0.49, percentual: 0.0399 }
};

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
