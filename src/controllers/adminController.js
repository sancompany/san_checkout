/**
 * SAN CHECKOUT v2 — src/controllers/adminController.js
 * Tela de admin (`public/admin.html`) pra cadastrar contratante novo
 * sem abrir o Supabase na mão. Protegido por UMA chave mestra
 * (`CHECKOUT_ADMIN_USER` + `CHECKOUT_ADMIN_PASS_HASH`) — ver `verificarAdminKey` abaixo,
 * aplicado a toda rota de `/api/admin` em `adminRoutes.js`.
 *
 * A tela em si é acessada por um "atalho escondido" no formulário
 * público do checkout (digitar o e-mail admin@sancocore.com.br no
 * campo de e-mail redireciona pra admin.html — ver `public/js/app.js`,
 * `ligarAtalhoAdmin`). Isso só esconde o CAMINHO da tela — quem chegar
 * nela sem saber usuário+senha não consegue listar nem criar nada,
 * porque as duas coisas são sempre validadas aqui, no backend.
 */

import { randomBytes } from 'node:crypto';
import { supabase } from '../config/supabase.js';
import { compararSeguro, documentoValido, emailValido, cepValido } from '../utils/validadores.js';
import { senhaConfere } from '../utils/senhaAdmin.js';
import { responderErro } from '../utils/erros.js';
import { criarSubconta as criarSubcontaNaAsaas } from '../services/asaasService.js';
import { METODOS_VALIDOS } from '../services/pedidoService.js';

/** Aplicado a toda rota de /api/admin — um guard só, não um por handler. */
export function verificarAdminKey(requisicao, resposta, proximo) {
  const { CHECKOUT_ADMIN_USER, CHECKOUT_ADMIN_PASS_HASH } = process.env;
  if (!CHECKOUT_ADMIN_USER || !CHECKOUT_ADMIN_PASS_HASH) {
    return resposta.status(503).json({ erro: 'CHECKOUT_ADMIN_USER/CHECKOUT_ADMIN_PASS_HASH não configurados — admin desativado.' });
  }

  // As duas checagens rodam SEMPRE, mesmo com o usuário errado: sair
  // cedo quando o usuário não bate faria a resposta voltar rápido e
  // entregaria, por tempo, se o nome de usuário existe.
  const usuarioOk = compararSeguro(requisicao.get('X-Admin-User'), CHECKOUT_ADMIN_USER);
  const senhaOk = senhaConfere(requisicao.get('X-Admin-Pass'), CHECKOUT_ADMIN_PASS_HASH);
  if (!usuarioOk || !senhaOk) {
    return resposta.status(401).json({ erro: 'Usuário ou senha de admin inválidos.' });
  }
  proximo();
}

export async function listarContratantes(_requisicao, resposta) {
  const { data, error } = await supabase
    .from('contratantes')
    .select('id, nome, api_base_url, api_key, webhook_url, wallet_id, metodos_habilitados, criado_em')
    .order('criado_em', { ascending: false });

  if (error) return responderErro(resposta, error, 'admin.listarContratantes');
  resposta.json(data);
}

function slugValido(valor) {
  return /^[a-z0-9][a-z0-9-]{1,49}$/.test(String(valor ?? ''));
}

function urlValida(valor) {
  try {
    new URL(valor);
    return true;
  } catch {
    return false;
  }
}

/** undefined = não mexe (usado no PATCH); lista inválida = null (rejeita). */
function metodosHabilitadosValidos(valor) {
  if (valor === undefined) return undefined;
  if (!Array.isArray(valor) || valor.length === 0) return null;
  return valor.every((m) => METODOS_VALIDOS.includes(m)) ? valor : null;
}

export async function criarContratante(requisicao, resposta) {
  const { id, nome, apiBaseUrl, webhookUrl, walletId, metodosHabilitados } = requisicao.body ?? {};

  if (!slugValido(id)) {
    return resposta.status(400).json({ erro: 'id inválido — use um slug (letras minúsculas, números, hífen), ex.: "trimundi9".' });
  }
  if (!nome) return resposta.status(400).json({ erro: 'nome é obrigatório.' });
  if (!urlValida(apiBaseUrl)) return resposta.status(400).json({ erro: 'apiBaseUrl precisa ser uma URL válida.' });
  if (webhookUrl && !urlValida(webhookUrl)) return resposta.status(400).json({ erro: 'webhookUrl precisa ser uma URL válida.' });

  const metodos = metodosHabilitados === undefined ? METODOS_VALIDOS : metodosHabilitadosValidos(metodosHabilitados);
  if (metodos === null) return resposta.status(400).json({ erro: `metodosHabilitados precisa ser uma lista não-vazia com valores entre: ${METODOS_VALIDOS.join(', ')}.` });

  // Sempre gerada aqui, nunca aceita do body — evita chave fraca ou
  // reaproveitada entre projetos.
  const apiKey = randomBytes(24).toString('hex');

  const { data, error } = await supabase
    .from('contratantes')
    .insert({
      id,
      nome,
      api_base_url: apiBaseUrl,
      api_key: apiKey,
      webhook_url: webhookUrl || null,
      wallet_id: walletId || null,
      metodos_habilitados: metodos
    })
    .select('id, nome, api_base_url, api_key, webhook_url, wallet_id, metodos_habilitados, criado_em')
    .single();

  if (error) {
    if (error.code === '23505') return resposta.status(409).json({ erro: `Já existe um contratante com id "${id}".` });
    return responderErro(resposta, error, 'admin.criarContratante');
  }

  resposta.status(201).json(data);
}

/**
 * PATCH /api/admin/contratantes/:id — edita um contratante já
 * cadastrado. Todo campo é opcional (só atualiza o que vier no body);
 * `id` e `api_key` nunca mudam por aqui (api_key é o segredo que o
 * contratante já usa pra chamar /estornar — trocar quebraria a
 * integração dele sem aviso).
 */
export async function atualizarContratante(requisicao, resposta) {
  const { id } = requisicao.params;
  const { nome, apiBaseUrl, webhookUrl, walletId, metodosHabilitados } = requisicao.body ?? {};

  if (apiBaseUrl !== undefined && !urlValida(apiBaseUrl)) {
    return resposta.status(400).json({ erro: 'apiBaseUrl precisa ser uma URL válida.' });
  }
  if (webhookUrl && !urlValida(webhookUrl)) return resposta.status(400).json({ erro: 'webhookUrl precisa ser uma URL válida.' });

  const metodos = metodosHabilitadosValidos(metodosHabilitados);
  if (metodos === null) return resposta.status(400).json({ erro: `metodosHabilitados precisa ser uma lista não-vazia com valores entre: ${METODOS_VALIDOS.join(', ')}.` });

  const patch = {};
  if (nome !== undefined) patch.nome = nome;
  if (apiBaseUrl !== undefined) patch.api_base_url = apiBaseUrl;
  if (webhookUrl !== undefined) patch.webhook_url = webhookUrl || null;
  if (walletId !== undefined) patch.wallet_id = walletId || null;
  if (metodos !== undefined) patch.metodos_habilitados = metodos;

  if (Object.keys(patch).length === 0) return resposta.status(400).json({ erro: 'Nenhum campo pra atualizar.' });

  const { data, error } = await supabase
    .from('contratantes')
    .update(patch)
    .eq('id', id)
    .select('id, nome, api_base_url, api_key, webhook_url, wallet_id, metodos_habilitados, criado_em')
    .maybeSingle();

  if (error) return responderErro(resposta, error, 'admin.atualizarContratante');
  if (!data) return resposta.status(404).json({ erro: 'Contratante não encontrado.' });

  resposta.json(data);
}

/**
 * GET /api/admin/metricas — a saúde do checkout em números.
 *
 * A métrica que mais diz sobre um checkout brasileiro é **quantos Pix
 * gerados viram Pix pagos**. Antes disso não existia: qualquer decisão
 * sobre o checkout (inclusive quais melhorias priorizar) era chute.
 *
 * ponytail: sai tudo de `cobrancas`, que já registra criação e status —
 * sem tabela nova, sem serviço de BI, sem evento extra em toda página.
 *
 * O que NÃO é medido, de propósito: quem abriu o checkout e saiu sem
 * gerar cobrança nenhuma. Isso exigiria gravar uma linha por abertura
 * de página (e lidar com bot e recarregamento). A taxa de pagamento
 * abaixo já responde a pergunta principal — se e quando isso virar
 * insuficiente, aí vale a tabela.
 */
export async function obterMetricas(requisicao, resposta) {
  const dias = Math.min(Number(requisicao.query.dias) || 30, 365);
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('cobrancas')
    .select('contratante_id, metodo_pagamento, status, valor_cobrado, criado_em')
    .gte('criado_em', desde);

  if (error) return responderErro(resposta, error, 'admin.obterMetricas');

  const CONFIRMADOS = ['confirmado'];
  // Cobrança que ainda pode virar pagamento não conta como perdida —
  // senão a taxa de hoje sempre pareceria péssima.
  const EM_ABERTO = ['pendente', 'em_analise'];

  const vazio = () => ({ geradas: 0, pagas: 0, emAberto: 0, perdidas: 0, valorPago: 0 });
  const porMetodo = {};
  const porContratante = {};
  const total = vazio();

  for (const c of data ?? []) {
    const metodo = c.metodo_pagamento ?? 'desconhecido';
    const contratante = c.contratante_id ?? 'sem contratante';
    porMetodo[metodo] ??= vazio();
    porContratante[contratante] ??= vazio();

    const paga = CONFIRMADOS.includes(c.status);
    const aberta = EM_ABERTO.includes(c.status);

    for (const alvo of [total, porMetodo[metodo], porContratante[contratante]]) {
      alvo.geradas += 1;
      if (paga) { alvo.pagas += 1; alvo.valorPago += Number(c.valor_cobrado ?? 0); }
      else if (aberta) alvo.emAberto += 1;
      else alvo.perdidas += 1;
    }
  }

  /** Taxa sobre o que já se RESOLVEU (pagas + perdidas). Incluir o que
   *  ainda está em aberto no denominador faria a taxa parecer pior só
   *  porque a cobrança é recente. */
  const comTaxa = (n) => {
    const resolvidas = n.pagas + n.perdidas;
    return {
      ...n,
      valorPago: Math.round(n.valorPago * 100) / 100,
      taxaPagamento: resolvidas > 0 ? Math.round((n.pagas / resolvidas) * 1000) / 10 : null
    };
  };

  const mapear = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, comTaxa(v)]));

  resposta.json({
    periodoDias: dias,
    desde,
    total: comTaxa(total),
    porMetodo: mapear(porMetodo),
    porContratante: mapear(porContratante)
  });
}

// --- Subcontas Asaas ---------------------------------------------------
// Tela separada do cadastro de contratante (ver INTEGRACAO.md/status-
// atual.md): cria a conta na Asaas via API (POST /v3/accounts) em vez
// de exigir que o operador crie na mão pelo site da Asaas. O wallet_id
// gerado aqui ainda precisa ser colado manualmente no contratante
// certo — nunca ligado automaticamente entre as duas tabelas.

export async function listarSubcontas(_requisicao, resposta) {
  const { data, error } = await supabase
    .from('subcontas')
    .select('*')
    .order('criado_em', { ascending: false });

  if (error) return responderErro(resposta, error, 'admin.listarSubcontas');
  resposta.json(data);
}

export async function criarSubconta(requisicao, resposta) {
  const corpo = requisicao.body ?? {};
  const documentoDigitos = String(corpo.documento ?? '').replace(/\D/g, '');
  const cepDigitos = String(corpo.cep ?? '').replace(/\D/g, '');
  const faturamento = Number(corpo.faturamento);
  const ehPessoaFisica = documentoDigitos.length === 11;

  if (!corpo.nome) return resposta.status(400).json({ erro: 'nome é obrigatório.' });
  if (!emailValido(corpo.email)) return resposta.status(400).json({ erro: 'email inválido.' });
  if (!documentoValido(documentoDigitos)) return resposta.status(400).json({ erro: 'documento (CPF ou CNPJ) inválido.' });
  if (!corpo.endereco || !corpo.enderecoNumero || !corpo.bairro) {
    return resposta.status(400).json({ erro: 'endereço, número e bairro são obrigatórios (exigência antifraude da Asaas).' });
  }
  if (!cepValido(cepDigitos)) return resposta.status(400).json({ erro: 'cep inválido.' });
  if (!Number.isFinite(faturamento) || faturamento <= 0) return resposta.status(400).json({ erro: 'faturamento inválido.' });
  if (ehPessoaFisica && !corpo.dataNascimento) return resposta.status(400).json({ erro: 'dataNascimento é obrigatória pra subconta pessoa física.' });
  if (!ehPessoaFisica && !corpo.tipoEmpresa) return resposta.status(400).json({ erro: 'tipoEmpresa é obrigatório pra subconta pessoa jurídica.' });

  let criada;
  try {
    criada = await criarSubcontaNaAsaas({
      nome: corpo.nome,
      email: corpo.email,
      documentoDigitos,
      telefone: corpo.telefone,
      celular: corpo.celular,
      endereco: corpo.endereco,
      enderecoNumero: corpo.enderecoNumero,
      complemento: corpo.complemento,
      bairro: corpo.bairro,
      cepDigitos,
      faturamento,
      tipoEmpresa: corpo.tipoEmpresa,
      dataNascimento: corpo.dataNascimento
    });
  } catch (erroAsaas) {
    return resposta.status(erroAsaas.status && erroAsaas.status < 500 ? 400 : 502).json({ erro: `Asaas recusou a criação da subconta: ${erroAsaas.message}` });
  }

  const { data, error } = await supabase
    .from('subcontas')
    .insert({
      asaas_account_id: criada.asaasAccountId,
      nome: corpo.nome,
      email: corpo.email,
      documento: documentoDigitos,
      telefone: corpo.telefone || null,
      celular: corpo.celular || null,
      endereco: corpo.endereco,
      endereco_numero: corpo.enderecoNumero,
      complemento: corpo.complemento || null,
      bairro: corpo.bairro,
      cep: cepDigitos,
      faturamento,
      tipo_empresa: ehPessoaFisica ? null : corpo.tipoEmpresa,
      data_nascimento: ehPessoaFisica ? corpo.dataNascimento : null,
      wallet_id: criada.walletId,
      api_key: criada.apiKey
    })
    .select('*')
    .single();

  if (error) {
    // A subconta já existe na Asaas nesse ponto — só o INSERT local
    // falhou. Loga os dados devolvidos pra não se perderem: sem isso,
    // o operador teria que recriar a subconta na Asaas à toa.
    console.error('[admin.criarSubconta] Supabase falhou DEPOIS da Asaas já ter criado a subconta — dados pra recuperar manualmente:', criada);
    return responderErro(resposta, error, 'admin.criarSubconta');
  }

  resposta.status(201).json(data);
}

/** A Asaas só manda o link de ativação por e-mail, nunca na resposta
 *  da API — este endpoint só existe pra colar esse link manualmente
 *  depois que o operador recebe o e-mail. */
export async function atualizarLinkAtivacaoSubconta(requisicao, resposta) {
  const { linkAtivacao } = requisicao.body ?? {};
  if (!linkAtivacao) return resposta.status(400).json({ erro: 'linkAtivacao é obrigatório.' });

  const { data, error } = await supabase
    .from('subcontas')
    .update({ link_ativacao: linkAtivacao })
    .eq('id', requisicao.params.id)
    .select('*')
    .single();

  if (error) return responderErro(resposta, error, 'admin.atualizarLinkAtivacaoSubconta');
  if (!data) return resposta.status(404).json({ erro: 'Subconta não encontrada.' });
  resposta.json(data);
}
