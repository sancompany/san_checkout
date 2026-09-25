import { roteador } from '../utils/rotaSegura.js';
import { exigirParametrosCanonicos } from '../middlewares/idsCanonicos.js';
import { obterPlano } from '../controllers/planoController.js';

// Todo `:id` de rota passa pelo contrato canônico antes de qualquer handler
// (SEC-001, `middlewares/idsCanonicos.js`).
const router = exigirParametrosCanonicos(roteador());
router.get('/plano/:contratanteId/:planoId', obterPlano);

export default router;
