import { Router } from 'express';
import { obterPedido } from '../controllers/pedidoController.js';

const router = Router();
router.get('/pedido/:contratanteId/:pedidoId', obterPedido);

export default router;
