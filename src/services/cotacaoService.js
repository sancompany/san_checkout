/**
 * SAN CHECKOUT v2 — src/services/cotacaoService.js
 *
 * A COTAÇÃO — o retrato imutável do preço que a tela mostrou (C-02 da
 * auditoria de 24/09/2026; tabela `cotacoes`, migration 0015).
 *
 * O problema que fecha: `GET /pedido` fazia um pull e mostrava X; o
 * `POST /pix` fazia OUTRO pull e cobrava o que viesse — se o contratante
 * mudou o preço, a promoção venceu ou o frete foi recalculado entre os
 * dois, o pagador via X e pagava Y, sem ninguém perguntar. A troca de
 * plano já resolvia isso com um retrato congelado (`intencoes_troca_
 * plano`); compra e assinatura não.
 *
 * Como fica:
 *  1. o `GET` grava aqui o RETRATO (os campos financeiros que o
 *     contratante respondeu) e os TOTAIS que a tela vai exibir, por
 *     método e por número de parcelas, e devolve `cotacao.id`;
 *  2. o `POST` que cobra EXIGE o id, relê a cotação, refaz o pull (para
 *     continuar recusando pedido pago/cancelado/expirado) e COMPARA o
 *     pull novo com o retrato, em centavos;
 *  3. igual → cobra o que está NO RETRATO (`totais`), não o que veio
 *     agora; diferente → 409 `cotacao_alterada` com a cotação nova, e a
 *     tela mostra o valor novo e pede para confirmar de novo.
 *
 * O navegador continua sem decidir preço: ele só carrega um id opaco.
 * Cotação expira em 30 min — depois disso o `POST` também responde 409,
 * com cotação nova, pelo mesmo caminho.
 */

import { createHash } from 'node:crypto';
import { supabase } from '../config/supabase.js';
import { emCentavos, emReais, mesmoDinheiro } from '../utils/dinheiro.js';
import { calcularTaxa, taxaComParcelasQueCabem } from './taxaService.js';
import { valorValido, valorCobradoAceitavel, MAXIMO_DE_PARCELAS_DO_CHECKOUT } from '../utils/validadores.js';

export const VALIDADE_COTACAO_MIN = 30;

/**
 * OS TOTAIS QUE A TELA MOSTRA, por método e por número de parcelas —
 * calculados UMA vez, aqui, e cobrados exatamente assim depois.
 *
 * Achado da consolidação (24/09/2026): a tela mostrava o total do PIX
 * para qualquer método, e o cartão em 12x era cobrado com a taxa da
 * faixa 7–12 — o pagador via um número e a pop-up cobrava outro. O
 * retrato do preço precisa ter TODOS os totais que a tela pode exibir.
 *
 * `null` em `cartao` quando o valor não cabe em parcela nenhuma.
 */
export function montarTotaisPedido(pedido) {
  const valorBase = Number(pedido?.valorComDesconto ?? 0) + Number(pedido?.frete ?? 0);
  if (!valorValido(valorBase)) return null;
  const isentar = Boolean(pedido?.isentarTaxa);
  const pix = calcularTaxa(valorBase, 'pix', 1, isentar);
  const boleto = calcularTaxa(valorBase, 'boleto', 1, isentar);
  const { parcelas: maxParcelas } = taxaComParcelasQueCabem(valorBase, MAXIMO_DE_PARCELAS_DO_CHECKOUT, isentar);
  const cartao = {};
  for (let n = 1; n <= maxParcelas; n += 1) {
    const { taxa } = taxaComParcelasQueCabem(valorBase, n, isentar);
    // O valor da parcela é decidido AQUI, em centavos — a tela só exibe
    // (`index.html`, linha "Nx de R$ …"); nunca divide por conta própria.
    const centavos = emCentavos(taxa?.valorCobrado);
    cartao[n] = { ...taxa, valorParcela: centavos == null ? null : emReais(Math.round(centavos / n)) };
  }
  return {
    valorBase,
    pix,
    boleto,
    cartao,
    maxParcelas,
    abaixoDoPiso: !valorCobradoAceitavel(pix.valorCobrado)
  };
}

/** Assinatura não leva taxa: o total é o valor do plano, por ciclo. */
export function montarTotaisPlano(plano) {
  const valor = Number(plano?.valor);
  if (!valorValido(valor)) return null;
  return { valorBase: valor, assinatura: { taxaAsaas: 0, taxaPropria: 0, taxasTotais: 0, valorCobrado: valor }, abaixoDoPiso: !valorCobradoAceitavel(valor) };
}

/**
 * O portão do POST que cobra (C-02). Recebe o id que a tela mandou, o
 * pull NOVO e a função que cria uma cotação nova; devolve a cotação
 * válida quando tudo bate, e LANÇA um erro 409 (com a cotação nova no
 * corpo) quando não existe, expirou ou divergiu — a tela mostra o valor
 * novo e pede para confirmar de novo. Nunca cobra sem cotação.
 */
export async function exigirCotacaoParaCobrar({ cotacaoId, contratanteId, tipo, referenciaId, origemNova, totaisNovos, agora = new Date() }) {
  const cotacao = await buscarCotacaoValida({ id: cotacaoId, contratanteId, tipo, referenciaId, agora });
  const diff = cotacao ? divergencias(tipo, cotacao.retrato, origemNova) : null;

  if (cotacao && diff.length === 0) return cotacao;

  const nova = await criarCotacao({ contratanteId, tipo, referenciaId, origem: origemNova, totais: totaisNovos, agora });
  const erro = new Error(
    cotacao
      ? 'O valor desta cobrança mudou desde que a tela foi carregada. Confira o novo valor e confirme de novo.'
      : 'A cotação desta cobrança expirou ou não foi encontrada. Confira o valor e confirme de novo.'
  );
  erro.status = 409;
  erro.codigo = cotacao ? 'cotacao_alterada' : 'cotacao_ausente';
  erro.cotacao = { id: nova.id, expiraEm: nova.expiraEm, totais: totaisNovos, retrato: nova.retrato, camposAlterados: diff ?? [] };
  throw erro;
}

/** Os campos do pedido que definem o preço. Tudo que não está aqui pode
 *  mudar sem invalidar a cotação (o `pagador`, um `bannerUrl`). */
export const CAMPOS_FINANCEIROS_PEDIDO = ['valorCheio', 'desconto', 'cupom', 'valorComDesconto', 'frete', 'taxaDoProjeto', 'isentarTaxa'];
export const CAMPOS_FINANCEIROS_PLANO = ['nome', 'valor', 'ciclo'];

function normalizarCampo(nome, valor) {
  if (['cupom', 'nome', 'ciclo'].includes(nome)) return valor === undefined || valor === null || valor === '' ? null : String(valor);
  if (nome === 'isentarTaxa') return Boolean(valor);
  // dinheiro em centavos, para o retrato ser comparável sem ponto flutuante
  return emCentavos(valor);
}

/** O retrato financeiro de um pedido ou plano, normalizado. */
export function retratoFinanceiro(tipo, origem) {
  const campos = tipo === 'plano' ? CAMPOS_FINANCEIROS_PLANO : CAMPOS_FINANCEIROS_PEDIDO;
  const retrato = {};
  for (const campo of campos) retrato[campo] = normalizarCampo(campo, origem?.[campo]);
  if (tipo === 'pedido') {
    retrato.descricao = typeof origem?.descricao === 'string' ? origem.descricao.slice(0, 200) : null;
    retrato.itens = Array.isArray(origem?.itens)
      ? origem.itens.slice(0, 100).map((i) => ({
        nome: typeof i?.nome === 'string' ? i.nome.slice(0, 120) : null,
        quantidade: Number.isFinite(Number(i?.quantidade)) ? Number(i.quantidade) : null,
        valorUnitario: emCentavos(i?.valorUnitario)
      }))
      : null;
  }
  return retrato;
}

export function hashDoRetrato(retrato) {
  return createHash('sha256').update(JSON.stringify(retrato)).digest('hex');
}

/**
 * Compara o pull novo com o retrato gravado. Devolve a lista de campos
 * que divergem (vazia = igual). Itens e descrição NÃO entram na
 * comparação: mudar o nome de um item não muda o que se cobra — o que
 * o pagador confirma é o total.
 */
export function divergencias(tipo, retratoGravado, origemNova) {
  const novo = retratoFinanceiro(tipo, origemNova);
  const campos = tipo === 'plano' ? CAMPOS_FINANCEIROS_PLANO : CAMPOS_FINANCEIROS_PEDIDO;
  const diff = [];
  for (const campo of campos) {
    const a = retratoGravado?.[campo] ?? null;
    const b = novo[campo] ?? null;
    const iguais = ['cupom', 'nome', 'ciclo', 'isentarTaxa'].includes(campo) ? a === b : a === b || mesmoDinheiro(a === null ? null : a / 100, b === null ? null : b / 100);
    if (!iguais) diff.push(campo);
  }
  return diff;
}

export async function criarCotacao({ contratanteId, tipo, referenciaId, origem, totais, agora = new Date() }) {
  const retrato = retratoFinanceiro(tipo, origem);
  const { data, error } = await supabase
    .from('cotacoes')
    .insert({
      contratante_id: contratanteId,
      tipo,
      referencia_id: String(referenciaId),
      retrato,
      totais,
      retrato_hash: hashDoRetrato(retrato),
      criado_em: agora.toISOString(),
      expira_em: new Date(agora.getTime() + VALIDADE_COTACAO_MIN * 60_000).toISOString()
    })
    .select('id, expira_em')
    .single();
  if (error) throw error;
  return { id: data.id, expiraEm: data.expira_em, retrato, totais };
}

/**
 * Lê a cotação para cobrar. Devolve `null` quando não existe, não é
 * deste contratante/referência, ou expirou — o chamador responde 409
 * com uma cotação nova em qualquer um dos três casos (a tela não sabe a
 * diferença e não precisa saber).
 */
export async function buscarCotacaoValida({ id, contratanteId, tipo, referenciaId, agora = new Date() }) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data, error } = await supabase
    .from('cotacoes')
    .select('id, retrato, totais, retrato_hash, expira_em, usada_em')
    .eq('id', id)
    .eq('contratante_id', contratanteId)
    .eq('tipo', tipo)
    .eq('referencia_id', String(referenciaId))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (new Date(data.expira_em) < agora) return null;
  return data;
}

/** Carimba o uso (diagnóstico; a cotação pode ser reusada pelo mesmo
 *  pedido para outro método — o que a torna inválida é expirar ou
 *  divergir, não ter sido usada). */
export async function marcarCotacaoUsada(id) {
  const { error } = await supabase.from('cotacoes').update({ usada_em: new Date().toISOString() }).eq('id', id).is('usada_em', null);
  if (error) console.error('[cotacao.marcarUsada]', error.message);
}

/** Expurgo diário: cotação vencida há mais de um dia sai. */
export async function expurgarCotacoes() {
  const corte = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { error } = await supabase.from('cotacoes').delete().lt('expira_em', corte);
  if (error) console.error('[cotacao.expurgar]', error.message);
}

/* ------------------------------------------------------------------
   Autoteste — `node src/services/cotacaoService.js`
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('cotacaoService.js')) {
  const { strict: assertReal } = await import('node:assert');
  let checagens = 0;
  const assert = new Proxy(assertReal, {
    get(alvo, nome) {
      const valor = alvo[nome];
      if (typeof valor !== 'function') return valor;
      return (...args) => { checagens += 1; return valor.apply(alvo, args); };
    }
  });

  const pedido = {
    pedidoId: 'ped_1', descricao: 'Pedido', itens: [{ nome: 'A', quantidade: 2, valorUnitario: 3 }],
    valorCheio: 10, desconto: 2, cupom: 'TESTE20', valorComDesconto: 8, frete: 1.5, isentarTaxa: false,
    pagador: { nome: 'Fulano', documento: '123' }
  };
  const retrato = retratoFinanceiro('pedido', pedido);

  // centavos, sem pessoa
  assert.equal(retrato.valorComDesconto, 800);
  assert.equal(retrato.frete, 150);
  assert.equal(retrato.cupom, 'TESTE20');
  assert.equal(retrato.taxaDoProjeto, null);
  assert.deepEqual(retrato.itens, [{ nome: 'A', quantidade: 2, valorUnitario: 300 }]);
  assert.ok(!JSON.stringify(retrato).includes('Fulano'));
  assert.ok(!JSON.stringify(retrato).includes('123'));

  // mesmo pedido, outra representação → sem divergência
  assert.deepEqual(divergencias('pedido', retrato, { ...pedido, valorComDesconto: '8.00', frete: 1.5000000001 }), []);
  // a pessoa e o nome do item mudaram → continua sem divergência (não é preço)
  assert.deepEqual(divergencias('pedido', retrato, { ...pedido, pagador: { nome: 'Outro' }, itens: [{ nome: 'B' }] }), []);
  // o preço mudou → acusa o campo certo
  assert.deepEqual(divergencias('pedido', retrato, { ...pedido, valorComDesconto: 9 }), ['valorComDesconto']);
  assert.deepEqual(divergencias('pedido', retrato, { ...pedido, frete: 0 }), ['frete']);
  assert.deepEqual(divergencias('pedido', retrato, { ...pedido, cupom: null, desconto: 0, valorComDesconto: 10 }).sort(), ['cupom', 'desconto', 'valorComDesconto']);
  assert.deepEqual(divergencias('pedido', retrato, { ...pedido, isentarTaxa: true }), ['isentarTaxa']);
  // valor sumiu (contratante respondeu sem o campo) → diverge, nunca vira zero
  assert.deepEqual(divergencias('pedido', retrato, { ...pedido, valorComDesconto: undefined }), ['valorComDesconto']);
  assert.deepEqual(divergencias('pedido', retrato, { ...pedido, valorComDesconto: null }), ['valorComDesconto']);

  // plano
  const plano = { nome: 'Pro', valor: 249, ciclo: 'MONTHLY' };
  const rp = retratoFinanceiro('plano', plano);
  assert.deepEqual(rp, { nome: 'Pro', valor: 24900, ciclo: 'MONTHLY' });
  assert.deepEqual(divergencias('plano', rp, { ...plano, valor: '249.00' }), []);
  assert.deepEqual(divergencias('plano', rp, { ...plano, valor: 199 }), ['valor']);
  assert.deepEqual(divergencias('plano', rp, { ...plano, ciclo: 'QUARTERLY' }), ['ciclo']);
  assert.deepEqual(divergencias('plano', rp, { ...plano, nome: 'Pro v2' }), ['nome']);

  // hash determinístico e sensível
  assert.equal(hashDoRetrato(retrato), hashDoRetrato(retratoFinanceiro('pedido', { ...pedido })));
  assert.notEqual(hashDoRetrato(retrato), hashDoRetrato(retratoFinanceiro('pedido', { ...pedido, frete: 2 })));

  console.log(`cotacaoService: ${checagens} checagens OK`);
}
