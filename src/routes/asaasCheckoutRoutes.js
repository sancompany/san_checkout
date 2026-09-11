import { Router } from 'express';
import {
  criarCheckoutCartao,
  criarCheckoutAssinatura,
  criarAssinaturaPixAutomatico,
  consultarStatusCheckout
} from '../controllers/asaasCheckoutController.js';

const router = Router();
router.post('/cartao/:contratanteId/:pedidoId', criarCheckoutCartao);
// Boleto não usa mais o Asaas Checkout — ver checkoutRoutes.js
// (cobrança direta, mesmo modelo do Pix).
router.post('/assinatura/:contratanteId/:planoId', criarCheckoutAssinatura);

// Assinatura por Pix Automático — recorrência SEM cartão. Um QR lido no
// app do banco paga a primeira cobrança e autoriza as próximas.
router.post('/assinatura-pix/:contratanteId/:planoId', criarAssinaturaPixAutomatico);

router.get('/asaas-checkout/status/:asaasCheckoutId', consultarStatusCheckout);

export default router;
