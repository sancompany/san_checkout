/**
 * src/middlewares/limitadores.js
 * Os dois tetos de rate limit do projeto, num lugar só — server.js monta
 * a maioria por PREFIXO de caminho; pix e boleto montam por ROTA
 * (checkoutRoutes.js), porque o prefixo `/api/checkout/pix` também casa
 * com `/api/checkout/pix/status/...` (polling do comprador a cada 3s),
 * e não dá pra excluir um sub-caminho de um `app.use()` por prefixo.
 */
import rateLimit from 'express-rate-limit';

export const limitadorCriacao = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas em pouco tempo. Aguarde um minuto.' }
});

// ponytail: fábrica em vez de uma instância só reaproveitada em várias
// rotas de consulta — cada `rateLimit(...)` guarda o contador na store
// por IP+path-de-montagem; a MESMA instância em vários app.use()
// diferentes soma todas as chamadas no mesmo balde de 60/min (bug real,
// achado testando Cartão). Uma instância por rota = 60/min CADA uma.
export function criarLimitadorConsulta() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: 'Muitas requisições em pouco tempo. Aguarde um minuto.' }
  });
}
