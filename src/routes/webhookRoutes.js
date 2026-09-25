import { roteador } from '../utils/rotaSegura.js';
import { receberWebhookAsaas, verificarWebhookAsaas } from '../controllers/webhookController.js';

const router = roteador();
router.post('/asaas', verificarWebhookAsaas, receberWebhookAsaas);

export default router;
