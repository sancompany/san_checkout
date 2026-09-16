import { Router } from 'express';
import { gerarPix, statusPix, gerarBoleto, statusBoleto } from '../controllers/checkoutController.js';
import { statusPublico, consultarCobranca } from '../controllers/cobrancaConsultaController.js';
import { criarLimitadorCriacao, criarLimitadorConsulta } from '../middlewares/limitadores.js';

const router = Router();

// Limitador por ROTA, não por prefixo: `/pix` e `/boleto` têm uma rota
// de criação (10/min, força bruta) e uma de polling (o front reconsulta
// a cada 3s enquanto aguarda) — um `app.use('/api/checkout/pix', ...)`
// por prefixo em server.js casaria as duas com o mesmo teto de 10/min,
// e o próprio polling esgotava a janela sozinho em ~30s (achado
// varrendo o caminho de assinatura, mas o mesmo bug existia aqui desde
// sempre — Pix/Boleto usam o mesmo padrão de polling).
//
// Uma instância NOVA por rota, e não uma só reaproveitada nas duas
// criações — a mesma instância em `/pix` e `/boleto` somaria as duas no
// mesmo balde de 10/min (ver o comentário de limitadores.js).
router.post('/pix/:contratanteId/:pedidoId', criarLimitadorCriacao(), gerarPix);
router.get('/pix/status/:chargeId', criarLimitadorConsulta(), statusPix);
router.post('/boleto/:contratanteId/:pedidoId', criarLimitadorCriacao(), gerarBoleto);
router.get('/boleto/status/:chargeId', criarLimitadorConsulta(), statusBoleto);

// Pro COMPRADOR — pública, alimenta public/status.html (segunda via de
// Pix/boleto pra quem fechou a aba). Sem dado pessoal na resposta.
router.get('/status/:contratanteId/:pedidoId', statusPublico);

// Pro CONTRATANTE — autenticada por X-Checkout-Key. Rede de segurança
// pra quando o webhook se perder (API.md §5.2).
router.get('/cobranca/:contratanteId/:pedidoId', consultarCobranca);

export default router;
