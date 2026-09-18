/**
 * SAN CHECKOUT — scripts/ajudantesNavegador.mjs
 *
 * O que `scripts/acessibilidade.mjs` e `scripts/desempenho.mjs` tinham
 * cada um a sua própria cópia: os dois dublês de resposta da API
 * (`PEDIDO_DUBLE`, `PLANO_DUBLE`) e o servidor HTTP estático que serve
 * `public/` para o Chromium medir. Extraído em 18/09/2026 (ciclo de
 * revisão do projeto inteiro) pela mesma razão que `tests/ajudantes.js`
 * existe: duas cópias do mesmo dublê divergem cedo ou tarde, e a
 * divergência é silenciosa — quem corrige o formato numa cópia (porque
 * é onde mora o comentário de contexto) não necessariamente lembra da
 * outra, e o script esquecido passa a medir uma tela que a produção não
 * serve mais.
 *
 * `PEDIDO_DUBLE` é a resposta de `GET /api/checkout/pedido/:c/:id`, no
 * formato real de `pedidoController` (contratanteNome, metodosHabilitados,
 * pedido, taxa, retornoUrl) — `nome`/`valorUnitario` nos itens, como o
 * contrato manda (`API.md` §4.1); um dublê com `{descricao, valor}` audita
 * a linha de item em branco, porque o front lê os nomes de campo certos.
 *
 * `PLANO_DUBLE` é a resposta de `GET /api/checkout/plano/:c/:id`, no
 * formato real de `planoController` (o plano no topo, `_checkout` com os
 * dados do contratante).
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

export const PEDIDO_DUBLE = {
  contratanteNome: 'Loja de Teste',
  metodosHabilitados: ['pix', 'boleto', 'cartao', 'assinatura'],
  pedido: {
    tipo: 'produto',
    descricao: 'Camiseta preta — tamanho M',
    itens: [
      { nome: 'Camiseta preta M', quantidade: 1, valorUnitario: 79.9 },
      { nome: 'Meia par avulso', quantidade: 2, valorUnitario: 5 }
    ],
    valorCheio: 89.9,
    desconto: 0,
    valorComDesconto: 89.9,
    frete: 0
  },
  taxa: { taxaAsaas: 1.99, taxaPropria: 2.7, taxasTotais: 4.69, valorCobrado: 94.59 },
  maxParcelas: 12,
  retornoUrl: null
};

export const PLANO_DUBLE = {
  id: 'plano_auditoria',
  nome: 'Plano Mensal de Teste',
  descricao: 'Acesso completo, renovação automática',
  valor: 49.9,
  ciclo: 'MONTHLY',
  _checkout: {
    metodosHabilitados: ['assinatura'],
    contratanteNome: 'Loja de Teste',
    retornoUrl: null
  }
};

export const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

/** Servidor HTTP estático mínimo, só para servir `public/` a um Chromium
 *  local — não é o servidor de produção (que não tem Chromium no CI para
 *  rodar contra). `normalize` + prefixo conferido: sem isso um `..%2f` no
 *  caminho lê arquivo fora de `publico`. Servidor de teste também é
 *  servidor. */
export function servir(publico) {
  const servidor = createServer(async (req, res) => {
    const caminho = normalize(join(publico, decodeURIComponent(req.url.split('?')[0])));
    if (!caminho.startsWith(publico)) { res.writeHead(403).end(); return; }

    try {
      const corpo = await readFile(caminho);
      res.writeHead(200, { 'Content-Type': TIPOS[extname(caminho)] ?? 'application/octet-stream' });
      res.end(corpo);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('nao encontrado');
    }
  });
  return new Promise((ok) => servidor.listen(0, '127.0.0.1', () => ok(servidor)));
}
