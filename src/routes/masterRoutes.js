import { Router } from 'express';
import { pedidoMaster } from '../controllers/masterController.js';

const router = Router();

// Na raiz de propósito — é o endpoint que o contratante `admin-master`
// "expõe", e o api_base_url dele aponta pro próprio backend. Ver a nota
// no topo de masterController.js.
router.get('/pedido/:pedidoId', pedidoMaster);

export default router;
