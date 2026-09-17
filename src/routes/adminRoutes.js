import { Router } from 'express';
import {
  verificarAdminKey,
  abrirSessao,
  listarContratantes,
  criarContratante,
  atualizarContratante,
  listarSubcontas,
  criarSubconta,
  atualizarLinkAtivacaoSubconta,
  obterMetricas,
  arquivarContratante,
  rotacionarChaveContratante,
  arquivarSubconta,
  listarAuditoriaWebhook,
  obterResumoWebhook,
  listarErrosCapturados
} from '../controllers/adminController.js';

const router = Router();

/* ANTES da guarda, de propósito: é a rota que troca senha por token, e
   por isso é a única que não pode exigir token. Toda rota abaixo do
   `router.use` exige. */
router.post('/sessao', abrirSessao);

router.use(verificarAdminKey);
router.get('/contratantes', listarContratantes);
router.post('/contratantes', criarContratante);
router.patch('/contratantes/:id', atualizarContratante);
router.patch('/contratantes/:id/arquivar', arquivarContratante);
/* POST, não PATCH: trocar a chave não é editar um campo que veio no
   corpo — é pedir ao servidor que gere um segredo novo. O corpo é
   vazio de propósito, para não existir caminho em que a chave venha de
   fora. */
router.post('/contratantes/:id/rotacionar-chave', rotacionarChaveContratante);
router.get('/subcontas', listarSubcontas);
router.post('/subcontas', criarSubconta);
router.patch('/subcontas/:id', atualizarLinkAtivacaoSubconta);
router.patch('/subcontas/:id/arquivar', arquivarSubconta);
router.get('/metricas', obterMetricas);
router.get('/webhook/eventos', listarAuditoriaWebhook);
router.get('/webhook/resumo', obterResumoWebhook);
router.get('/erros', listarErrosCapturados);

export default router;
