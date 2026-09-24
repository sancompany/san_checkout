#!/usr/bin/env node
/**
 * tests/cliente-asaas-uma-vez-por-documento.js
 *
 * H-05 da auditoria de 24/09/2026 — **cliente idempotente por
 * documento**: N requisições simultâneas do mesmo comprador produzem UM
 * `POST /v3/customers` na Asaas, e todas recebem o MESMO id.
 *
 * A Asaas permite cliente duplicado (doc oficial); a unicidade é nossa,
 * e mora numa reivindicação gravada ANTES de falar com ela. A primeira
 * versão gravava DEPOIS — decidia qual id ficava, mas deixava as N
 * requisições criarem N clientes lá. Foi este teste que acusou.
 *
 * Também cobre: vencedor que morre no meio (a reivindicação envelhece e
 * o próximo assume), e recusa da Asaas (a reivindicação é liberada, o
 * próximo tenta de novo).
 */

import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? 'teste';
process.env.ASAAS_API_KEY = process.env.ASAAS_API_KEY ?? 'chave-falsa';

const { criarBuscadorDeCliente } = await import('../src/services/asaasService.js');

let checagens = 0;
const igual = (a, b, m) => { assert.equal(a, b, m); checagens += 1; };
const ok = (c, m) => { assert.ok(c, m); checagens += 1; };

/** `clientes_asaas` de mentira, com chave primária (ambiente, hash) e
 *  relógio controlado. Cada operação cede o event loop. */
function tabelaFalsa({ relogio }) {
  const linhas = new Map();
  const ceder = () => new Promise((r) => setTimeout(r, 1));
  const chave = (a, h) => `${a}|${h}`;
  return {
    linhas,
    lerConhecido: async (a, h) => { await ceder(); const l = linhas.get(chave(a, h)); return l ? { ...l } : null; },
    reivindicar: async (a, h, marca) => {
      await ceder();
      if (linhas.has(chave(a, h))) return false;
      linhas.set(chave(a, h), { asaas_customer_id: marca, criado_em: new Date(relogio.agora).toISOString() });
      return true;
    },
    assumirEnvelhecida: async (a, h, marca, limiteIso) => {
      await ceder();
      const l = linhas.get(chave(a, h));
      if (!l || !l.asaas_customer_id.startsWith('pendente:') || new Date(l.criado_em).getTime() >= new Date(limiteIso).getTime()) return false;
      linhas.set(chave(a, h), { asaas_customer_id: marca, criado_em: new Date(relogio.agora).toISOString() });
      return true;
    },
    gravar: async (a, h, marca, id) => { await ceder(); const l = linhas.get(chave(a, h)); if (l && l.asaas_customer_id === marca) l.asaas_customer_id = id; },
    liberar: async (a, h, marca) => { const l = linhas.get(chave(a, h)); if (l && l.asaas_customer_id === marca) linhas.delete(chave(a, h)); },
    dormir: async (ms) => { relogio.agora += ms; await ceder(); },
    agora: () => relogio.agora,
    ambiente: () => 'sandbox',
    tetoEsperaMs: () => 20_000
  };
}

const pagador = { nome: 'Maria Silva', email: 'maria@exemplo.com', documento: '52998224725' };

/* 1. Dez ao mesmo tempo → um POST, um id para todos */
{
  const relogio = { agora: 1_000_000 };
  const tabela = tabelaFalsa({ relogio });
  let postsNaAsaas = 0;
  const buscar = criarBuscadorDeCliente({
    ...tabela,
    buscarOuCriarNaAsaas: async () => { postsNaAsaas += 1; await new Promise((r) => setTimeout(r, 8)); return `cus_${postsNaAsaas}`; }
  });
  const ids = await Promise.all(Array.from({ length: 10 }, () => buscar(pagador)));
  igual(postsNaAsaas, 1, `H-05: dez requisições simultâneas criaram ${postsNaAsaas} clientes na Asaas — tinha que ser UM`);
  ok(ids.every((id) => id === 'cus_1'), `todas recebem o mesmo id: ${[...new Set(ids)]}`);
  igual(tabela.linhas.size, 1);
  igual([...tabela.linhas.values()][0].asaas_customer_id, 'cus_1', 'a reivindicação virou o id real');
}

/* 2. Já conhecido → nem toca a Asaas */
{
  const relogio = { agora: 0 };
  const tabela = tabelaFalsa({ relogio });
  tabela.linhas.set('sandbox|' + [...'x'].join(''), null); // ruído
  let posts = 0;
  const buscar = criarBuscadorDeCliente({ ...tabela, buscarOuCriarNaAsaas: async () => { posts += 1; return 'cus_novo'; } });
  const primeiro = await buscar(pagador);
  const segundo = await buscar(pagador);
  igual(primeiro, segundo);
  igual(posts, 1, 'a segunda chamada lê o id gravado, sem ir à Asaas');
}

/* 3. Documentos diferentes → clientes diferentes (controle positivo) */
{
  const relogio = { agora: 0 };
  const tabela = tabelaFalsa({ relogio });
  let posts = 0;
  const buscar = criarBuscadorDeCliente({ ...tabela, buscarOuCriarNaAsaas: async () => { posts += 1; return `cus_${posts}`; } });
  const [a, b] = await Promise.all([buscar(pagador), buscar({ ...pagador, documento: '11144477735' })]);
  igual(posts, 2, 'controle positivo: dois documentos, dois clientes');
  ok(a !== b);
}

/* 4. Vencedor morre no meio: a reivindicação envelhece e o próximo assume */
{
  const relogio = { agora: 5_000_000 };
  const tabela = tabelaFalsa({ relogio });
  tabela.linhas.set('sandbox|' + (await import('node:crypto')).createHash('sha256').update(pagador.documento).digest('hex'),
    { asaas_customer_id: 'pendente:morto', criado_em: new Date(relogio.agora - 60_000).toISOString() });
  let posts = 0;
  const buscar = criarBuscadorDeCliente({ ...tabela, buscarOuCriarNaAsaas: async () => { posts += 1; return 'cus_assumido'; } });
  const id = await buscar(pagador);
  igual(id, 'cus_assumido', 'reivindicação de um processo morto (60 s) é assumida, não esperada para sempre');
  igual(posts, 1);
}

/* 5. Asaas recusa: a reivindicação é liberada e a próxima tentativa cria */
{
  const relogio = { agora: 0 };
  const tabela = tabelaFalsa({ relogio });
  let tentativas = 0;
  const buscar = criarBuscadorDeCliente({
    ...tabela,
    buscarOuCriarNaAsaas: async () => { tentativas += 1; if (tentativas === 1) throw new Error('Asaas 500'); return 'cus_ok'; }
  });
  await assert.rejects(() => buscar(pagador), /Asaas 500/);
  igual(tabela.linhas.size, 0, 'falha na Asaas libera a reivindicação');
  igual(await buscar(pagador), 'cus_ok');
  checagens += 1;
}

/* 6. Esperando um vencedor vivo que nunca termina: desiste no teto, sem criar em dobro */
{
  const relogio = { agora: 9_000_000 };
  const tabela = tabelaFalsa({ relogio });
  tabela.linhas.set('sandbox|' + (await import('node:crypto')).createHash('sha256').update(pagador.documento).digest('hex'),
    { asaas_customer_id: 'pendente:vivo', criado_em: new Date(relogio.agora).toISOString() });
  let posts = 0;
  const buscar = criarBuscadorDeCliente({ ...tabela, tetoEsperaMs: () => 2_000, buscarOuCriarNaAsaas: async () => { posts += 1; return 'x'; } });
  await assert.rejects(() => buscar(pagador), /a tempo/);
  igual(posts, 0, 'no teto, desiste — NUNCA cria um segundo cliente por impaciência');
}

console.log(`cliente-asaas-uma-vez-por-documento: ${checagens} checagens OK`);
