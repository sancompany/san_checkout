/**
 * SAN CHECKOUT — src/controllers/masterController.js
 * GET /pedido/:pedidoId  (na RAIZ do backend, não sob /api/checkout)
 *
 * O contratante `admin-master` existe pra UMA coisa: abrir o checkout
 * por um link de contratante de verdade, sem erro de "contratante não
 * encontrado". Não cobra nada.
 *
 * Por que a rota mora na raiz: o `api_base_url` do admin-master aponta
 * pro próprio backend do checkout, e o `pedidoService` sempre chama
 * `{api_base_url}/pedido/{id}`. Ou seja — o checkout liga pra ele
 * mesmo, cumprindo o mesmo contrato de qualquer contratante externo
 * (INTEGRACAO/API.md 4.1), inclusive a autenticação. Nenhuma exceção
 * foi aberta no modelo pull pra isso funcionar, e é assim que deve
 * continuar.
 *
 * `valor: 0` COM `isentarTaxa: true`: sem a isenção, `calcularTaxa`
 * somaria a taxa fixa (R$1,99 + R$0,50) sobre nada e a tela mostraria
 * R$ 2,49 a pagar num pedido de R$ 0,00.
 *
 * Tentar pagar aqui devolve 400 ("Valor do pedido inválido") — de
 * propósito: `valorValido` recusa zero, e essa recusa é a proteção que
 * não queremos afrouxar só por causa deste caso.
 */

import { buscarContratante } from '../services/pedidoService.js';
import { compararSeguro } from '../utils/validadores.js';
import { responderErro } from '../utils/erros.js';

/** O contratante dono desta rota. */
const CONTRATANTE_MASTER = 'admin-master';

/**
 * O único pedidoId aceito. Tem sufixo aleatório porque a página pública
 * de status (`status.html?c=...&pedido=...`) é alcançável por quem
 * souber o id — com `master` puro, qualquer um adivinharia. Não é
 * segredo forte e não precisa ser: não há dado pessoal nem dinheiro
 * atrás dele.
 */
const PEDIDO_MASTER = 'master-9c538847';

const PEDIDO = {
  pedidoId: PEDIDO_MASTER,
  status: 'pendente',
  itens: [{ nome: 'Acesso ao checkout — SAN & CO.', quantidade: 1, valorUnitario: 0 }],
  valorCheio: 0,
  desconto: 0,
  valorComDesconto: 0,
  frete: 0,
  taxaDoProjeto: 0,
  isentarTaxa: true,
  descricao: 'Acesso ao checkout — SAN & CO. (sem cobrança)'
};

export async function pedidoMaster(requisicao, resposta) {
  if (requisicao.params.pedidoId !== PEDIDO_MASTER) {
    return resposta.status(404).json({ erro: 'Pedido não encontrado.' });
  }

  try {
    // A chave é lida do próprio Supabase, não de uma env nova: ela já
    // existe como `contratantes.api_key` e é a mesma que o checkout
    // manda no header. Um segredo, um lugar.
    const contratante = await buscarContratante(CONTRATANTE_MASTER);
    if (!contratante) {
      return resposta.status(404).json({ erro: 'Pedido não encontrado.' });
    }

    if (!compararSeguro(requisicao.get('X-Checkout-Key'), contratante.api_key)) {
      return resposta.status(401).json({ erro: 'X-Checkout-Key inválida.' });
    }

    resposta.json(PEDIDO);
  } catch (erro) {
    responderErro(resposta, erro, 'masterController.pedidoMaster');
  }
}
