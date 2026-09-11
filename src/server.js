/**
 * SAN CHECKOUT v2 — src/server.js
 *
 * COMO RODAR (na pasta san-checkout/):
 *   1. npm install            (exige Node 22+ — ver `engines` no package.json)
 *   2. copie .env.example para .env e preencha
 *   3. rode supabase/migrations/ em ordem numérica no SQL Editor do seu
 *      projeto Supabase (banco novo começa no 0001_baseline.sql)
 *   4. npm start
 *
 * Cobre: Pix, Cartão de Crédito (parcelado em até 12x), Boleto,
 * Assinatura por cartão e Assinatura por Pix Automático.
 *
 * Nota fiscal e e-mail ao comprador NÃO saem daqui — cada contratante
 * emite os seus, disparados pelo evento que chega no `webhook_url` dele
 * (CONSTRAINTS.md §1.9).
 *
 * ⚠️ O webhook de ENTRADA (Asaas → este servidor) ainda não recebeu
 * evento real em produção — ver a exceção da Lei 2 sobre
 * `webhookController.js` no CONSTRAINTS.md.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { supabase } from './config/supabase.js';
import { sincronizarTaxasAsaas } from './services/taxaService.js';
import { expurgarAuditoria } from './services/auditoriaWebhookService.js';
import { obterAlertasChaveApi } from './controllers/webhookController.js';
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
// Helmet não seta Permissions-Policy por padrão — API nunca usa essas
// APIs de navegador, então nega tudo.
app.use((_req, resposta, proximo) => {
  resposta.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  proximo();
});
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
app.use('/api/checkout/assinatura-pix', limitadorCriacao);
app.use('/api/checkout/estornar', limitadorCriacao);
app.use('/api/checkout/cancelar-assinatura', limitadorCriacao);
// Pausar e retomar mexem no mesmo vínculo que o cancelamento e exigem a
// mesma chave — ficaram sem limite quando entraram. Mesmo teto: o limite
// aqui não é sobre volume de uso, é sobre força bruta na chave.
app.use('/api/checkout/pausar-assinatura', limitadorCriacao);
app.use('/api/checkout/retomar-assinatura', limitadorCriacao);
app.use('/api/admin', limitadorCriacao); // mesmo teto de /estornar — só um admin usa, mas trava força-bruta na chave
app.use('/api/checkout/pedido', criarLimitadorConsulta());
app.use('/api/checkout/plano', criarLimitadorConsulta());
app.use('/api/checkout/asaas-checkout', criarLimitadorConsulta());
app.use('/api/checkout/status', criarLimitadorConsulta());   // pública (comprador)
app.use('/api/checkout/cobranca', criarLimitadorConsulta()); // autenticada (contratante)
app.use('/api/checkout/consultar-assinatura', criarLimitadorConsulta()); // conciliação de recorrência

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

  // `alertasChaveAsaas` não vazio = a Asaas avisou que a chave de API
  // vai expirar (ou já expirou). É a única forma de isso chegar a
  // alguém: sem monitoramento de erro, o console.error do webhook não é
  // lido por ninguém, e a integração cairia sem aviso.
  const alertasChaveAsaas = obterAlertasChaveApi();

  resposta.json({
    status: 'ok',
    chaveAsaasConfigurada: Boolean(process.env.ASAAS_API_KEY),
    supabaseConfigurado: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
    supabaseRespondendo: supabaseAtivo,
    alertasChaveAsaas
  });
});

const UM_DIA_MS = 24 * 60 * 60 * 1000;

app.listen(PORTA, () => {
  console.log(`[checkout] San Checkout v2 ouvindo em http://localhost:${PORTA}`);
  if (!process.env.ASAAS_API_KEY) {
    console.warn('[checkout] ASAAS_API_KEY não encontrada — cobranças vão falhar.');
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.warn('[checkout] Supabase não configurado.');
  }

  // Taxa cobrada do comprador tem que refletir a taxa real desta conta
  // na Asaas, não a tabela pública chumbada no código. Falha aqui não
  // derruba nada: o taxaService mantém a tabela padrão como fallback.
  // ponytail: setInterval simples em vez de agendador — o processo do
  // Render reinicia sozinho de vez em quando e o boot já ressincroniza.
  sincronizarTaxasAsaas();
  setInterval(sincronizarTaxasAsaas, UM_DIA_MS).unref();

  // O log de auditoria do webhook é diagnóstico, não dado fiscal: não
  // herda os 5 anos de retenção das cobranças. Pega carona no mesmo
  // ciclo de 24h em vez de ganhar agendador próprio, e roda no boot
  // porque o processo do Render reinicia sozinho — não dá para contar
  // com um intervalo de 24h ser alcançado.
  expurgarAuditoria();
  setInterval(expurgarAuditoria, UM_DIA_MS).unref();
});
