import { Router } from 'express';
import { gerarPix, statusPix, gerarBoleto, statusBoleto } from '../controllers/checkoutController.js';
import { statusPublico, consultarCobranca } from '../controllers/cobrancaConsultaController.js';

const router = Router();
router.post('/pix/:contratanteId/:pedidoId', gerarPix);
router.get('/pix/status/:chargeId', statusPix);
router.post('/boleto/:contratanteId/:pedidoId', gerarBoleto);
router.get('/boleto/status/:chargeId', statusBoleto);

// Pro COMPRADOR — pública, alimenta public/status.html (segunda via de
// Pix/boleto pra quem fechou a aba). Sem dado pessoal na resposta.
router.get('/status/:contratanteId/:pedidoId', statusPublico);

// Pro CONTRATANTE — autenticada por X-Checkout-Key. Rede de segurança
// pra quando o webhook se perder (INTEGRACAO.md seção 4.5).
router.get('/cobranca/:contratanteId/:pedidoId', consultarCobranca);

export default router;
