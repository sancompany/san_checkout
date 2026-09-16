/**
 * src/middlewares/limitadores.js
 * Os dois tetos de rate limit do projeto, num lugar só — server.js monta
 * a maioria por PREFIXO de caminho; pix e boleto montam por ROTA
 * (checkoutRoutes.js), porque o prefixo `/api/checkout/pix` também casa
 * com `/api/checkout/pix/status/...` (polling do comprador a cada 3s),
 * e não dá pra excluir um sub-caminho de um `app.use()` por prefixo.
 *
 * As DUAS são fábrica, nunca uma instância só reaproveitada em vários
 * `app.use()`/`router.post()` — cada `rateLimit(...)` guarda o contador
 * na store por IP (não por caminho de montagem); a MESMA instância em
 * vários lugares diferentes soma TODAS as chamadas no mesmo balde. Foi
 * assim que `criarLimitadorConsulta` nasceu fábrica (achado testando
 * Cartão) — e o `limitadorCriacao` caiu no MESMO bug depois, silencioso,
 * porque ele continuou sendo uma instância só montada em sete rotas
 * (cartão, assinatura, assinatura-pix, estornar, cancelar/pausar/
 * retomar-assinatura): um IP que cria alguns checkouts já consumia
 * crédito do mesmo balde que cancelar/pausar/retomar usam, e vice-versa.
 * Achado em 16/09/2026, numa varredura de achados graves.
 */
import rateLimit from 'express-rate-limit';

export function criarLimitadorCriacao() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: 'Muitas tentativas em pouco tempo. Aguarde um minuto.' }
  });
}

export function criarLimitadorConsulta() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: 'Muitas requisições em pouco tempo. Aguarde um minuto.' }
  });
}
