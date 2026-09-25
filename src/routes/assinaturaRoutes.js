import { roteador } from '../utils/rotaSegura.js';
import {
  cancelarAssinatura,
  pausarAssinatura,
  retomarAssinatura
} from '../controllers/assinaturaController.js';
import { consultarAssinatura } from '../controllers/cobrancaConsultaController.js';
import { trocarPlano } from '../controllers/trocaPlanoController.js';

const router = roteador();
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

// Troca de plano — upgrade/downgrade mantendo o vínculo. Mora aqui com
// as outras quatro porque usa a MESMA autenticação (X-Checkout-Key) e a
// mesma forma de localizar a assinatura (plano + documento). O acerto
// proporcional é cobrado no cartão já salvo, e o plano só muda depois de
// ele confirmar — a ordem é a regra (trocaPlanoController.js).
router.post('/trocar-plano', trocarPlano);

export default router;
