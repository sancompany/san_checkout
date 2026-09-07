/**
 * SAN CHECKOUT v2 — src/controllers/adminController.js
 * Tela de admin (`public/admin.html`) pra cadastrar contratante novo
 * sem abrir o Supabase na mão. Protegido por UMA chave mestra
 * (`CHECKOUT_ADMIN_KEY`, .env) — ver `verificarAdminKey` abaixo,
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
import { compararSeguro } from '../utils/validadores.js';
import { responderErro } from '../utils/erros.js';

/** Aplicado a toda rota de /api/admin — um guard só, não um por handler. */
export function verificarAdminKey(requisicao, resposta, proximo) {
  const { CHECKOUT_ADMIN_USER, CHECKOUT_ADMIN_PASS } = process.env;
  if (!CHECKOUT_ADMIN_USER || !CHECKOUT_ADMIN_PASS) {
    return resposta.status(503).json({ erro: 'CHECKOUT_ADMIN_USER/CHECKOUT_ADMIN_PASS não configurados no .env — admin desativado.' });
  }
  const usuarioOk = compararSeguro(requisicao.get('X-Admin-User'), CHECKOUT_ADMIN_USER);
  const senhaOk = compararSeguro(requisicao.get('X-Admin-Pass'), CHECKOUT_ADMIN_PASS);
  if (!usuarioOk || !senhaOk) {
    return resposta.status(401).json({ erro: 'Usuário ou senha de admin inválidos.' });
  }
  proximo();
}

export async function listarContratantes(_requisicao, resposta) {
  const { data, error } = await supabase
    .from('contratantes')
    .select('id, nome, api_base_url, api_key, webhook_url, wallet_id, criado_em')
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

export async function criarContratante(requisicao, resposta) {
  const { id, nome, apiBaseUrl, webhookUrl, walletId } = requisicao.body ?? {};

  if (!slugValido(id)) {
    return resposta.status(400).json({ erro: 'id inválido — use um slug (letras minúsculas, números, hífen), ex.: "trimundi9".' });
  }
  if (!nome) return resposta.status(400).json({ erro: 'nome é obrigatório.' });
  if (!urlValida(apiBaseUrl)) return resposta.status(400).json({ erro: 'apiBaseUrl precisa ser uma URL válida.' });
  if (webhookUrl && !urlValida(webhookUrl)) return resposta.status(400).json({ erro: 'webhookUrl precisa ser uma URL válida.' });

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
      wallet_id: walletId || null
    })
    .select('id, nome, api_base_url, api_key, webhook_url, wallet_id, criado_em')
    .single();

  if (error) {
    if (error.code === '23505') return resposta.status(409).json({ erro: `Já existe um contratante com id "${id}".` });
    return responderErro(resposta, error, 'admin.criarContratante');
  }

  resposta.status(201).json(data);
}
