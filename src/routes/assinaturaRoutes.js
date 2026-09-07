import { Router } from 'express';
import { cancelarAssinatura } from '../controllers/assinaturaController.js';

const router = Router();
router.post('/cancelar-assinatura', cancelarAssinatura);

export default router;
