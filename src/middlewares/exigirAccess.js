/**
 * SAN CHECKOUT v2 — src/middlewares/exigirAccess.js
 *
 * A primeira camada da área administrativa, exigida NA ORIGEM (SEC-015,
 * 25/09/2026): toda rota de `/api/admin` — inclusive a de login — só
 * responde a quem chegou pelo Cloudflare Access. Quem prova isso é o JWT
 * que o Access põe na requisição (`Cf-Access-Jwt-Assertion`, conferido em
 * `utils/accessJwt.js`). Sem ele, a chamada pelo domínio da API ou pela
 * origem da Northflank recebe 401 antes de chegar à senha — o login
 * próprio continua existindo por trás, como a segunda camada.
 *
 * Não existe desligamento. Um interruptor aqui seria exatamente a porta
 * que a lei manda não deixar: configuração que alguém esquece ligada.
 * Pelo mesmo motivo o `aud` e a equipe não vêm do ambiente, e a URL das
 * chaves só aceita troca para o servidor LOCAL das suítes
 * (`tests/access-de-teste.js`): apontada para o loopback em produção, não
 * há nada escutando ali — dá 503, nunca acesso.
 *
 * Por que 503 quando as chaves não vêm: "não consegui conferir" nunca é
 * "passa" — e também não é "você não pode", que mandaria o operador
 * procurar um erro de senha que não existe.
 */

import { verificarJwtDoAccess, criarBuscadorDeChaves, decodificarJwt, EQUIPE_ACCESS, AUD_DO_PAINEL } from '../utils/accessJwt.js';

const RECUSA = { erro: 'O painel administrativo só abre pelo endereço protegido (checkout.sancocore.com.br/admin).', acessoRestrito: true };

/** A URL das chaves da equipe — ou a do servidor local das suítes, e só ela. */
function urlDasChaves() {
  const daEquipe = `${EQUIPE_ACCESS}/cdn-cgi/access/certs`;
  const doAmbiente = process.env.CF_ACCESS_CERTS_URL;
  if (!doAmbiente) return daEquipe;
  const u = new URL(doAmbiente);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) {
    throw new Error('CF_ACCESS_CERTS_URL só aceita o servidor local das suítes');
  }
  return doAmbiente;
}

export function criarExigirAccess({ buscarChaves = null, verificar = verificarJwtDoAccess } = {}) {
  let buscador = buscarChaves;
  return async function exigirAccess(requisicao, resposta, proximo) {
    const token = requisicao.get('Cf-Access-Jwt-Assertion');
    if (!token) return resposta.status(401).json(RECUSA);

    let jwks;
    try {
      buscador ??= criarBuscadorDeChaves({ url: urlDasChaves() });
      jwks = await buscador(decodificarJwt(token)?.cabecalho?.kid);
    } catch (erro) {
      console.error('[admin/access] não consegui ler as chaves do Access:', erro.message);
      return resposta.status(503).json({ erro: 'Não foi possível conferir o acesso administrativo agora. Tente de novo em instantes.' });
    }

    /* Fecha em vez de lançar: qualquer exceção ao julgar o token (que é
       texto de quem chamou) é recusa, nunca 500 nem processo no chão
       (C1-01). */
    let veredito;
    try {
      veredito = verificar(token, { jwks, aud: AUD_DO_PAINEL, equipe: EQUIPE_ACCESS });
    } catch {
      veredito = { valido: false, motivo: 'exceção ao conferir' };
    }
    if (!veredito.valido) {
      // O motivo vai para o log; quem chamou recebe a mesma recusa de sempre.
      console.warn(`[admin/access] JWT recusado (${veredito.motivo}) em ${requisicao.method} ${requisicao.baseUrl}${requisicao.path}`);
      return resposta.status(401).json(RECUSA);
    }
    requisicao.operadorDoAccess = veredito.email;
    proximo();
  };
}

export const exigirAccess = criarExigirAccess();
