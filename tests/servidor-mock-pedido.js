/**
 * tests/servidor-mock-pedido.js
 *
 * FERRAMENTA DE USO MANUAL, não suíte: não tem assertiva nenhuma e não
 * entra em `npm test`. Quem a roda é uma pessoa, num terminal separado.
 * (Este cabeçalho dizia `mock/servidor-mock-pedido.js` — pasta que não
 * existe. Ponteiro envelhece calado, e agora há teste conferindo.)
 *
 * Simula a API que a Trimundi (ou qualquer projeto) vai expor de
 * verdade um dia — devolve um pedido/plano fixo pra QUALQUER id, e
 * loga qualquer webhook que o checkout mandar. Existe só pra testar o
 * checkout sem precisar de nenhum serviço externo.
 *
 * COMO USAR (num terminal SEPARADO do backend de verdade):
 *   node tests/servidor-mock-pedido.js
 *   → fica ouvindo em http://localhost:4000
 *
 * No Supabase (ou via public/admin.html), o contratante de teste
 * precisa ter:
 *   api_base_url = http://localhost:4000
 *   api_key       = chave-teste-123 (ou qualquer valor — este mock
 *                    não valida a chave, só o backend real valida a DELE)
 *   webhook_url   = http://localhost:4000/webhook
 */

import express from 'express';

const app = express();
const PORTA = 4000;
app.use(express.json());

// ponytail: memória do processo, zera a cada restart do mock — é só
// isso que um contratante de verdade faria (marcar o pedido como
// pago no banco DELE ao receber o webhook), pra simular de verdade a
// proteção contra cobrar duas vezes o mesmo pedido (INTEGRACAO.md 3.1.1).
const pedidosPagos = new Set();

app.get('/pedido/:id', (requisicao, resposta) => {
  console.log(`[mock] pedido solicitado: ${requisicao.params.id}`);
  resposta.json({
    pedidoId: requisicao.params.id,
    status: pedidosPagos.has(requisicao.params.id) ? 'pago' : 'pendente',
    itens: [
      { nome: 'Produto de Teste A', quantidade: 2, valorUnitario: 30.00 },
      { nome: 'Produto de Teste B', quantidade: 1, valorUnitario: 40.00 }
    ],
    valorCheio: 100.00,
    desconto: 0,
    valorComDesconto: 100.00,
    taxaDoProjeto: 0,
    frete: 0,
    isentarTaxa: false,
    descricao: 'Pedido de teste'
  });
});

/** Pra testar Assinatura — qualquer id de plano devolve o mesmo plano fixo. */
app.get('/plano/:id', (requisicao, resposta) => {
  console.log(`[mock] plano solicitado: ${requisicao.params.id}`);
  resposta.json({
    planoId: requisicao.params.id,
    nome: 'Plano de Teste',
    valor: 50.00,
    ciclo: 'MONTHLY',
    descricao: 'Assinatura de teste'
  });
});

/** Recebe e mostra qualquer webhook que o checkout mande — confirmação
 *  de pedido, eventos de assinatura (criada/cobranca_confirmada/
 *  cobranca_falhou/cobranca_estornada), etc. */
app.post('/webhook', (requisicao, resposta) => {
  console.log('[mock] webhook recebido:', JSON.stringify(requisicao.body, null, 2));
  const { pedidoId, status } = requisicao.body ?? {};
  if (pedidoId && status === 'confirmado') {
    pedidosPagos.add(pedidoId);
    console.log(`[mock] pedido ${pedidoId} marcado como pago — GET /pedido/${pedidoId} agora recusa nova cobrança.`);
  }
  resposta.status(200).json({ recebido: true });
});

app.listen(PORTA, () => {
  console.log(`[mock] Servidor de teste ouvindo em http://localhost:${PORTA}`);
  console.log('[mock] Qualquer id de pedido/plano devolve o mesmo JSON fixo; webhooks aparecem aqui.');
});
