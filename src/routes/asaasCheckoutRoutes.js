import { roteador } from '../utils/rotaSegura.js';
import { exigirParametrosCanonicos } from '../middlewares/idsCanonicos.js';
import {
  criarCheckoutCartao,
  criarCheckoutAssinatura,
  criarAssinaturaPixAutomatico,
  consultarStatusCheckout
} from '../controllers/asaasCheckoutController.js';

// Todo `:id` de rota passa pelo contrato canônico antes de qualquer handler
// (SEC-001, `middlewares/idsCanonicos.js`).
const router = exigirParametrosCanonicos(roteador());
router.post('/cartao/:contratanteId/:pedidoId', criarCheckoutCartao);
// Boleto não usa mais o Asaas Checkout — ver checkoutRoutes.js
// (cobrança direta, mesmo modelo do Pix).
router.post('/assinatura/:contratanteId/:planoId', criarCheckoutAssinatura);

// Assinatura por Pix Automático — recorrência SEM cartão. Um QR lido no
// app do banco paga a primeira cobrança e autoriza as próximas.
router.post('/assinatura-pix/:contratanteId/:planoId', criarAssinaturaPixAutomatico);

router.get('/asaas-checkout/status/:asaasCheckoutId', consultarStatusCheckout);

export default router;
