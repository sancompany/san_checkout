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
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { criarLimitadorCriacao, criarLimitadorConsulta } from './middlewares/limitadores.js';
import { supabase } from './config/supabase.js';
import { sincronizarTaxasAsaas } from './services/taxaService.js';
import { expurgarAuditoria } from './services/auditoriaWebhookService.js';
import { registrarErro, expurgarErros } from './services/erroService.js';
import { obterAlertasChaveApi } from './controllers/webhookController.js';
import rotasPedido from './routes/pedidoRoutes.js';
import rotasCheckout from './routes/checkoutRoutes.js';
import rotasAsaasCheckout from './routes/asaasCheckoutRoutes.js';
import rotasPlano from './routes/planoRoutes.js';
import rotasEstorno from './routes/refundRoutes.js';
import rotasAssinatura from './routes/assinaturaRoutes.js';
import rotasAdmin from './routes/adminRoutes.js';
import rotasWebhook from './routes/webhookRoutes.js';
import { expurgarDadoPessoal } from './services/expurgoService.js';

const app = express();
const PORTA = process.env.PORT || 3001;

// Atrás do proxy da hospedagem — precisa disso pra x-forwarded-proto (força
// HTTPS abaixo) e pro rate limit (rate-limit) identificarem o IP real do
// cliente em vez do IP do proxy.
app.set('trust proxy', 1);

/** Força HTTPS em produção — a hospedagem sempre entrega https, mas o proxy
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
/* NADA que esta API responde pode ser guardado — e o item 5 da
   prontidão operacional ("a conta não surpreende") pede `Cache-Control`
   em toda resposta que pode ser cacheada. Aqui a resposta certa é a
   oposta: **nenhuma pode**.

   O que passa por estas rotas é pedido de uma pessoa (nome, documento,
   valor), status de pagamento que muda de segundo a segundo, e painel
   administrativo autenticado. Sem o header, quem decide guardar é o
   navegador e qualquer intermediário no caminho, pelo palpite dele: o
   botão "voltar" pode repintar um pedido já pago como pendente, e um
   proxy compartilhado pode servir o pedido de um comprador para outro.

   `no-store` e não `no-cache`: `no-cache` autoriza guardar e só exige
   revalidar — a cópia fica no disco de quem passou por aqui. Não há
   exceção a abrir depois: resposta cacheável desta API não existe, e o
   `/api/saude` não é exceção (ele responde exatamente o estado de
   AGORA, que é o motivo de existir). O front estático tem política
   própria, no `public/_headers`, e é outra coisa: lá o que se guarda é
   HTML, CSS e JS, e a regra é revalidar sempre. */
app.use('/api', (_req, resposta, proximo) => {
  resposta.setHeader('Cache-Control', 'no-store');
  proximo();
});

app.use(cors({ origin: process.env.ORIGEM_FRONTEND || 'http://127.0.0.1:5501' }));
app.use(express.json());

// pix e boleto NÃO entram aqui por prefixo — ver src/middlewares/limitadores.js
// (checkoutRoutes.js monta o limitador por rota, pra não pegar o
// polling de status junto com a criação).
//
// Uma instância NOVA por `app.use()` — a mesma instância em vários
// lugares soma o contador de todos eles no mesmo balde (ver o
// comentário de limitadores.js). Até 16/09/2026 estas sete rotas
// compartilhavam uma instância só.
app.use('/api/checkout/cartao', criarLimitadorCriacao());
app.use('/api/checkout/assinatura', criarLimitadorCriacao());
app.use('/api/checkout/assinatura-pix', criarLimitadorCriacao());
app.use('/api/checkout/estornar', criarLimitadorCriacao());
app.use('/api/checkout/cancelar-assinatura', criarLimitadorCriacao());
// Pausar e retomar mexem no mesmo vínculo que o cancelamento e exigem a
// mesma chave — ficaram sem limite quando entraram. Mesmo teto: o limite
// aqui não é sobre volume de uso, é sobre força bruta na chave.
app.use('/api/checkout/pausar-assinatura', criarLimitadorCriacao());
app.use('/api/checkout/retomar-assinatura', criarLimitadorCriacao());
/* A ROTA DE LOGIN É O ÚNICO LUGAR CARO QUE SOBROU, e por isso tem o
   teto mais apertado do projeto. Cada tentativa custa ~830 ms de CPU no
   scrypt: a 10/min, um atacante consumiria 8,3 s de CPU por minuto numa
   instância de 0,5 vCPU só tentando adivinhar — negação de serviço de
   graça, sem nem precisar acertar.

   Cinco por minuto é largo para quem sabe a senha (erra, corrige, entra)
   e estreito para quem não sabe.

   CORRIGIDO EM 17/09/2026: aqui dizia "tem que vir ANTES do limitador de
   /api/admin, senão o mais largo casa primeiro", e isso é falso. O
   `app.use` não escolhe UM middleware: ele roda TODOS os que casam o
   caminho, na ordem de registro. Uma requisição a `/api/admin/sessao`
   passa pelos dois limitadores de qualquer forma, e o mais apertado é o
   que barra. Medido com a ordem deliberadamente invertida: a 6ª
   tentativa continua vindo `429` com `RateLimit-Limit: 5`.

   A ordem daqui é a natural de ler (do específico para o geral) e não
   depende de nada — quem vier depois não precisa preservá-la por medo. */
app.use('/api/admin/sessao', rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas de login. Aguarde um minuto.' }
}));

/* O resto do painel ficou BARATO — verificar o token custa ~36µs em vez
   de 830 ms —, então o teto de 10/min que existia para conter a
   derivação deixou de fazer sentido: ele estrangulava o uso normal (uma
   tela que recarrega três listas gasta 3 das 10) sem proteger nada que a
   rota de sessão já não proteja. */
app.use('/api/admin', criarLimitadorConsulta());
app.use('/api/checkout/pedido', criarLimitadorConsulta());
app.use('/api/checkout/plano', criarLimitadorConsulta());
app.use('/api/checkout/asaas-checkout', criarLimitadorConsulta());
app.use('/api/checkout/status', criarLimitadorConsulta());   // pública (comprador)
app.use('/api/checkout/cobranca', criarLimitadorConsulta()); // autenticada (contratante)
app.use('/api/checkout/consultar-assinatura', criarLimitadorConsulta()); // conciliação de recorrência

// `/api/saude` NÃO é barata: ela faz uma consulta de verdade no Supabase
// a cada chamada — é justamente isso que impede o projeto gratuito de ser
// pausado por inatividade. Sem limite, é o caminho mais barato que existe
// para queimar a quota do Supabase ou derrubar a instância de 512 MiB, e
// não exige credencial nenhuma: só saber a URL.
//
// O teto é FOLGADO de propósito. Quem consulta de verdade é o cron
// externo, a cada 10 minutos — 6 por hora. 30/min deixa espaço para o
// operador abrir a página de status, para um segundo monitor e para
// retentativa, e ainda assim corta a sondagem em ordem de grandeza.
app.use('/api/saude', rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições em pouco tempo. Aguarde um minuto.' }
}));

// O webhook é a única rota pública que aceita POST sem credencial ANTES
// de olhar o token — a guarda recusa, mas recusar também custa. O teto
// aqui é alto porque a Asaas dispara em rajada (um pagamento gera vários
// eventos, e o reenvio da fila retida vem em bloco): cortar evento
// legítimo é pior que absorver sondagem, porque a Asaas PAUSA a fila
// depois de 15 falhas consecutivas (CONSTRAINTS.md §2.3) e só volta com
// reativação manual.
//
// Ou seja: este limite existe para tapar o caso absurdo, não para ser
// a defesa. A defesa é a guarda de token, e a contabilidade do que foi
// recusado está em `webhook_rejeicoes` (migration 0002).
app.use('/api/webhooks', rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições em pouco tempo.' }
}));

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

  // O status reflete a saúde de verdade, e o HTTP acompanha: banco fora
  // do ar é o serviço fora do ar (nada cobra, nada concilia). Sem isso a
  // rota devolvia `200 ok` com o Supabase caído, e um monitor externo de
  // uptime — que alerta por código HTTP — não via a queda. Agora um
  // monitor gratuito batendo aqui (a cada poucos minutos) alerta sozinho
  // quando cai: é a metade de código do "alguém descobre antes do
  // cliente" (Lei 8). A outra metade é ligar o alerta no painel do
  // monitor — RUNBOOK §2. Expiração de chave da Asaas é aviso, não
  // queda: fica no corpo (`alertasChaveAsaas`), sem derrubar o HTTP.
  const saudavel = supabaseAtivo;
  resposta.status(saudavel ? 200 : 503).json({
    status: saudavel ? 'ok' : 'degradado',
    chaveAsaasConfigurada: Boolean(process.env.ASAAS_API_KEY),
    supabaseConfigurado: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
    supabaseRespondendo: supabaseAtivo,
    alertasChaveAsaas
  });
});

// ---------------------------------------------------------------------
// FIM DA PILHA: 404 e erro. Precisam ser os ÚLTIMOS `app.use`, depois de
// toda rota — Express escolhe por ordem de registro.
//
// POR QUE ISTO EXISTE, se o Express já tem os dois embutidos
// Porque os embutidos respondem HTML (`<pre>Cannot POST /x</pre>`) numa
// API que só fala JSON — o cliente recebe algo que não sabe ler e mostra
// erro de parse em vez do erro real. E, no caso do erro, o embutido
// devolve o STACK TRACE quando `NODE_ENV` não é exatamente
// 'production'.
//
// Essa é a parte que importa: a higiene de erro em produção não pode
// depender de uma variável de ambiente estar certa num painel que
// ninguém revisa. Verificado em 11/09/2026, ainda no Render, que daqui
// não dá para provar o valor de `NODE_ENV` (o proxy sobrescreve
// `x-forwarded-proto`, que era a única pista observável de fora) — e
// "provavelmente está certo" não é verificação. Com estes dois
// tratadores, o vazamento fica impossível independente do valor.
// ---------------------------------------------------------------------
app.use((requisicao, resposta) => {
  resposta.status(404).json({ erro: 'Rota não encontrada.' });
});

// eslint-disable-next-line no-unused-vars -- o 4º parâmetro é o que faz
// o Express reconhecer isto como tratador de erro. Remover `proximo`
// transforma o tratador em middleware comum e o erro volta a cair no
// embutido, calado.
app.use((erro, requisicao, resposta, proximo) => {
  // O detalhe vai para o log do servidor, nunca para a resposta: aqui
  // dentro cabe nome de tabela, caminho de arquivo e versão de
  // biblioteca — informação de graça para quem está sondando.
  console.error('[checkout] erro não tratado:', requisicao.method, requisicao.originalUrl, erro);

  // Corpo JSON malformado chega aqui com status 400 já definido pelo
  // express.json(). É erro do cliente, não do servidor, e merece o
  // código certo — 500 aqui faria monitoramento futuro contar sondagem
  // como falha nossa.
  const status = Number.isInteger(erro?.status) && erro.status >= 400 && erro.status < 500
    ? erro.status
    : 500;

  /* O que escapou de todo tratador vira linha em `erros` (Lei 8). Só
     5xx: corpo JSON malformado é sondagem, não defeito nosso, e contar
     sondagem como falha apaga o sinal. `originalUrl` fica de fora de
     propósito — ver `erroService.js`. */
  if (status >= 500) {
    void registrarErro(erro, {
      contexto: 'servidor.naoTratado',
      rota: requisicao.route?.path ? `${requisicao.baseUrl ?? ''}${requisicao.route.path}` : null,
      metodo: requisicao.method,
      status
    });
  }

  if (resposta.headersSent) return proximo(erro);
  resposta.status(status).json({
    erro: status === 500
      ? 'Erro interno. Tente novamente em instantes.'
      : 'Requisição inválida.'
  });
});

const UM_DIA_MS = 24 * 60 * 60 * 1000;

/* O `app` sai para o autoteste poder exercitar as ROTAS, e não só os
   módulos — a Lei 0 pedia isso e `docs/pendencias.md` registrava a
   falta: nenhuma suíte subia o Express, e o roteiro de login por token
   só existia como teste feito à mão em 12/09/2026.

   A saída do `listen` é invertida de propósito. O idiomático seria
   "escuta só se eu for o ponto de entrada", mas errar essa detecção em
   produção é o serviço no ar sem ouvir porta nenhuma — queda total, e
   silenciosa. Então o padrão é SEMPRE escutar, e quem não quer diz
   explicitamente. Nenhuma variável ausente, mal escrita ou renomeada
   consegue impedir o boot. */
export { app };

if (process.env.CHECKOUT_SEM_LISTEN === '1') {
  console.log('[checkout] CHECKOUT_SEM_LISTEN=1 — o app foi montado e NÃO está ouvindo porta (modo de teste).');
} else app.listen(PORTA, () => {
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
  // serviço reinicia sozinho de vez em quando e o boot já ressincroniza.
  sincronizarTaxasAsaas();
  setInterval(sincronizarTaxasAsaas, UM_DIA_MS).unref();

  // O log de auditoria do webhook é diagnóstico, não dado fiscal: não
  // herda os 5 anos de retenção das cobranças. Pega carona no mesmo
  // ciclo de 24h em vez de ganhar agendador próprio, e roda no boot
  // porque o processo da hospedagem reinicia sozinho — não dá para contar
  // com um intervalo de 24h ser alcançado.
  expurgarAuditoria();
  setInterval(expurgarAuditoria, UM_DIA_MS).unref();

  // Captura de erro tem retenção própria, mais curta (30 dias): é
  // diagnóstico, não rastro de cobrança.
  expurgarErros();
  setInterval(expurgarErros, UM_DIA_MS).unref();

  /* DADO PESSOAL DO COMPRADOR — cinco anos (Lei 10,
     `docs/inventario-de-dados.md` §6). Até 17/09/2026 o prazo estava
     decidido e nada apagava nada: era intenção, não prática.

     `simular: false` porque esta é a rotina de verdade, e ela ANONIMIZA
     em vez de apagar — a linha continua servindo de registro fiscal sem
     identificar ninguém (§6.2). Não faz nada até 2031, porque não
     existe transação de cinco anos atrás; o valor de estar ligada agora
     é não depender de alguém lembrar em 2031.

     Para ver o que ela faria, `npm run expurgo` (simula por padrão). */
  const rodarExpurgo = () => expurgarDadoPessoal({ simular: false })
    .then((relatorios) => {
      const mexidas = relatorios.reduce((soma, r) => soma + r.anonimizadas, 0);
      if (mexidas > 0) console.log(`[expurgo] ${mexidas} linha(s) anonimizada(s) por prazo de retenção.`);
    })
    .catch((erro) => console.error('[expurgo]', erro.message));

  rodarExpurgo();
  setInterval(rodarExpurgo, UM_DIA_MS).unref();
});
