import { Router } from 'express';
import {
  verificarAdminKey,
  listarContratantes,
  criarContratante,
  atualizarContratante,
  listarSubcontas,
  criarSubconta,
  atualizarLinkAtivacaoSubconta,
  obterMetricas,
  arquivarContratante,
  arquivarSubconta,
  listarAuditoriaWebhook,
  obterResumoWebhook
} from '../controllers/adminController.js';

const router = Router();
router.use(verificarAdminKey);
router.get('/contratantes', listarContratantes);
router.post('/contratantes', criarContratante);
router.patch('/contratantes/:id', atualizarContratante);
router.patch('/contratantes/:id/arquivar', arquivarContratante);
router.get('/subcontas', listarSubcontas);
router.post('/subcontas', criarSubconta);
router.patch('/subcontas/:id', atualizarLinkAtivacaoSubconta);
router.patch('/subcontas/:id/arquivar', arquivarSubconta);
router.get('/metricas', obterMetricas);
router.get('/webhook/eventos', listarAuditoriaWebhook);
router.get('/webhook/resumo', obterResumoWebhook);

export default router;
