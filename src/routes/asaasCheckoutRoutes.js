import { Router } from 'express';
import { criarCheckoutCartao, criarCheckoutAssinatura, consultarStatusCheckout } from '../controllers/asaasCheckoutController.js';

const router = Router();
router.post('/cartao/:contratanteId/:pedidoId', criarCheckoutCartao);
// Boleto não usa mais o Asaas Checkout — ver checkoutRoutes.js
// (cobrança direta, mesmo modelo do Pix).
router.post('/assinatura/:contratanteId/:planoId', criarCheckoutAssinatura);
router.get('/asaas-checkout/status/:asaasCheckoutId', consultarStatusCheckout);

export default router;
