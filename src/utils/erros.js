/**
 * SAN CHECKOUT v2 — src/utils/erros.js
 * Um erro com `.status` já definido veio de validação nossa
 * (validadores.js, pedidoService.js) ou da Asaas (`asaasService.js`
 * já usa a descrição que a própria Asaas manda pro usuário final,
 * pensada pra ser mostrada) — mensagem já é segura de devolver.
 * Sem `.status` é erro inesperado (Supabase, rede, bug) — nunca
 * expõe a mensagem crua pro cliente (pode vazar detalhe de schema/
 * infra), só loga no servidor e devolve algo genérico.
 */

import { registrarErro } from '../services/erroService.js';

/** A Asaas recusando a NOSSA credencial (401/403) ou fora do ar (5xx). */
function falhaDaAsaasQueNaoEDeQuemChamou(erro) {
  return erro.resumoAsaas !== undefined && (erro.status === 401 || erro.status === 403 || erro.status >= 500);
}

export function responderErro(resposta, erro, contexto, statusPadrao = 502) {
  console.error(`[${contexto}]`, erro.message);

  /* A ASAAS RECUSANDO A NOSSA CREDENCIAL, OU FORA DO AR, NÃO É ERRO DE
     QUEM CHAMOU (INFO-11, 25/09/2026). Até aqui o status dela passava
     direto: um `401` da Asaas (a NOSSA chave recusada) chegava ao
     contratante como `401` com "A chave de API fornecida é inválida" —
     que o `API.md` define como a `X-Checkout-Key` DELE inválida —, e um
     5xx levava o texto interno dela. Para quem chamou, é o que o
     contrato já promete: `502`, falha ao falar com a Asaas — e, sendo
     5xx, entra na captura abaixo: a nossa chave recusada é incidente,
     não validação. 4xx de validação (400, 404, 409, 429…) segue como
     está, com a mensagem já redigida na origem (`chamarAsaas`). */
  if (falhaDaAsaasQueNaoEDeQuemChamou(erro)) {
    erro = Object.assign(new Error('O meio de pagamento não aceitou a operação agora. Tente de novo em instantes.'), {
      status: 502, resumoAsaas: erro.resumoAsaas, statusDaAsaas: erro.status
    });
  }

  const status = erro.status ?? statusPadrao;

  /* Captura persistente (Lei 8), a partir de 16/09/2026. Só 5xx:
     validação recusada é o sistema funcionando, e gravá-la encheria a
     tabela com tráfego normal — o que apagaria o sinal que ela existe
     para dar.

     A rota sai de `resposta.req`, e sai como PADRÃO (`baseUrl` +
     `route.path`), nunca `originalUrl`: a URL real carrega o `pedidoId`,
     que por desenho é imprevisível e portanto é credencial. Tirar daqui
     em vez de pedir por parâmetro mantém as ~20 chamadas de
     `responderErro` intactas. */
  if (status >= 500) {
    const requisicao = resposta.req;
    void registrarErro(erro, {
      contexto,
      rota: requisicao?.route?.path
        ? `${requisicao.baseUrl ?? ''}${requisicao.route.path}`
        : null,
      metodo: requisicao?.method,
      status
    });
  }

  if (erro.status) {
    return resposta.status(erro.status).json({
      erro: erro.message,
      ...(erro.pedido ? { pedido: erro.pedido } : {}),
      /* `codigo` e `cotacao` (C-02): o 409 de cotação divergente leva a
         cotação NOVA no corpo, para a tela mostrar o valor novo e pedir
         reconfirmação sem uma segunda ida ao servidor. */
      ...(erro.codigo ? { codigo: erro.codigo } : {}),
      ...(erro.cotacao ? { cotacao: erro.cotacao } : {})
    });
  }
  resposta.status(statusPadrao).json({ erro: 'Erro interno — tente novamente em instantes.' });
}
