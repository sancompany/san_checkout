import { Router } from 'express';
import { gerarPix, statusPix, gerarBoleto, statusBoleto } from '../controllers/checkoutController.js';

const router = Router();
router.post('/pix/:contratanteId/:pedidoId', gerarPix);
router.get('/pix/status/:chargeId', statusPix);
router.post('/boleto/:contratanteId/:pedidoId', gerarBoleto);
router.get('/boleto/status/:chargeId', statusBoleto);

export default router;
