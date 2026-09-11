#!/usr/bin/env node
/**
 * scripts/ver-checkout.mjs — abre o checkout no navegador com um pedido
 * de mentira, para olhar a tela sem depender de contratante, de pedido
 * real e de nada em produção.
 *
 *   node scripts/ver-checkout.mjs                 # pedido normal
 *   node scripts/ver-checkout.mjs assinatura      # recorrência
 *   node scripts/ver-checkout.mjs sem-total       # o estado indisponível
 *   node scripts/ver-checkout.mjs --porta 3002     # se 3001 estiver ocupada
 *
 * POR QUE ISTO EXISTE, E POR QUE NÃO EM PRODUÇÃO
 * Até 11/09/2026 o mesmo efeito era obtido com um contratante de mentira
 * (`admin-master`) devolvendo um pedido de R$ 0,00 pelo backend real. O
 * arranjo custava uma linha na tabela de contratantes, uma rota montada
 * na raiz do backend, um id de pedido fantasma alcançável na página
 * pública de status — e colidiu com a guarda que passou a recusar total
 * zero, derrubando o acesso do operador ao painel.
 *
 * A lição está em `docs/erros/2026-09-11-guarda-de-total-zero-derrubou-
 * a-porta-do-admin.md`: dado de mentira na tela onde dado de mentira é
 * mais perigoso não deve morar em produção. Aqui ele mora na máquina de
 * quem está olhando, serve só o `public/` local, e some quando o
 * processo morre.
 *
 * Sem dependência nova de propósito: só `node:http` e `node:fs`. A tela
 * é aberta no SEU navegador, não num automatizado — é o olho humano que
 * a Lei 5 pede, e nenhuma biblioteca faz isso por ele.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLICO = path.join(RAIZ, 'public');

/**
 * Nada daqui pode ser guardado pelo navegador. Trocar de cenário é
 * pedir a MESMA URL esperando resposta diferente — sem isto, o
 * navegador devolve o cenário anterior e a tela mente sobre o que está
 * sendo olhado. Aconteceu na primeira vez que este script rodou: o
 * `sem-total` mostrou o pedido de R$ 149,90 do cenário de antes.
 *
 * É o mesmo defeito de
 * `docs/erros/2026-09-11-cache-desencontrado-html-novo-js-velho.md`, e
 * numa ferramenta de conferir tela ele é pior que em produção: aqui o
 * dano é acreditar que se conferiu.
 */
const SEM_CACHE = { 'Cache-Control': 'no-store, max-age=0' };

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

/**
 * Os cenários. Cada um devolve exatamente o que
 * `GET /api/checkout/pedido/:contratanteId/:pedidoId` devolve — a forma
 * foi copiada de `src/controllers/pedidoController.js`, não inventada:
 * `{ contratanteNome, metodosHabilitados, pedido, taxa }`. Cenário com
 * forma diferente da real testa outra coisa e dá falsa confiança.
 */
const CENARIOS = {
  pedido: {
    descricao: 'pedido avulso, R$ 149,90, com desconto e taxa',
    corpo: {
      contratanteNome: 'Trimundi Produções',
      metodosHabilitados: ['pix', 'boleto', 'cartao'],
      pedido: {
        pedidoId: 'ped_exemplo',
        tipo: 'compra_unica',
        status: 'pendente',
        descricao: 'Trimundi 9 — 2 ingressos',
        itens: [
          { nome: 'Ingresso Pista — Trimundi 9', quantidade: 2, valorUnitario: 79.9 }
        ],
        valorCheio: 159.8,
        desconto: 13.39,
        valorComDesconto: 146.41,
        frete: 0
      },
      taxa: { taxaAsaas: 1.99, taxaPropria: 1.5, taxasTotais: 3.49, valorCobrado: 149.9, isenta: false }
    }
  },
  assinatura: {
    descricao: 'mensalidade recorrente de R$ 97,00',
    corpo: {
      contratanteNome: 'Vitrina ADS',
      metodosHabilitados: ['assinatura'],
      pedido: {
        pedidoId: 'ped_mensal',
        tipo: 'mensalidade',
        status: 'pendente',
        descricao: 'Vitrina ADS — plano mensal',
        itens: [{ nome: 'Plano mensal', quantidade: 1, valorUnitario: 97.0 }],
        valorCheio: 97.0,
        desconto: 0,
        valorComDesconto: 97.0,
        frete: 0
      },
      taxa: { taxaAsaas: 1.99, taxaPropria: 0.5, taxasTotais: 2.49, valorCobrado: 99.49, isenta: false }
    }
  },
  'sem-total': {
    descricao: 'resposta sem valorCobrado — o estado indisponível',
    corpo: {
      contratanteNome: 'Contratante Exemplo',
      metodosHabilitados: ['pix'],
      pedido: {
        pedidoId: 'ped_quebrado',
        tipo: 'compra_unica',
        status: 'pendente',
        descricao: 'Pedido sem preço',
        itens: [{ nome: 'Item sem preço', quantidade: 1, valorUnitario: 0 }],
        valorCheio: 0,
        desconto: 0,
        valorComDesconto: 0,
        frete: 0
      },
      // Sem `valorCobrado` DE PROPÓSITO: é este cenário que mostra a
      // tela indisponível, que é o estado mais difícil de conferir e o
      // que já passou despercebido uma vez
      // (docs/erros/2026-09-11-total-ausente-virou-zero-na-tela.md).
      taxa: { taxaAsaas: 0, taxaPropria: 0, taxasTotais: 0, isenta: true }
    }
  }
};

const argumentos = process.argv.slice(2);

// O valor de `--porta` é um argumento solto como qualquer outro: pegar
// "o primeiro que não começa com --" faria `--porta 3002` ser lido como
// o cenário `3002`. Consumir o par inteiro resolve.
//
// O `indicePorta >= 0` na exclusão não é zelo: sem ele, `indexOf`
// devolvendo -1 (sem `--porta`) faz `indicePorta + 1` valer 0 e o filtro
// descartar o argumento de índice 0 — que é exatamente o nome do
// cenário. O efeito era todo cenário virar `pedido` calado.
const indicePorta = argumentos.indexOf('--porta');
const PORTA = indicePorta >= 0 ? Number(argumentos[indicePorta + 1]) : 3001;
const soltos = argumentos.filter(
  (arg, i) => !arg.startsWith('--') && !(indicePorta >= 0 && i === indicePorta + 1)
);
const nomeCenario = soltos[0] ?? 'pedido';

if (!Number.isInteger(PORTA) || PORTA < 1 || PORTA > 65535) {
  console.error(`Porta inválida: ${argumentos[indicePorta + 1]}`);
  process.exit(1);
}

const cenario = CENARIOS[nomeCenario];
if (!cenario) {
  console.error(`Cenário desconhecido: ${nomeCenario}`);
  console.error(`Disponíveis: ${Object.keys(CENARIOS).join(', ')}`);
  process.exit(1);
}

const servidor = http.createServer((requisicao, resposta) => {
  const caminho = requisicao.url.split('?')[0];

  // Qualquer coisa sob /api responde o cenário. A tela chama uma URL só,
  // mas responder tudo evita ela morrer num 404 de endpoint vizinho
  // enquanto se olha o layout.
  if (caminho.startsWith('/api/')) {
    resposta.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...SEM_CACHE });
    return resposta.end(JSON.stringify(cenario.corpo));
  }

  const arquivo = path.join(PUBLICO, caminho === '/' ? 'index.html' : caminho);

  // Prende o caminho dentro de public/: sem isto, `..` na URL leria
  // qualquer arquivo da máquina. É script local, mas script local que
  // serve arquivo é servidor como qualquer outro.
  if (!arquivo.startsWith(PUBLICO) || !fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()) {
    resposta.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return resposta.end('não encontrado');
  }

  resposta.writeHead(200, { 'Content-Type': TIPOS[path.extname(arquivo)] ?? 'application/octet-stream', ...SEM_CACHE });
  resposta.end(fs.readFileSync(arquivo));
});

/**
 * Porta 3001 e host `localhost` não são escolha de gosto: o front decide
 * sozinho para onde falar, em `public/js/utils/api.js` —
 * `http://localhost:3001` quando servido de localhost/127.0.0.1, e a URL
 * do Render em qualquer outro caso. Servir a tela e a API no MESMO
 * endereço que ele já procura é o que faz o cenário chegar até ela sem
 * tocar em uma linha do código do produto.
 *
 * `localhost` e não `127.0.0.1` no endereço impresso porque é assim que
 * o front monta a URL da API: abrir por `127.0.0.1` deixaria as duas
 * origens diferentes e o navegador barraria por CORS.
 */
servidor.on('error', (erro) => {
  if (erro.code === 'EADDRINUSE') {
    console.error(`\n  A porta ${PORTA} já está ocupada — provavelmente pelo backend de verdade (\`npm run dev\`).`);
    console.error('  Pare ele, ou rode com --porta em outra porta e ajuste api.js. O front procura 3001.\n');
    process.exit(1);
  }
  throw erro;
});

servidor.listen(PORTA, '127.0.0.1', () => {
  const chave = nomeCenario === 'assinatura' ? 'assinatura=plano_exemplo' : 'pedido=ped_exemplo';
  console.log(`\n  Cenário: ${nomeCenario} — ${cenario.descricao}`);
  console.log(`  Abra:    http://localhost:${PORTA}/index.html?c=exemplo&${chave}`);
  console.log(`  Painel:  http://localhost:${PORTA}/admin.html`);
  console.log(`\n  Ctrl+C para parar. Nada disto toca a Asaas, o Supabase ou produção.\n`);
});
