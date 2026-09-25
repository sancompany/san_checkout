import { roteador } from '../utils/rotaSegura.js';
import { trocaContexto, trocaAprovar } from '../controllers/trocaAprovacaoController.js';
import { criarLimitadorConsulta } from '../middlewares/limitadores.js';

const router = roteador();

// Limitador por ROTA, não por prefixo — mesmo motivo de
// `checkoutRoutes.js` (pix/boleto): um `app.use('/api/checkout/troca', ...)`
// por prefixo em server.js casaria as duas rotas com o mesmo teto.
//
// As DUAS usam o limitador de CONSULTA (60/min), não o de criação —
// achado no review do PR #36 pelo Codex: `/troca/aprovar` PARECE uma
// rota de criação (é ela que dispara a cobrança), mas só na PRIMEIRA
// chamada sobre um token `PENDING_APPROVAL`; toda chamada seguinte é
// `reclassificarPendente`, que só reconsulta e NUNCA cobra de novo
// (`trocaExecucaoService.js` — protegido por CAS, não pelo rate limit).
// O front faz poll dela a cada 3s enquanto o veredito fica ambíguo
// (`public/js/troca.js`), e o teto de criação (10/min) estourava em
// ~30s — menos que o primeiro ciclo do sweeper (60s) — e o front tratava
// o 429 como erro terminal, parando de pollar mesmo que o backend
// resolvesse segundos depois. Mesmo raciocínio que já vale para o
// polling de status de pix/boleto (`checkoutRoutes.js`): consulta ×
// efeito financeiro, e o rate limit nunca foi o que protege contra
// cobrança duplicada aqui.
//
// Instância NOVA em cada uma — a mesma instância nas duas somaria o
// contador das duas no mesmo balde (lição nº 25, `limitadores.js`).
router.post('/troca/contexto', criarLimitadorConsulta(), trocaContexto);
router.post('/troca/aprovar', criarLimitadorConsulta(), trocaAprovar);

export default router;
