import { roteador } from '../utils/rotaSegura.js';
import { estornar } from '../controllers/refundController.js';

const router = roteador();
router.post('/estornar', estornar);

export default router;
