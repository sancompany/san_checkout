/**
 * src/middlewares/idsCanonicos.js
 * Todo parâmetro de rota que é identificador passa pelo contrato canônico
 * (`utils/validadores.js`, `exigirIdCanonico`) ANTES de qualquer handler.
 *
 * A guarda de verdade mora nas funções compartilhadas (resolvedores do
 * pull, buscas de cobrança e de assinatura), e continua lá. Esta é a
 * segunda camada, e existe por um motivo que a primeira não cobre: rota
 * nova. Quem escrever amanhã um `router.get('/x/:pedidoId', ...)` que
 * leia o parâmetro e o use sem passar por aquelas funções nasce coberto,
 * desde que registre o guarda no roteiro — e `tests/identificador-canonico-em-toda-fronteira.js`
 * reprova o roteiro que declara um destes parâmetros sem registrá-lo.
 *
 * `router.param` roda antes dos handlers da rota (limitador incluso):
 * o id recusado nunca chega a tocar banco, rede nem contador.
 */
import { idCanonico, exigirIdCanonico } from '../utils/validadores.js';

/** Os nomes de parâmetro que são identificador em algum roteiro. */
export const PARAMETROS_DE_ID = ['contratanteId', 'pedidoId', 'planoId', 'chargeId', 'asaasCheckoutId', 'id'];

export function exigirParametrosCanonicos(router) {
  for (const nome of PARAMETROS_DE_ID) {
    router.param(nome, (requisicao, resposta, proximo, valor) => {
      if (idCanonico(valor)) return proximo();
      try {
        exigirIdCanonico(valor, nome);
      } catch (erro) {
        return resposta.status(400).json({ erro: erro.message });
      }
      /* Inalcançável: `idCanonico` e `exigirIdCanonico` são a mesma
         regra. Se um dia divergirem, fecha em vez de abrir. */
      return resposta.status(400).json({ erro: `O ${nome} é inválido.` });
    });
  }
  return router;
}
