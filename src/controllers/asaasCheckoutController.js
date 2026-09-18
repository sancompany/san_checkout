/**
 * SAN CHECKOUT v2 — src/controllers/asaasCheckoutController.js
 * Fluxo do Asaas Checkout (pop-up hospedada) — Cartão e Assinatura.
 * Boleto NÃO usa mais este fluxo: confirmado em sandbox que o Asaas
 * Checkout só aceita billingTypes CREDIT_CARD/PIX (Boleto dá erro
 * "O campo billingTypes é inválido") — Boleto migrou pra cobrança
 * direta (POST /v3/payments), igual o Pix, ver `checkoutController.js`
 * e `asaasService.criarCobrancaBoleto`.
 *
 * ⚠️ CONFIRMADO EM SANDBOX: telefone é obrigatório em `customerData`
 * (a Asaas recusa sem ele) — por isso o front agora pede telefone
 * junto de nome/e-mail/CPF. O nome do campo é `phone` (confirmado
 * contra o schema oficial `CheckoutSessionCustomerDataDTO` da própria
 * Asaas) — a mensagem de erro cita "phoneNumber", mas isso é só o
 * rótulo interno usado na validação, não a chave JSON de verdade; não
 * tentar `phoneNumber` de novo achando que é isso. O nome do campo pra
 * CPF (`cpfCnpj`) segue por analogia com o resto da API — não deu
 * erro, mas também não foi confirmado byte a byte contra a doc.
 * (O `callback`, que também estava sinalizado aqui, já foi confirmado
 * como obrigatório e adicionado em `asaasService.criarSessaoAsaasCheckout`.)
 *
 * ⚠️ CONFIRMADO EM SANDBOX (segunda rodada): endereço completo também
 * é obrigatório em `customerData` ("O campo address deve ser
 * informado") — antifraude da Asaas pra Cartão/Assinatura. Campos:
 * `address` (rua), `addressNumber`, `complement` (opcional),
 * `province` (= BAIRRO, não estado, apesar do nome em inglês),
 * `postalCode`, e `city` — este último é o CÓDIGO IBGE NUMÉRICO do
 * município (ex.: 4205407), não o nome da cidade (confirmado no
 * schema oficial `CheckoutSessionCustomerDataDTO`). O front resolve
 * esse código a partir do CEP via ViaCEP (ver
 * public/js/utils/cep.js) e manda pronto como `cidadeIbge`.
 */

import { resolverPedido, resolverPlano } from '../services/pedidoService.js';
import { taxaComParcelasQueCabem } from '../services/taxaService.js';
import {
  criarSessaoAsaasCheckout,
  criarAutorizacaoPixAutomatico,
  frequenciaPixAutomatico,
  buscarOuCriarCliente
} from '../services/asaasService.js';
import { montarUrlCheckoutSession } from '../config/asaas.js';
import { registrarCobrancaPendentePopup, buscarCobrancaPorCheckoutId } from '../services/cobrancaService.js';
import { buscarAssinaturaAtiva } from '../services/assinaturaService.js';
import {
  documentoValido, emailValido, valorValido, telefoneValido, cepValido, nomeValido,
  normalizarDocumento, camposDeEnderecoDentroDoTeto,
  valorCobradoAceitavel, MENSAGEM_PISO_ASAAS,
  parcelasValidas, MAXIMO_DE_PARCELAS_DO_CHECKOUT
} from '../utils/validadores.js';
import { tokenRenovacaoValido } from '../utils/tokenRenovacao.js';
import { responderErro } from '../utils/erros.js';

/**
 * Os SETE ciclos que a Asaas aceita — o conjunto inteiro, não o pedaço
 * que o projeto da vez usa. Espelhado no front em
 * `public/js/modules/assinaturaHandler.js` (ROTULOS_CICLO), que traduz
 * cada um pra português; mexeu aqui, mexe lá.
 */
export const CICLOS_VALIDOS = [
  'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'BIMONTHLY',
  'QUARTERLY', 'SEMIANNUALLY', 'YEARLY'
];

export async function criarCheckoutCartao(requisicao, resposta) {
  const { contratanteId, pedidoId } = requisicao.params;
  let {
    nome, email, documento, telefone, parcelas,
    endereco, enderecoNumero, complemento, bairro, cep, cidade, uf, cidadeIbge
  } = requisicao.body ?? {};

  if (!nome || !email || !documento || !telefone) {
    return resposta.status(400).json({ erro: 'Nome, e-mail, CPF/CNPJ e telefone são obrigatórios.' });
  }
  if (!nomeValido(nome)) return resposta.status(400).json({ erro: 'Nome inválido.' });
  if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });

  // Dígitos, e daqui para baixo é só esta forma (RN-32) — a explicação
  // inteira está em `normalizarDocumento`, em `utils/validadores.js`.
  documento = normalizarDocumento(documento);
  if (!emailValido(email)) return resposta.status(400).json({ erro: 'E-mail inválido.' });
  if (!telefoneValido(telefone)) return resposta.status(400).json({ erro: 'Telefone inválido.' });
  if (!parcelasValidas(parcelas)) {
    return resposta.status(400).json({ erro: `Número de parcelas inválido (1 a ${MAXIMO_DE_PARCELAS_DO_CHECKOUT}).` });
  }

  // Antifraude da Asaas pra Cartão — ver nota no topo do arquivo.
  if (!endereco || !enderecoNumero || !bairro || !cep || !cidadeIbge) {
    return resposta.status(400).json({ erro: 'Endereço completo (rua, número, bairro e CEP) é obrigatório.' });
  }
  if (!cepValido(cep)) return resposta.status(400).json({ erro: 'CEP inválido.' });
  // Presença não é tamanho — achado no ciclo de revisão do projeto
  // inteiro em 18/09/2026: até aqui só `cep` tinha teto, e um `endereco`
  // de 100 KB atravessava e ia direto pra Asaas e pra `cobrancas`.
  if (!camposDeEnderecoDentroDoTeto({ endereco, enderecoNumero, complemento, bairro, cidade, uf })) {
    return resposta.status(400).json({ erro: 'Endereço muito longo.' });
  }

  const numeroParcelas = Number(parcelas);

  try {
    const { contratante, pedido } = await resolverPedido(contratanteId, pedidoId, { metodoRequerido: 'cartao' });

    const valorBase = Number(pedido.valorComDesconto ?? 0) + Number(pedido.frete ?? 0);
    if (!valorValido(valorBase)) {
      return resposta.status(400).json({ erro: 'Valor do pedido inválido.' });
    }

    /* O PISO DA ASAAS É POR PARCELA, não só sobre o total.

       R$ 24,00 em 12x dá R$ 2,00 por parcela, e a Asaas recusa a
       cobrança. Pior: `POST /v3/checkouts` ACEITA a sessão assim
       (medido), então sem isto a pop-up abre, o comprador escolhe 12x,
       digita o cartão, e só aí é recusado — dentro da pop-up, com
       mensagem de provedor.

       A conta mora em `taxaService.taxaComParcelasQueCabem`, junto da
       taxa, porque as duas se determinam uma à outra: a taxa depende da
       faixa de parcelas, e quantas parcelas cabem depende do valor com
       taxa. Ofertar menos em vez de recusar: um pedido de R$ 24,00
       fecha em R$ 26,15 e sai em 5x de R$ 5,23 — uma venda que a Asaas
       faz sem reclamar, e que recusar jogaria fora. */
    const { parcelas: parcelasOfertadas, taxa } = taxaComParcelasQueCabem(
      valorBase,
      numeroParcelas,
      Boolean(pedido.isentarTaxa)
    );
    const { taxaAsaas, taxaPropria, valorCobrado } = taxa;

    // Ver a nota do piso em `utils/validadores.js`. No cartão isto
    // poupa o comprador de preencher endereço inteiro (exigência
    // antifraude da Asaas) para receber um 400 no fim. Vale para o
    // TOTAL; o piso por parcela é o laço acima.
    if (!valorCobradoAceitavel(valorCobrado)) {
      return resposta.status(400).json({ erro: MENSAGEM_PISO_ASAAS });
    }

    const splits = contratante?.wallet_id
      ? [{ walletId: contratante.wallet_id, fixedValue: valorBase }]
      : undefined;

    const { asaasCheckoutId } = await criarSessaoAsaasCheckout({
      billingTypes: ['CREDIT_CARD'],
      chargeTypes: parcelasOfertadas > 1 ? ['DETACHED', 'INSTALLMENT'] : ['DETACHED'],
      itens: [{
        name: pedido.descricao ?? 'Pagamento via SAN & CO. Pay Engine',
        quantity: 1,
        value: valorCobrado
      }],
      ...(parcelasOfertadas > 1 ? { installment: { maxInstallmentCount: parcelasOfertadas } } : {}),
      customerData: {
        name: nome,
        email,
        cpfCnpj: documento,
        phone: telefone,
        address: endereco,
        addressNumber: enderecoNumero,
        ...(complemento ? { complement: complemento } : {}),
        province: bairro,
        postalCode: String(cep).replace(/\D/g, ''),
        city: Number(cidadeIbge)
      },
      splits
    });

    await registrarCobrancaPendentePopup({
      asaasCheckoutId,
      contratanteId,
      pedidoId,
      documento,
      email,
      telefone,
      endereco,
      enderecoNumero,
      complemento,
      bairro,
      cep,
      cidade,
      uf,
      cidadeIbge,
      itens: pedido.itens ?? null,
      valorCheio: pedido.valorCheio,
      desconto: pedido.desconto,
      cupom: pedido.cupom,
      valorComDesconto: pedido.valorComDesconto,
      frete: pedido.frete,
      taxaDoProjeto: pedido.taxaDoProjeto,
      taxaAsaas,
      taxaPropria,
      taxaIsenta: Boolean(pedido.isentarTaxa),
      valorCobrado,
      metodoPagamento: 'cartao_credito',
      /* O que se grava é o que foi OFERTADO, não o que foi pedido: é
         esse número que limita o que o comprador pode escolher na
         pop-up, e a conciliação tem de bater com a realidade. */
      parcelas: parcelasOfertadas
    });

    resposta.json({
      checkoutUrl: montarUrlCheckoutSession(asaasCheckoutId),
      asaasCheckoutId
    });
  } catch (erro) {
    if (erro.corpoAsaas) console.error('[checkout/cartao] corpoAsaas:', erro.corpoAsaas);
    responderErro(resposta, erro, 'checkout/cartao');
  }
}

function formatarDataHoraAsaas(data) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${data.getFullYear()}-${pad(data.getMonth() + 1)}-${pad(data.getDate())} `
    + `${pad(data.getHours())}:${pad(data.getMinutes())}:${pad(data.getSeconds())}`;
}

/**
 * POST /api/checkout/assinatura/:contratanteId/:planoId
 * Cria a sessão RECURRENT — o pagador digita o cartão uma única vez na
 * pop-up e a Asaas passa a cobrar sozinha todo ciclo (ver
 * API.md §7).
 *
 * Existe também a assinatura por PIX AUTOMÁTICO, sem cartão, em
 * `criarAssinaturaPixAutomatico` no fim deste arquivo (a nota antiga
 * aqui dizia que Pix Automático tinha sido descartado — isso mudou).
 *
 * O webhook de cobranças de ciclos seguintes (`tipo: "assinatura"`,
 * eventos criada/cobranca_confirmada/cobranca_falhou/cancelada, ver
 * API.md 4.3 e 7.4) JÁ EXISTE no `webhookController.js` — é o caminho
 * `registrarCicloAssinatura`, que usa a cobrança mais recente daquela
 * subscription como molde. Esta nota dizia o contrário até 14/09/2026,
 * quando o código já a desmentia havia várias entregas.
 *
 * ⚠️ A primeira cobrança sai SEMPRE no ato (`nextDueDate` = agora, mais
 * abaixo). Não existe carência, mês grátis nem desconto em assinatura —
 * o que isso impede, e como modelar "pague 3, leve 4" mesmo assim, está
 * em API.md 7.5. Mexer aqui é caminho de dinheiro: pede autorização.
 */
export async function criarCheckoutAssinatura(requisicao, resposta) {
  const { contratanteId, planoId } = requisicao.params;
  let {
    nome, email, documento, telefone,
    endereco, enderecoNumero, complemento, bairro, cep, cidade, uf, cidadeIbge,
    renovar
  } = requisicao.body ?? {};

  if (!nome || !email || !documento || !telefone) {
    return resposta.status(400).json({ erro: 'Nome, e-mail, CPF/CNPJ e telefone são obrigatórios.' });
  }
  if (!nomeValido(nome)) return resposta.status(400).json({ erro: 'Nome inválido.' });
  if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });

  // Dígitos, e daqui para baixo é só esta forma (RN-32) — a explicação
  // inteira está em `normalizarDocumento`, em `utils/validadores.js`.
  documento = normalizarDocumento(documento);
  if (!emailValido(email)) return resposta.status(400).json({ erro: 'E-mail inválido.' });
  if (!telefoneValido(telefone)) return resposta.status(400).json({ erro: 'Telefone inválido.' });

  // Antifraude da Asaas pra Cartão — assinatura também é cartão (ver
  // nota no topo do arquivo).
  if (!endereco || !enderecoNumero || !bairro || !cep || !cidadeIbge) {
    return resposta.status(400).json({ erro: 'Endereço completo (rua, número, bairro e CEP) é obrigatório.' });
  }
  if (!cepValido(cep)) return resposta.status(400).json({ erro: 'CEP inválido.' });
  // Mesma checagem do cartão avulso acima — ver a nota lá.
  if (!camposDeEnderecoDentroDoTeto({ endereco, enderecoNumero, complemento, bairro, cidade, uf })) {
    return resposta.status(400).json({ erro: 'Endereço muito longo.' });
  }

  try {
    const { contratante, plano } = await resolverPlano(contratanteId, planoId, { metodoRequerido: 'assinatura' });

    const valor = Number(plano.valor ?? 0);
    if (!valorValido(valor)) {
      return resposta.status(400).json({ erro: 'Valor do plano inválido.' });
    }

    // Assinatura não leva taxa nossa — o valor do plano é o valor
    // cobrado, e o piso de R$ 5,00 vale por CICLO (medido em
    // `POST /v3/subscriptions`, ver `utils/validadores.js`).
    if (!valorCobradoAceitavel(valor)) {
      return resposta.status(400).json({ erro: MENSAGEM_PISO_ASAAS });
    }

    // O ciclo vem da API do contratante, então é entrada externa e é
    // checada aqui. Antes ia direto pra Asaas: um valor errado só
    // falhava lá, com mensagem da Asaas, difícil de rastrear até o
    // plano do parceiro.
    const ciclo = plano.ciclo ?? 'MONTHLY';
    if (!CICLOS_VALIDOS.includes(ciclo)) {
      return resposta.status(400).json({
        erro: `Ciclo de assinatura inválido: "${ciclo}". Valores aceitos: ${CICLOS_VALIDOS.join(', ')}.`
      });
    }

    // RENOVAÇÃO (link com `&renovar={token}`): o assinante está
    // trocando o cartão de uma assinatura que já existe. Não dá pra
    // trocar o cartão pela API da Asaas sem receber número e CVV no
    // nosso servidor — isso colocaria o projeto dentro do escopo PCI,
    // que é exatamente o que a pop-up hospedada evita. Então o caminho
    // é criar uma assinatura NOVA pela pop-up e cancelar a antiga
    // quando a nova confirmar (webhookController).
    //
    // `renovar` PRECISA ser o token que só o contratante consegue gerar
    // (com a própria api_key, `utils/tokenRenovacao.js`) — não basta
    // saber o `documento`, que não é segredo. Até 16/09/2026 bastava
    // `renovar: true`: qualquer um que soubesse o CPF/CNPJ de um
    // assinante ativo criava uma assinatura nova com o PRÓPRIO cartão
    // e, ao pagá-la, cancelava a assinatura de VERDADE da vítima na
    // Asaas — sequestro/cancelamento cross-pagador, sem credencial
    // nenhuma. Token ausente ou inválido não é erro: degrada pra
    // "assinatura nova comum", sem amarrar nem cancelar nada — o modo
    // seguro, não o que abre a porta.
    //
    // Guarda só a referência aqui; nada é cancelado antes do pagamento
    // entrar — se a renovação não for concluída, a assinatura antiga
    // continua intacta.
    const assinaturaSubstituida = tokenRenovacaoValido(renovar, contratante?.api_key, { contratanteId, planoId, documento })
      ? await buscarAssinaturaAtiva(contratanteId, planoId, documento, ['ativa', 'pausada'])
      : null;

    // Nesta leva, assinatura NÃO aplica taxaPropria/taxaAsaas — cobra
    // o valor do plano exatamente como veio. Se isso deve mudar, é
    // decisão pendente, ainda não tomada (ver API.md §8).
    const splits = contratante?.wallet_id
      ? [{ walletId: contratante.wallet_id, fixedValue: valor }]
      : undefined;

    const { asaasCheckoutId } = await criarSessaoAsaasCheckout({
      billingTypes: ['CREDIT_CARD'],
      chargeTypes: ['RECURRENT'],
      itens: [{
        name: plano.nome ?? 'Assinatura via SAN & CO. Pay Engine',
        quantity: 1,
        value: valor
      }],
      subscription: {
        cycle: ciclo,
        nextDueDate: formatarDataHoraAsaas(new Date())
      },
      customerData: {
        name: nome,
        email,
        cpfCnpj: documento,
        phone: telefone,
        address: endereco,
        addressNumber: enderecoNumero,
        ...(complemento ? { complement: complemento } : {}),
        province: bairro,
        postalCode: String(cep).replace(/\D/g, ''),
        city: Number(cidadeIbge)
      },
      splits
    });

    await registrarCobrancaPendentePopup({
      asaasCheckoutId,
      contratanteId,
      planoId,
      documento,
      email,
      telefone,
      endereco,
      enderecoNumero,
      complemento,
      bairro,
      cep,
      cidade,
      uf,
      cidadeIbge,
      valorCheio: valor,
      valorComDesconto: valor,
      taxaAsaas: 0,
      taxaPropria: 0,
      taxaIsenta: true, // nesta leva, assinatura nunca aplica taxa — não é uma isenção concedida, é a simplificação atual
      valorCobrado: valor,
      metodoPagamento: 'assinatura',
      substituiAssinaturaId: assinaturaSubstituida?.id ?? null,
      parcelas: 1,
      // O MESMO `ciclo` já validado acima e já mandado pra Asaas em
      // `subscription.cycle` — gravado agora, não esperando o webhook
      // ecoar de volta. Achado em 15/09/2026: nem CHECKOUT_PAID nem
      // PAYMENT_CONFIRMED confiavelmente trazem esse campo de volta, e
      // essa cobrança já sabe o valor certo antes de existir qualquer
      // webhook — é o que `webhookController.amarrarAssinaturaACobranca`
      // lê na hora de criar a linha em `assinaturas`.
      ciclo
    });

    resposta.json({
      checkoutUrl: montarUrlCheckoutSession(asaasCheckoutId),
      asaasCheckoutId
    });
  } catch (erro) {
    if (erro.corpoAsaas) console.error('[checkout/assinatura] corpoAsaas:', erro.corpoAsaas);
    responderErro(resposta, erro, 'checkout/assinatura');
  }
}

/**
 * GET /api/checkout/asaas-checkout/status/:asaasCheckoutId
 * Usado pelo polling do front enquanto a pop-up está aberta (Cartão,
 * Boleto e, mais adiante, Assinatura reaproveitam este mesmo
 * endpoint). O status vem do NOSSO banco (atualizado pelo
 * webhookController quando CHECKOUT_PAID/CANCELED/EXPIRED chegar) —
 * nunca consultando a Asaas na hora, pra não duplicar a fonte de
 * verdade do webhook.
 */
export async function consultarStatusCheckout(requisicao, resposta) {
  try {
    const cobranca = await buscarCobrancaPorCheckoutId(requisicao.params.asaasCheckoutId);
    if (!cobranca) return resposta.status(404).json({ erro: 'Sessão não encontrada.' });

    // Traduz nosso status interno de volta pro vocabulário que o front
    // já espera (mesmo nome de evento que a Asaas usa).
    const mapa = { pendente: 'PENDING', confirmado: 'CHECKOUT_PAID', cancelado: 'CHECKOUT_CANCELED', expirado: 'CHECKOUT_EXPIRED' };
    resposta.json({ status: mapa[cobranca.status] ?? cobranca.status });
  } catch (erro) {
    responderErro(resposta, erro, 'asaas-checkout/status');
  }
}

/**
 * POST /api/checkout/assinatura-pix/:contratanteId/:planoId
 *
 * Assinatura por PIX AUTOMÁTICO — recorrência sem cartão. O pagador lê
 * um QR no app do banco e, no mesmo ato, paga a primeira cobrança e
 * autoriza os débitos seguintes.
 *
 * Diferente da assinatura por cartão, aqui NÃO tem pop-up nem endereço:
 * o endereço só existia por exigência antifraude do cartão. Menos
 * atrito, e alcança quem não tem cartão de crédito.
 */
export async function criarAssinaturaPixAutomatico(requisicao, resposta) {
  const { contratanteId, planoId } = requisicao.params;
  let { nome, email, documento, telefone } = requisicao.body ?? {};

  if (!nome || !email || !documento) {
    return resposta.status(400).json({ erro: 'Nome, e-mail e CPF/CNPJ são obrigatórios.' });
  }
  if (!nomeValido(nome)) return resposta.status(400).json({ erro: 'Nome inválido.' });
  if (!documentoValido(documento)) return resposta.status(400).json({ erro: 'CPF/CNPJ inválido.' });

  // Dígitos, e daqui para baixo é só esta forma (RN-32) — a explicação
  // inteira está em `normalizarDocumento`, em `utils/validadores.js`.
  documento = normalizarDocumento(documento);
  if (!emailValido(email)) return resposta.status(400).json({ erro: 'E-mail inválido.' });
  // Telefone é opcional aqui (o Pix Automático não exige, diferente da
  // pop-up de cartão/assinatura), mas quando vem passa pela MESMA
  // checagem — achado no ciclo de revisão do projeto inteiro em
  // 18/09/2026: sem isto, um telefone de 100 KB atravessava e ia gravado
  // cru em `cobrancas`.
  if (telefone && !telefoneValido(telefone)) return resposta.status(400).json({ erro: 'Telefone inválido.' });

  try {
    const { plano } = await resolverPlano(contratanteId, planoId, { metodoRequerido: 'assinatura_pix' });

    const valor = Number(plano.valor ?? 0);
    if (!valorValido(valor)) return resposta.status(400).json({ erro: 'Valor do plano inválido.' });
    if (!valorCobradoAceitavel(valor)) return resposta.status(400).json({ erro: MENSAGEM_PISO_ASAAS });

    const ciclo = plano.ciclo ?? 'MONTHLY';
    if (!CICLOS_VALIDOS.includes(ciclo)) {
      return resposta.status(400).json({
        erro: `Ciclo de assinatura inválido: "${ciclo}". Valores aceitos: ${CICLOS_VALIDOS.join(', ')}.`
      });
    }

    // O Pix Automático cobre menos ciclos que a assinatura por cartão —
    // recusa aqui, com o motivo, em vez de deixar a Asaas rejeitar com
    // mensagem obscura.
    const frequencia = frequenciaPixAutomatico(ciclo);
    if (!frequencia) {
      return resposta.status(400).json({
        erro: `O ciclo "${ciclo}" não existe no Pix Automático. ` +
              `Use assinatura por cartão para este plano, ou um destes ciclos: ` +
              `${CICLOS_VALIDOS.filter((c) => frequenciaPixAutomatico(c)).join(', ')}.`
      });
    }

    const clienteId = await buscarOuCriarCliente({ nome, email, documento });

    const autorizacao = await criarAutorizacaoPixAutomatico({
      clienteId,
      // `contractId` é o que liga a autorização ao objeto cobrado do
      // nosso lado — o plano do contratante.
      contratoId: `${contratanteId}:${planoId}`,
      frequencia,
      valor,
      descricao: plano.nome ?? 'Assinatura via SAN & CO. Pay Engine',
      inicioEm: new Date().toISOString().slice(0, 10)
    });

    await registrarCobrancaPendentePopup({
      asaasCheckoutId: autorizacao.autorizacaoId, // a autorização faz o papel da sessão aqui
      contratanteId,
      planoId,
      documento,
      email,
      telefone,
      valorCheio: valor,
      valorComDesconto: valor,
      taxaAsaas: 0,
      taxaPropria: 0,
      taxaIsenta: true, // mesma regra da assinatura por cartão nesta leva
      valorCobrado: valor,
      metodoPagamento: 'assinatura_pix',
      parcelas: 1,
      // Mesmo motivo da assinatura por cartão (criarCheckoutAssinatura):
      // `ciclo` já validado acima, gravado na criação em vez de esperado
      // de um campo não confirmado do payload da Asaas — sem isso,
      // `upsertAssinatura` cairia no default 'MONTHLY', reintroduzindo o
      // mesmo bug do `docs/erros/2026-09-15-ciclo-de-assinatura-nao-vinha-de-webhook-nenhum.md`
      // por outra porta.
      ciclo
    });

    resposta.json({
      autorizacaoId: autorizacao.autorizacaoId,
      status: autorizacao.status,
      qrCodeBase64: autorizacao.qrCodeBase64,
      copiaECola: autorizacao.copiaECola
    });
  } catch (erro) {
    responderErro(resposta, erro, 'asaasCheckout.criarAssinaturaPixAutomatico');
  }
}
