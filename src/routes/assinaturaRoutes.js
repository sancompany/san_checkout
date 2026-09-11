import { Router } from 'express';
import {
  cancelarAssinatura,
  pausarAssinatura,
  retomarAssinatura
} from '../controllers/assinaturaController.js';
import { consultarAssinatura } from '../controllers/cobrancaConsultaController.js';

const router = Router();
router.post('/cancelar-assinatura', cancelarAssinatura);

// Pausar não é cancelar: cancelar é definitivo e obriga o assinante a
// assinar tudo de novo. Pausado, o mesmo vínculo volta a cobrar.
router.post('/pausar-assinatura', pausarAssinatura);
router.post('/retomar-assinatura', retomarAssinatura);

// Conciliação de recorrência — a rota GET /cobranca só acha pedido
// avulso (busca por pedido_id), então assinatura ficava sem rede de
// segurança quando a notificação se perdia. Mora aqui, com as outras
// três, porque usa a mesma autenticação e o mesmo body.
router.post('/consultar-assinatura', consultarAssinatura);

export default router;
