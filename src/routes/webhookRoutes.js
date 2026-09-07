import { Router } from 'express';
import { receberWebhookAsaas, verificarWebhookAsaas } from '../controllers/webhookController.js';

const router = Router();
router.post('/asaas', verificarWebhookAsaas, receberWebhookAsaas);

export default router;
