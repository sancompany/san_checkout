import { Router } from 'express';
import { exigirParametrosCanonicos } from '../middlewares/idsCanonicos.js';
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
  listarErrosCapturados,
  listarFilaInbox,
  reenfileirarInbox,
  listarFilaOutbox,
  reenviarOutbox,
  obterResumoFilas
} from '../controllers/adminController.js';

// Todo `:id` de rota passa pelo contrato canônico antes de qualquer handler
// (SEC-001, `middlewares/idsCanonicos.js`).
const router = exigirParametrosCanonicos(Router());

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
/* As filas (M-07, 24/09/2026): ver e reenviar pelo MESMO id — o reenvio
   nunca cria um evento novo, só volta a linha para a fila. */
router.get('/filas/resumo', obterResumoFilas);
router.get('/filas/inbox', listarFilaInbox);
router.post('/filas/inbox/:id/reenfileirar', reenfileirarInbox);
router.get('/filas/outbox', listarFilaOutbox);
router.post('/filas/outbox/:id/reenviar', reenviarOutbox);

export default router;
