import { Router } from 'express';
import { verificarAdminKey, listarContratantes, criarContratante } from '../controllers/adminController.js';

const router = Router();
router.use(verificarAdminKey);
router.get('/contratantes', listarContratantes);
router.post('/contratantes', criarContratante);

export default router;
