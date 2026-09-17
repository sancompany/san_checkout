/**
 * SAN CHECKOUT v2 — src/services/cobrancaService.js
 * Registra cada cobrança criada, liga com o contratante/pedido de
 * origem, e serve de consulta pro webhook e pro estorno.
 *
 * **Toda** inserção aqui grava `ambiente` (migration 0009, RN-33): em
 * que ambiente da Asaas a cobrança nasceu. Vem de `ambienteAsaas()`,
 * nunca do corpo da requisição — é fato do servidor, e deixá-lo entrar
 * de fora seria a mesma classe do valor que o comprador escolhe. A
 * métrica de sucesso exclui `sandbox`, e esquecer a coluna numa
 * inserção nova conta a métrica para BAIXO em silêncio: o autoteste de
 * `metricaService` varre este arquivo justamente por isso.
 */

import { supabase } from '../config/supabase.js';
import { ambienteAsaas } from '../config/asaas.js';

export async function registrarCobranca(dados) {
  const { error } = await supabase.from('cobrancas').insert({
    ambiente: ambienteAsaas(),
    charge_id: dados.chargeId,
    contratante_id: dados.contratanteId,
    pedido_id: dados.pedidoId,
    documento: dados.documento,
    email: dados.email ?? null,
    telefone: dados.telefone ?? null,
    endereco: dados.endereco ?? null,
    endereco_numero: dados.enderecoNumero ?? null,
    endereco_complemento: dados.complemento ?? null,
    bairro: dados.bairro ?? null,
    cep: dados.cep ?? null,
    cidade: dados.cidade ?? null,
    uf: dados.uf ?? null,
    cidade_ibge: dados.cidadeIbge ? Number(dados.cidadeIbge) : null,
    itens: dados.itens ?? null,
    valor_cheio: dados.valorCheio,
    desconto: dados.desconto ?? 0,
    cupom: dados.cupom ?? null,
    valor_com_desconto: dados.valorComDesconto,
    frete: dados.frete ?? 0,
    taxa_do_projeto: dados.taxaDoProjeto ?? 0,
    taxa_asaas: dados.taxaAsaas,
    taxa_propria: dados.taxaPropria,
    taxa_isenta: dados.taxaIsenta ?? false,
    valor_cobrado: dados.valorCobrado,
    metodo_pagamento: dados.metodoPagamento
  });

  if (error) console.error('[cobrancaService.registrarCobranca]', error.message);
}

/**
 * Registra uma cobrança do fluxo POP-UP (Cartão/Boleto/Assinatura) —
 * criada ANTES de existir charge_id, só com asaas_checkout_id. O
 * charge_id de verdade é preenchido depois, via
 * `vincularChargeIdAoCheckout`, quando o webhook CHECKOUT_PAID chegar.
 */
export async function registrarCobrancaPendentePopup(dados) {
  const { error } = await supabase.from('cobrancas').insert({
    ambiente: ambienteAsaas(),
    asaas_checkout_id: dados.asaasCheckoutId,
    contratante_id: dados.contratanteId,
    pedido_id: dados.pedidoId ?? null,
    plano_id: dados.planoId ?? null,
    documento: dados.documento,
    email: dados.email ?? null,
    telefone: dados.telefone ?? null,
    endereco: dados.endereco ?? null,
    endereco_numero: dados.enderecoNumero ?? null,
    endereco_complemento: dados.complemento ?? null,
    bairro: dados.bairro ?? null,
    cep: dados.cep ?? null,
    cidade: dados.cidade ?? null,
    uf: dados.uf ?? null,
    cidade_ibge: dados.cidadeIbge ? Number(dados.cidadeIbge) : null,
    itens: dados.itens ?? null,
    valor_cheio: dados.valorCheio,
    desconto: dados.desconto ?? 0,
    cupom: dados.cupom ?? null,
    valor_com_desconto: dados.valorComDesconto,
    frete: dados.frete ?? 0,
    taxa_do_projeto: dados.taxaDoProjeto ?? 0,
    taxa_asaas: dados.taxaAsaas,
    taxa_propria: dados.taxaPropria,
    taxa_isenta: dados.taxaIsenta ?? false,
    valor_cobrado: dados.valorCobrado,
    metodo_pagamento: dados.metodoPagamento,
    // Renovação de assinatura (v3.4): guarda qual assinatura esta aqui
    // vem substituir. Só é preenchido quando o link traz `&renovar=1` —
    // cancelar a antiga é efeito com consequência em dinheiro, então
    // depende de intenção declarada, nunca de heurística.
    substitui_assinatura_id: dados.substituiAssinaturaId ?? null,
    parcelas: dados.parcelas ?? 1,
    // Só assinatura preenche isto (`criarCheckoutAssinatura` já validou
    // contra `CICLOS_VALIDOS` antes de chegar aqui). É o mesmo valor
    // que mandamos pra Asaas em `subscription.cycle` — capturado NA
    // CRIAÇÃO, antes de qualquer webhook, porque é aqui que ele é
    // conhecido com certeza. Achado em 15/09/2026: nem CHECKOUT_PAID
    // nem PAYMENT_CONFIRMED confiavelmente ecoam esse campo de volta —
    // `webhookController.amarrarAssinaturaACobranca` lê daqui, não do
    // webhook, na hora de criar a linha em `assinaturas`.
    ciclo: dados.ciclo ?? null,
    status: 'pendente'
  });

  if (error) console.error('[cobrancaService.registrarCobrancaPendentePopup]', error.message);
}

/**
 * Registra um CICLO NOVO de assinatura recorrente — diferente de
 * `registrarCobrancaPendentePopup` (usada só na 1ª cobrança, criada
 * ANTES de existir charge_id). A partir do 2º ciclo, a Asaas cobra
 * sozinha e o charge_id já vem pronto no próprio webhook de pagamento
 * (`payment.id`), então esta função insere direto com ele — sem passar
 * pelo estado intermediário "pendente popup". `dados` é montado a
 * partir da cobrança-modelo (a mais recente daquela assinatura, ver
 * `buscarCobrancaPorSubscriptionId`), copiando contratante/plano/CPF/
 * telefone/endereço, só trocando charge_id e valor.
 */
/**
 * Devolve `{ duplicado: true }` quando o `charge_id` já existe (código
 * Postgres `23505`, violação do `unique` da migration 0001) — a Asaas
 * reenvia webhook (API.md §4.3.6, "pode chegar mais de uma vez"), e sem
 * distinguir esse caso, duas entregas quase simultâneas do MESMO
 * `PAYMENT_CONFIRMED` de um ciclo novo liam a linha como inexistente
 * ANTES de qualquer uma das duas terminar de inserir — as duas
 * inseriam (uma vencia, uma batia no `unique` e antes disso só logava
 * `console.error` sem sinalizar nada), e as duas acabavam mandando
 * `cobranca_confirmada` pro contratante pro MESMO ciclo. Quem chama
 * (`registrarNovoCicloAssinatura`, webhookController.js) usa esse sinal
 * pra pular a notificação na entrega perdedora.
 */
export async function registrarCicloAssinatura(dados) {
  const { error } = await supabase.from('cobrancas').insert({
    ambiente: ambienteAsaas(),
    charge_id: dados.chargeId,
    asaas_subscription_id: dados.asaasSubscriptionId,
    contratante_id: dados.contratanteId,
    plano_id: dados.planoId ?? null,
    documento: dados.documento,
    email: dados.email ?? null,
    telefone: dados.telefone ?? null,
    endereco: dados.endereco ?? null,
    endereco_numero: dados.enderecoNumero ?? null,
    endereco_complemento: dados.complemento ?? null,
    bairro: dados.bairro ?? null,
    cep: dados.cep ?? null,
    cidade: dados.cidade ?? null,
    uf: dados.uf ?? null,
    cidade_ibge: dados.cidadeIbge ?? null,
    valor_cheio: dados.valorCheio,
    valor_com_desconto: dados.valorComDesconto,
    taxa_asaas: 0,
    taxa_propria: 0,
    taxa_isenta: true,
    valor_cobrado: dados.valorCobrado,
    metodo_pagamento: 'assinatura',
    parcelas: 1,
    // Copiado da cobrança-modelo junto com o resto. Sem isto, a linha do
    // 2º ciclo nasce com `ciclo` nulo e — como `buscarCobrancaPorSubscriptionId`
    // devolve sempre a MAIS RECENTE como modelo — o dado se perde a
    // partir do 3º. Ninguém lê `modelo.ciclo` hoje; a coluna é que
    // deixaria de valer para conferência e para quem ler depois.
    ciclo: dados.ciclo ?? null,
    status: 'pendente'
  });

  if (error?.code === '23505') return { duplicado: true };
  if (error) console.error('[cobrancaService.registrarCicloAssinatura]', error.message);
  return { duplicado: false };
}

/** Busca pelo id da SESSÃO (asaas_checkout_id) — é o que o front tem
 *  logo depois de criar, antes de qualquer charge_id existir. Usado
 *  pelo endpoint de status/polling. */
export async function buscarCobrancaPorCheckoutId(asaasCheckoutId) {
  const { data, error } = await supabase
    .from('cobrancas')
    // BUG CORRIGIDO (10/09): aqui era `.select('*')`, SEM o join de
    // contratantes. Como `notificarConformeMetodo` (webhookController)
    // desiste logo no `if (!cobranca.contratantes?.webhook_url)`, todo
    // pagamento de Cartão e de Assinatura era confirmado no banco e
    // NUNCA notificava a loja — silenciosamente. Passou despercebido
    // porque o fluxo de pop-up nunca chegou a rodar com webhook real.
    .select('*, contratantes(webhook_url, nome, api_key)')
    .eq('asaas_checkout_id', asaasCheckoutId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Preenche o charge_id de verdade quando o webhook CHECKOUT_PAID
 *  chegar — até então a cobrança só tinha asaas_checkout_id. */
export async function vincularChargeIdAoCheckout(asaasCheckoutId, chargeId) {
  const { error } = await supabase
    .from('cobrancas')
    .update({ charge_id: chargeId, atualizado_em: new Date().toISOString() })
    .eq('asaas_checkout_id', asaasCheckoutId);

  if (error) console.error('[cobrancaService.vincularChargeIdAoCheckout]', error.message);
}

/** Atualiza status por asaas_checkout_id — usado pelos eventos
 *  CHECKOUT_PAID/CHECKOUT_CANCELED/CHECKOUT_EXPIRED, que identificam
 *  a sessão, não a cobrança (diferente do webhook de Pix, que já
 *  identifica direto pelo payment/charge_id). */
/**
 * `confirmado_em` entra JUNTO da virada para `confirmado`, e só nela.
 *
 * Existe porque `atualizado_em` não responde "quando confirmou": ela é
 * tocada por qualquer mudança da linha, inclusive reparo manual. A
 * métrica de sucesso é por dia de confirmação (`docs/funcional.md` §9),
 * e sem uma data própria ela era inrespondível (migration 0008).
 *
 * Reconfirmação sobrescreve, e é o certo: se uma cobrança foi estornada
 * e confirmou de novo, a confirmação que vale é a de agora.
 */
function camposDeStatus(status) {
  return {
    status,
    atualizado_em: new Date().toISOString(),
    ...(status === 'confirmado' ? { confirmado_em: new Date().toISOString() } : {})
  };
}

export async function atualizarStatusPorCheckoutId(asaasCheckoutId, status) {
  const { error } = await supabase
    .from('cobrancas')
    .update(camposDeStatus(status))
    .eq('asaas_checkout_id', asaasCheckoutId);

  if (error) console.error('[cobrancaService.atualizarStatusPorCheckoutId]', error.message);
}

/** Grava o id da assinatura na Asaas (`subscription`) na cobrança da
 *  1ª cobrança — chamado só uma vez, junto do CHECKOUT_PAID, pra
 *  depois servir de "cobrança-modelo" quando ciclos seguintes
 *  chegarem (ver `buscarCobrancaPorSubscriptionId`). */
export async function atualizarSubscriptionIdDaCobranca(chargeId, subscriptionId) {
  const { error } = await supabase
    .from('cobrancas')
    .update({ asaas_subscription_id: subscriptionId, atualizado_em: new Date().toISOString() })
    .eq('charge_id', chargeId);

  if (error) console.error('[cobrancaService.atualizarSubscriptionIdDaCobranca]', error.message);
}

/** Busca a cobrança mais recente de uma assinatura — serve de "molde"
 *  (contratante/plano/documento/telefone/endereço) pra registrar um
 *  ciclo novo, que chega no webhook só com o id da assinatura, sem
 *  nenhum outro dado do pagador. */
export async function buscarCobrancaPorSubscriptionId(subscriptionId) {
  const { data, error } = await supabase
    .from('cobrancas')
    .select('*')
    .eq('asaas_subscription_id', subscriptionId)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Última cobrança de uma assinatura, localizada pelo que o CONTRATANTE
 * tem em mãos: plano + documento. Mesmo par que cancelar/pausar/retomar
 * já usam — `buscarCobrancaPorSubscriptionId` faz algo parecido, mas
 * exige o id da assinatura na Asaas, que o contratante nunca vê.
 *
 * **Tentativa de renovação abandonada não conta como "última cobrança".**
 * `&renovar=1` sem pagar cria uma linha NOVA (`substitui_assinatura_id`
 * apontando pra assinatura antiga, que continua ativa e sendo cobrada) e
 * essa linha nasce DEPOIS da última cobrança real — sem o filtro abaixo,
 * `ORDER BY criado_em DESC` pegaria a tentativa abandonada
 * (`cancelado`/`expirado`) em vez do ciclo real, e `/consultar-assinatura`
 * mentiria pro contratante que o último ciclo falhou numa assinatura que
 * está `ativa` e cobrando normalmente — mesma família do RN-20, agora na
 * conciliação em vez do webhook.
 *
 * O filtro exclui só os status que significam "nunca chegou a acontecer"
 * (`pendente`, `cancelado`, `expirado` — os únicos que
 * `processarEventoCheckout` grava numa linha de checkout/pop-up antes de
 * confirmar). Qualquer outro status conta como resultado real: uma
 * renovação que CONFIRMOU e depois foi estornada continua sendo a
 * última cobrança de verdade — a primeira versão deste filtro exigia
 * `status = 'confirmado'` exato, e por isso escondia esse estorno atrás
 * de um ciclo antigo assim que o status mudava pra `estornado`.
 *
 * ponytail: sem índice novo — `idx_cobrancas_contratante` já reduz a
 * varredura ao contratante, e o volume por contratante é pequeno.
 * Vira índice composto quando (e se) isso aparecer como lentidão.
 */
export async function buscarUltimaCobrancaDaAssinatura(contratanteId, planoId, documento) {
  const { data, error } = await supabase
    .from('cobrancas')
    .select('*')
    .eq('contratante_id', contratanteId)
    .eq('plano_id', planoId)
    .eq('documento', documento)
    .or('substitui_assinatura_id.is.null,status.not.in.(pendente,cancelado,expirado)')
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Busca a cobrança + contratante dono dela (join), usado pelo webhook
 *  e pelo estorno. */
export async function buscarCobranca(chargeId) {
  const { data, error } = await supabase
    .from('cobrancas')
    // api_key entra aqui porque é o segredo que assina o webhook de
    // saída (utils/assinaturaWebhook.js) — sem ela a notificação não
    // é enviada.
    .select('*, contratantes(webhook_url, nome, api_key)')
    .eq('charge_id', chargeId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/** Busca a cobrança mais recente de um pedido — usado no /estornar,
 *  que recebe pedidoId (não chargeId) do contratante. */
/**
 * Grava a situação cadastral de uma subconta, vinda do webhook
 * ACCOUNT_STATUS_* da Asaas. Antes disso, o operador conferia na mão se
 * a Asaas já tinha aprovado cada subconta criada via API.
 *
 * Não falha alto de propósito: é informativo, e uma subconta que a gente
 * não conhece (criada fora do painel) não deve gerar erro.
 */
export async function atualizarSituacaoSubconta(asaasAccountId, situacao) {
  const { error } = await supabase
    .from('subcontas')
    .update({
      situacao_geral: situacao.geral,
      situacao_comercial: situacao.comercial,
      situacao_bancaria: situacao.bancaria,
      situacao_documentos: situacao.documentos,
      situacao_atualizada_em: new Date().toISOString()
    })
    .eq('asaas_account_id', asaasAccountId);

  if (error) console.error('[cobrancaService.atualizarSituacaoSubconta]', error.message);
}

/**
 * Cobrança PENDENTE já criada pra esse pedido nesse mesmo método.
 *
 * É o que impede a cobrança em duplicidade: sem isso, o comprador que
 * recarrega a página e clica de novo gera um SEGUNDO Pix/boleto na
 * Asaas, e os dois ficam pagáveis (gente paga o QR antigo que ficou no
 * WhatsApp — aí é estorno na mão). O front já desabilita o botão, mas
 * isso não sobrevive a um F5.
 *
 * Filtra por método de propósito: quem gerou um Pix e depois escolheu
 * boleto deve conseguir o boleto.
 */
export async function buscarCobrancaPendenteDoPedido(contratanteId, pedidoId, metodoPagamento) {
  const { data, error } = await supabase
    .from('cobrancas')
    .select('*')
    .eq('contratante_id', contratanteId)
    .eq('pedido_id', pedidoId)
    .eq('metodo_pagamento', metodoPagamento)
    .eq('status', 'pendente')
    .not('charge_id', 'is', null)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function buscarCobrancaPorPedido(contratanteId, pedidoId) {
  const { data, error } = await supabase
    .from('cobrancas')
    .select('*')
    .eq('contratante_id', contratanteId)
    .eq('pedido_id', pedidoId)
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function atualizarStatusCobranca(chargeId, status) {
  const { error } = await supabase
    .from('cobrancas')
    .update(camposDeStatus(status))
    .eq('charge_id', chargeId);

  if (error) console.error('[cobrancaService.atualizarStatusCobranca]', error.message);
}
