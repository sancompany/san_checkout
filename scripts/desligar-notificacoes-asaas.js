/**
 * SAN CHECKOUT — scripts/desligar-notificacoes-asaas.js
 *
 * Desliga as notificações automáticas da Asaas nos clientes que JÁ
 * existem na conta.
 *
 * Por quê: a Asaas cria 8 notificações por cliente (e-mail e SMS
 * ligados por padrão) e passa a cobrar o comprador EM NOME DELA — o
 * comprador nunca ouviu falar da Asaas, e SMS/voz são tarifados. O
 * `asaasService.buscarOuCriarCliente` já manda `notificationDisabled:
 * true`, mas isso só vale pra cliente NOVO. Este script cuida do
 * passado.
 *
 * COMO RODAR (na pasta do projeto, com o .env preenchido):
 *
 *   node scripts/desligar-notificacoes-asaas.js            → só LISTA (não muda nada)
 *   node scripts/desligar-notificacoes-asaas.js --aplicar  → aplica de verdade
 *
 * Começa em modo simulação de propósito: rode sem `--aplicar` primeiro,
 * confira quantos clientes seriam afetados, e só depois aplique.
 * Respeita o ambiente configurado em ASAAS_AMBIENTE — em sandbox mexe
 * na conta sandbox, em produção mexe na produção.
 */

import 'dotenv/config';
import { getConfigAsaas } from '../src/config/asaas.js';

const APLICAR = process.argv.includes('--aplicar');
const PAGINA = 100;

const { baseUrl, headers } = getConfigAsaas();

async function chamar(caminho, opcoes = {}) {
  const resposta = await fetch(`${baseUrl}${caminho}`, {
    ...opcoes,
    headers: { ...headers, ...(opcoes.headers ?? {}) }
  });
  const corpo = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    throw new Error(corpo.errors?.[0]?.description || `Asaas respondeu ${resposta.status}`);
  }
  return corpo;
}

async function* todosOsClientes() {
  let offset = 0;
  for (;;) {
    const pagina = await chamar(`/v3/customers?limit=${PAGINA}&offset=${offset}`, { method: 'GET' });
    const lista = pagina.data ?? [];
    for (const cliente of lista) yield cliente;
    if (!pagina.hasMore) return;
    offset += PAGINA;
  }
}

async function principal() {
  console.log(`Ambiente: ${baseUrl}`);
  console.log(APLICAR ? 'Modo: APLICANDO alterações\n' : 'Modo: SIMULAÇÃO (nada será alterado — use --aplicar para valer)\n');

  let total = 0;
  let jaDesligados = 0;
  let alterados = 0;
  const falhas = [];

  for await (const cliente of todosOsClientes()) {
    total += 1;

    if (cliente.notificationDisabled === true) {
      jaDesligados += 1;
      continue;
    }

    if (!APLICAR) {
      console.log(`  [simulação] desligaria: ${cliente.name} (${cliente.cpfCnpj ?? 'sem documento'}) — ${cliente.id}`);
      alterados += 1;
      continue;
    }

    try {
      // PUT — confirmado na definição OpenAPI da Asaas para
      // /v3/customers/{id} ("Atualizar cliente existente").
      await chamar(`/v3/customers/${cliente.id}`, {
        method: 'PUT',
        body: JSON.stringify({ notificationDisabled: true })
      });
      alterados += 1;
      console.log(`  desligado: ${cliente.name} — ${cliente.id}`);
    } catch (erro) {
      falhas.push({ id: cliente.id, nome: cliente.name, motivo: erro.message });
      console.error(`  FALHOU: ${cliente.name} — ${cliente.id}: ${erro.message}`);
    }
  }

  console.log(`\nClientes lidos: ${total}`);
  console.log(`Já estavam desligados: ${jaDesligados}`);
  console.log(APLICAR ? `Desligados agora: ${alterados}` : `Seriam desligados: ${alterados}`);
  if (falhas.length) console.log(`Falhas: ${falhas.length} (listadas acima)`);
  if (!APLICAR && alterados > 0) console.log('\nRode de novo com --aplicar para efetivar.');
}

principal().catch((erro) => {
  console.error('Erro fatal:', erro.message);
  process.exit(1);
});
