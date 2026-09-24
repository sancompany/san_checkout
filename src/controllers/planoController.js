/**
 * SAN CHECKOUT v2 — src/controllers/planoController.js
 * GET /api/checkout/plano/:contratanteId/:planoId
 * Devolve o plano CRU (sem wrapper) — o front (assinaturaHandler.js)
 * espera receber os campos direto, igual ao formato do API.md §4.2. O
 * que é nosso vai em `_checkout`: métodos, retorno, bloqueio e a
 * COTAÇÃO (C-02) — o retrato do valor e do ciclo que a tela mostra, e
 * que o POST /assinatura exige de volta.
 *
 * `ciclo` chega em qualquer dos três vocabulários (`utils/ciclos.js`) e
 * sai normalizado para o da Asaas — e dentro do que ESTE contratante
 * pode vender (`ciclos_permitidos`, M-10).
 */

import { resolverPlano } from '../services/pedidoService.js';
import { criarCotacao, montarTotaisPlano } from '../services/cotacaoService.js';
import { normalizarCiclo, cicloPermitido, cicloCanonico } from '../utils/ciclos.js';
import { MENSAGEM_PISO_ASAAS } from '../utils/validadores.js';
import { retornoSeguro } from '../utils/retornoSeguro.js';
import { responderErro } from '../utils/erros.js';

/** Normaliza `plano.ciclo` para a Asaas e confere contra o contratante.
 *  Devolve `{ ciclo }` ou `{ erro }` com a lista dos aceitos (lição nº 19). */
export function resolverCicloDoPlano(plano, contratante) {
  const ciclo = normalizarCiclo(plano?.ciclo);
  if (!ciclo) {
    return { erro: `Ciclo de assinatura inválido: "${plano?.ciclo ?? ''}". Aceitos: mensal, trimestral, semestral, anual (ou o nome da Asaas: MONTHLY, QUARTERLY, SEMIANNUALLY, YEARLY…).` };
  }
  const { permitido, permitidos } = cicloPermitido(ciclo, contratante);
  if (!permitido) {
    return { erro: `Este contratante não vende o ciclo "${cicloCanonico(ciclo) ?? ciclo}". Aceitos: ${permitidos.map((c) => cicloCanonico(c) ?? c).join(', ')}.` };
  }
  return { ciclo };
}

export function criarObterPlano({ resolverPlano: resolver = resolverPlano, criarCotacao: cotar = criarCotacao } = {}) {
  return async function obterPlano(requisicao, resposta) {
    const { contratanteId, planoId } = requisicao.params;

    try {
      const { contratante, plano } = await resolver(contratanteId, planoId);

      const retornoUrl = retornoSeguro(requisicao.query?.returnUrl, contratante);

      const totais = montarTotaisPlano(plano);
      const { ciclo, erro: erroCiclo } = resolverCicloDoPlano(plano, contratante);

      let bloqueio = null;
      if (totais?.abaixoDoPiso) bloqueio = { codigo: 'valor_abaixo_do_piso', mensagem: MENSAGEM_PISO_ASAAS };
      else if (erroCiclo) bloqueio = { codigo: 'ciclo_invalido', mensagem: erroCiclo };

      const planoNormalizado = { ...plano, ...(ciclo ? { ciclo } : {}) };
      const cotacao = totais && !bloqueio
        ? await cotar({ contratanteId: contratante.id, tipo: 'plano', referenciaId: planoId, origem: planoNormalizado, totais })
        : null;

      resposta.json({
        ...planoNormalizado,
        _checkout: {
          metodosHabilitados: contratante.metodos_habilitados ?? null,
          contratanteNome: contratante.nome,
          retornoUrl,
          ...(ciclo ? { cicloCanonico: cicloCanonico(ciclo) } : {}),
          ...(bloqueio ? { bloqueio } : {}),
          ...(cotacao ? { cotacao: { id: cotacao.id, expiraEm: cotacao.expiraEm, totais } } : {})
        }
      });
    } catch (erro) {
      responderErro(resposta, erro, 'planoController.obterPlano', 500);
    }
  };
}

export const obterPlano = criarObterPlano();
