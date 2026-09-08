/**
 * SAN CHECKOUT v2 — src/server.js
 *
 * COMO RODAR (na pasta san-checkout/):
 *   1. npm install
 *   2. copie .env.example para .env e preencha
 *   3. rode supabase/schema.sql no SQL Editor do seu projeto Supabase
 *   4. npm start
 *
 * Cobre: Pix, Cartão de Crédito (parcelado), Boleto, Assinatura
 * (RECURRENT) e arquivamento de nota fiscal no Drive. NADA disso foi
 * testado ao vivo em sandbox ainda — ver os avisos ⚠️ espalhados nos
 * arquivos de cada parte pra saber exatamente o que pode precisar de
 * ajuste na primeira chamada real.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { supabase } from './config/supabase.js';
import rotasPedido from './routes/pedidoRoutes.js';
import rotasCheckout from './routes/checkoutRoutes.js';
import rotasAsaasCheckout from './routes/asaasCheckoutRoutes.js';
import rotasPlano from './routes/planoRoutes.js';
import rotasEstorno from './routes/refundRoutes.js';
import rotasAssinatura from './routes/assinaturaRoutes.js';
import rotasAdmin from './routes/adminRoutes.js';
import rotasWebhook from './routes/webhookRoutes.js';

const app = express();
const PORTA = process.env.PORT || 3001;

// Atrás do proxy do Render — precisa disso pra x-forwarded-proto (força
// HTTPS abaixo) e pro rate limit (rate-limit) identificarem o IP real do
// cliente em vez do IP do proxy.
app.set('trust proxy', 1);

/** Força HTTPS em produção — Render sempre entrega https, mas o proxy
 *  repassa a origem real em x-forwarded-proto; local (dev) não tem esse
 *  header, então não interfere no teste em http://localhost. */
app.use((requisicao, resposta, proximo) => {
  if (process.env.NODE_ENV === 'production' && requisicao.get('x-forwarded-proto') !== 'https') {
    return resposta.redirect(301, `https://${requisicao.get('host')}${requisicao.originalUrl}`);
  }
  proximo();
});

app.use(helmet());
app.use(cors({ origin: process.env.ORIGEM_FRONTEND || 'http://127.0.0.1:5501' }));
app.use(express.json());

const limitadorCriacao = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas em pouco tempo. Aguarde um minuto.' }
});

// ponytail: fábrica em vez de uma instância só reaproveitada nas 3 rotas
// de consulta — cada `rateLimit(...)` guarda o contador na store por
// IP+path-de-montagem; a MESMA instância em 3 app.use() diferentes soma
// as 3 chamadas no mesmo balde de 60/min (bug real, achado testando
// Cartão). Uma instância por rota = 60/min CADA uma, como o número já
// sugeria.
function criarLimitadorConsulta() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erro: 'Muitas requisições em pouco tempo. Aguarde um minuto.' }
  });
}

app.use('/api/checkout/pix', limitadorCriacao);
app.use('/api/checkout/cartao', limitadorCriacao);
app.use('/api/checkout/boleto', limitadorCriacao);
app.use('/api/checkout/assinatura', limitadorCriacao);
app.use('/api/checkout/estornar', limitadorCriacao);
app.use('/api/checkout/cancelar-assinatura', limitadorCriacao);
app.use('/api/admin', limitadorCriacao); // mesmo teto de /estornar — só um admin usa, mas trava força-bruta na chave
app.use('/api/checkout/pedido', criarLimitadorConsulta());
app.use('/api/checkout/plano', criarLimitadorConsulta());
app.use('/api/checkout/asaas-checkout', criarLimitadorConsulta());

app.use('/api/checkout', rotasPedido);
app.use('/api/checkout', rotasCheckout);
app.use('/api/checkout', rotasAsaasCheckout);
app.use('/api/checkout', rotasPlano);
app.use('/api/checkout', rotasEstorno);
app.use('/api/checkout', rotasAssinatura);
app.use('/api/admin', rotasAdmin);
app.use('/api/webhooks', rotasWebhook);

app.get('/api/saude', async (_req, resposta) => {
  // Faz uma consulta MÍNIMA de verdade no Supabase (não só verifica a
  // variável de ambiente) — é isso que impede o projeto gratuito de
  // ser pausado por inatividade depois de 7 dias. Um serviço externo
  // gratuito de agendamento (cron-job.org, UptimeRobot etc.) deve
  // bater nesta rota a cada 2-3 dias — isso é configuração manual,
  // não código.
  let supabaseAtivo = false;
  try {
    const { error } = await supabase.from('contratantes').select('id').limit(1);
    supabaseAtivo = !error;
  } catch {
    supabaseAtivo = false;
  }

  resposta.json({
    status: 'ok',
    chaveAsaasConfigurada: Boolean(process.env.ASAAS_API_KEY),
    supabaseConfigurado: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
    supabaseRespondendo: supabaseAtivo
  });
});

app.listen(PORTA, () => {
  console.log(`[checkout] San Checkout v2 ouvindo em http://localhost:${PORTA}`);
  if (!process.env.ASAAS_API_KEY) {
    console.warn('[checkout] ASAAS_API_KEY não encontrada — cobranças vão falhar.');
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.warn('[checkout] Supabase não configurado.');
  }
});
