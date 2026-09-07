import { Router } from 'express';
import { obterPlano } from '../controllers/planoController.js';

const router = Router();
router.get('/plano/:contratanteId/:planoId', obterPlano);

export default router;
