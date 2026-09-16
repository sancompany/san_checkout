/**
 * SAN CHECKOUT — src/utils/tokenRenovacao.js
 *
 * Prova de que quem está pedindo pra "renovar" uma assinatura (trocar
 * o cartão, `API.md` §7.3) é o mesmo contratante que mandou o link — e,
 * por extensão, que o link chegou pelo canal que ele escolheu (o dele
 * com o assinante), não por quem só descobriu o CPF/CNPJ da vítima.
 *
 * Achado em 16/09/2026, numa varredura de achados graves:
 * `POST /api/checkout/assinatura/:contratanteId/:planoId` é pública, e
 * até esta correção o `renovar=1` bastava sozinho — bastava saber o
 * `documento` de um assinante ativo (não é segredo: pode vir de
 * vazamento, de rede social, de "chutar" um CPF válido de alguém
 * específico) pra criar uma assinatura nova com o PRÓPRIO cartão e, ao
 * pagá-la, cancelar a assinatura de VERDADE da vítima na Asaas
 * (`encerrarAssinaturaSubstituida`, webhookController.js) — um
 * sequestro/cancelamento cross-pagador pelo caminho de dinheiro, sem
 * cruzar credencial nenhuma. Violava diretamente o `API.md` §5.5:
 * "Cancelamento: só o projeto aciona — o pagador nunca cancela direto
 * no checkout".
 *
 * O esquema segue o mesmo raciocínio de `assinaturaWebhook.js` (o
 * webhook que ESTE projeto assina pro contratante): HMAC com a
 * `api_key` como segredo, que só o contratante e o San Checkout têm —
 * então só quem tem a `api_key` consegue gerar um token que passa.
 * O CONTRATANTE gera o token (com a própria `api_key`, sem precisar
 * pedir nada a ninguém) na hora de montar o link de renovação pra um
 * assinante específico, e manda esse link pelo canal que ele escolher
 * (o mesmo já documentado: "ao receber `cobranca_falhou`, mande o link
 * `&renovar=1`" — agora com o token embutido).
 *
 * Sem expiração de janela curta (diferente do webhook, que é síncrono):
 * este link pode ficar dias na caixa de entrada do assinante antes de
 * ele clicar. Uma semana é folgado sem ficar eterno.
 */

import { createHmac } from 'node:crypto';
import { compararSeguro } from './validadores.js';

export const JANELA_TOKEN_RENOVACAO_SEGUNDOS = 7 * 24 * 60 * 60; // 7 dias

function hmacDoToken(apiKey, { contratanteId, planoId, documento }, timestamp) {
  return createHmac('sha256', apiKey)
    .update(`${timestamp}.${contratanteId}.${planoId}.${documento}`)
    .digest('hex');
}

/**
 * Gera o token — chamado pelo CONTRATANTE, do lado dele, com a própria
 * `api_key`. Documentado no `API.md` §7.3 com exemplo de código, do
 * mesmo jeito que a verificação de webhook já é.
 *
 * @param {string} apiKey — a `api_key` do contratante
 * @param {{contratanteId: string, planoId: string, documento: string}} escopo
 * @returns {string} token opaco pra ir no `renovar=` do link
 */
export function gerarTokenRenovacao(apiKey, { contratanteId, planoId, documento }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const hmac = hmacDoToken(apiKey, { contratanteId, planoId, documento }, timestamp);
  return `${timestamp}.${hmac}`;
}

/**
 * Confere o token recebido em `renovar=`. `false` pra qualquer coisa
 * que não seja um token válido e dentro da janela — inclusive
 * `renovar=1` (o formato antigo, sem token), que passa a ser tratado
 * como "não é renovação": cria uma assinatura nova sem amarrar nem
 * cancelar nenhuma outra, em vez de confiar num `documento` não
 * autenticado. Falhar assim (degradar pra "assinatura nova comum") é
 * seguro; falhar abrindo é o buraco que esta função existe pra fechar.
 */
export function tokenRenovacaoValido(token, apiKey, { contratanteId, planoId, documento }) {
  if (typeof token !== 'string' || !apiKey) return false;

  const ponto = token.indexOf('.');
  if (ponto === -1) return false;

  const timestampBruto = token.slice(0, ponto);
  const timestamp = Number(timestampBruto);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > JANELA_TOKEN_RENOVACAO_SEGUNDOS) return false;

  const esperado = `${timestampBruto}.${hmacDoToken(apiKey, { contratanteId, planoId, documento }, timestampBruto)}`;
  return compararSeguro(esperado, token);
}

/* ------------------------------------------------------------------
   Autoteste — `node src/utils/tokenRenovacao.js`
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('tokenRenovacao.js')) {
  const { strict: assert } = await import('node:assert');

  const apiKey = 'chave-do-contratante';
  const escopo = { contratanteId: 'loja1', planoId: 'plano-vip', documento: '11144477735' };

  const token = gerarTokenRenovacao(apiKey, escopo);
  assert.ok(tokenRenovacaoValido(token, apiKey, escopo), 'token gerado pelo dono da api_key vale pro mesmo escopo');

  // O ATAQUE PRINCIPAL: atacante sabe o `documento` da vítima (não é
  // segredo) mas não tem a `api_key` do contratante — não consegue
  // forjar um token que passe.
  assert.ok(!tokenRenovacaoValido(token, 'chave-errada', escopo), 'sem a api_key certa, não forja');
  assert.ok(!tokenRenovacaoValido('renovar=1-no-estilo-antigo', apiKey, escopo), 'formato antigo (sem token) não vale mais');
  assert.ok(!tokenRenovacaoValido('', apiKey, escopo), 'vazio não vale');
  assert.ok(!tokenRenovacaoValido(null, apiKey, escopo), 'nulo não vale');
  assert.ok(!tokenRenovacaoValido(undefined, apiKey, escopo), 'undefined não vale');

  // Token de UM assinante não serve pra "renovar" outro — nem trocando
  // só o documento, nem o plano, nem o contratante.
  assert.ok(!tokenRenovacaoValido(token, apiKey, { ...escopo, documento: '52998224725' }), 'não serve pra outro documento');
  assert.ok(!tokenRenovacaoValido(token, apiKey, { ...escopo, planoId: 'outro-plano' }), 'não serve pra outro plano');
  assert.ok(!tokenRenovacaoValido(token, apiKey, { ...escopo, contratanteId: 'loja2' }), 'não serve pra outro contratante');

  // Token maquiado (hmac trocado, mas timestamp válido) é recusado.
  const [ts] = token.split('.');
  assert.ok(!tokenRenovacaoValido(`${ts}.0000000000000000000000000000000000000000000000000000000000000000`, apiKey, escopo), 'hmac adulterado é recusado');

  // Fora da janela de 7 dias, mesmo com o hmac certo pro timestamp velho.
  const tsVelho = Math.floor(Date.now() / 1000) - JANELA_TOKEN_RENOVACAO_SEGUNDOS - 1;
  const tokenVelho = `${tsVelho}.${hmacDoToken(apiKey, escopo, tsVelho)}`;
  assert.ok(!tokenRenovacaoValido(tokenVelho, apiKey, escopo), 'token expirado é recusado mesmo com hmac certo');

  console.log('tokenRenovacao: 10 checagens OK');
}
