/**
 * SAN CHECKOUT v2 — src/utils/erros.js
 * Um erro com `.status` já definido veio de validação nossa
 * (validadores.js, pedidoService.js) ou da Asaas (`asaasService.js`
 * já usa a descrição que a própria Asaas manda pro usuário final,
 * pensada pra ser mostrada) — mensagem já é segura de devolver.
 * Sem `.status` é erro inesperado (Supabase, rede, bug) — nunca
 * expõe a mensagem crua pro cliente (pode vazar detalhe de schema/
 * infra), só loga no servidor e devolve algo genérico.
 */
export function responderErro(resposta, erro, contexto, statusPadrao = 502) {
  console.error(`[${contexto}]`, erro.message);
  if (erro.status) {
    return resposta.status(erro.status).json({
      erro: erro.message,
      ...(erro.pedido ? { pedido: erro.pedido } : {})
    });
  }
  resposta.status(statusPadrao).json({ erro: 'Erro interno — tente novamente em instantes.' });
}
