/**
 * SAN CHECKOUT v2 — src/services/emailService.js
 * E-mail de confirmação de pagamento (VISAO_COMPLETA.md seção 9, item
 * 2) — disparado pelo webhookController assim que uma cobrança
 * confirma. Usa SMTP do Google Workspace, de
 * `financeiro@sancocore.com.br`.
 *
 * ⚠️ Precisa de uma SENHA DE APP do Workspace (não a senha normal da
 * conta — o Google bloqueia login SMTP de terceiros mesmo com a senha
 * certa se não for uma senha de app), gerada em
 * myaccount.google.com/apppasswords (exige verificação em duas etapas
 * ativada na conta). Ver `.env.example` pras variáveis exatas.
 *
 * NUNCA deve derrubar o fluxo de pagamento por causa de e-mail: sem
 * SMTP configurado, só loga um aviso e segue; se o envio falhar (SMTP
 * fora do ar, credencial errada etc.), só loga o erro.
 *
 * ⚠️ NUNCA TESTADO AO VIVO — falta a senha de app de verdade no .env
 * pra confirmar que o Workspace aceita esse envio.
 */

import nodemailer from 'nodemailer';

let transportadorCache;

function obterTransportador() {
  if (transportadorCache !== undefined) return transportadorCache;

  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    transportadorCache = null;
    return transportadorCache;
  }

  const porta = Number(process.env.SMTP_PORT || 587);
  transportadorCache = nodemailer.createTransport({
    host: SMTP_HOST,
    port: porta,
    secure: porta === 465, // 465 = SSL direto; 587 (padrão) usa STARTTLS
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  return transportadorCache;
}

const METODO_LABEL = {
  pix: 'Pix',
  boleto: 'Boleto',
  cartao_credito: 'Cartão de crédito',
  assinatura: 'Assinatura'
};

function formatarValor(valor) {
  return Number(valor ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * @param {object} dados
 * @param {string} dados.para — e-mail do pagador
 * @param {string} [dados.nomeContratante]
 * @param {string} dados.metodoPagamento — 'pix' | 'boleto' | 'cartao_credito' | 'assinatura'
 * @param {number} dados.valor
 * @param {string} [dados.referencia] — pedidoId ou planoId, só pra rodapé informativo
 */
export async function enviarEmailConfirmacao({ para, nomeContratante, metodoPagamento, valor, referencia }) {
  if (!para) return; // sem e-mail do pagador registrado nesta cobrança — nada a fazer

  const transportador = obterTransportador();
  if (!transportador) {
    console.warn('[emailService] SMTP não configurado no .env — e-mail de confirmação não enviado.');
    return;
  }

  const remetente = process.env.SMTP_FROM || 'financeiro@sancocore.com.br';
  const metodoLegivel = METODO_LABEL[metodoPagamento] ?? metodoPagamento ?? 'pagamento';
  const nomeExibido = nomeContratante || 'SAN & CO.';

  try {
    await transportador.sendMail({
      from: `"${nomeExibido} via SAN & CO. Pay Engine" <${remetente}>`,
      to: para,
      subject: `Pagamento confirmado — ${nomeExibido}`,
      text: `Seu pagamento de ${formatarValor(valor)} via ${metodoLegivel} foi confirmado.`
        + (referencia ? `\nReferência: ${referencia}` : ''),
      html: `<p>Seu pagamento de <strong>${formatarValor(valor)}</strong> via <strong>${metodoLegivel}</strong> foi confirmado.</p>`
        + (referencia ? `<p style="color:#6b7280;font-size:12px">Referência: ${referencia}</p>` : '')
    });
  } catch (erro) {
    console.error('[emailService.enviarEmailConfirmacao] falha ao enviar:', erro.message);
  }
}
