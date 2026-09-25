import { roteador } from '../utils/rotaSegura.js';
import { exigirParametrosCanonicos } from '../middlewares/idsCanonicos.js';
import { obterPedido } from '../controllers/pedidoController.js';

// Todo `:id` de rota passa pelo contrato canônico antes de qualquer handler
// (SEC-001, `middlewares/idsCanonicos.js`).
const router = exigirParametrosCanonicos(roteador());
router.get('/pedido/:contratanteId/:pedidoId', obterPedido);

export default router;
