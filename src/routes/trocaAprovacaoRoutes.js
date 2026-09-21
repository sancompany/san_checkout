import { Router } from 'express';
import { trocaContexto, trocaAprovar } from '../controllers/trocaAprovacaoController.js';
import { criarLimitadorCriacao, criarLimitadorConsulta } from '../middlewares/limitadores.js';

const router = Router();

// Limitador por ROTA, não por prefixo — mesmo motivo de
// `checkoutRoutes.js` (pix/boleto): um `app.use('/api/checkout/troca', ...)`
// por prefixo em server.js casaria as duas rotas com o mesmo teto, e
// elas têm naturezas diferentes (consulta × efeito financeiro).
//
// Instância NOVA em cada uma — a mesma instância nas duas somaria o
// contador das duas no mesmo balde (lição nº 25, `limitadores.js`).
router.post('/troca/contexto', criarLimitadorConsulta(), trocaContexto);
router.post('/troca/aprovar', criarLimitadorCriacao(), trocaAprovar);

export default router;
