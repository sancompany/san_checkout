import { Router } from 'express';
import { estornar } from '../controllers/refundController.js';

const router = Router();
router.post('/estornar', estornar);

export default router;
