#!/usr/bin/env node
/**
 * tests/executar.js — roda TODOS os autotestes com um comando só.
 *
 *   npm test
 *
 * Os testes moram junto do código que eles testam (o bloco no fim de
 * cada módulo, disparado quando o arquivo é executado direto). Este
 * arquivo é só o que os junta: sem ele, "rodar os testes" era lembrar de
 * três comandos diferentes, e é por isso que nunca rodavam.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  'src/utils/validadores.js',        // tetos de campo e comparação de credencial
  'src/utils/assinaturaWebhook.js',  // assinatura HMAC do webhook de saída
  'src/services/taxaService.js',     // conversão das taxas da Asaas
  'src/services/pedidoService.js',   // id imprevisível e método habilitado
  'src/utils/senhaAdmin.js',         // hash da senha do admin (scrypt)
  'src/utils/sessaoAdmin.js',        // token de sessão do admin: forja, adulteração, validade
  'src/services/auditoriaWebhookService.js', // redação do log: nenhum dado de pessoa sobrevive
  'src/controllers/webhookController.js', // caminho crítico do webhook: guarda, mapa de status, soma de taxas
  'tests/valor-vem-do-servidor.js',  // o corpo da requisição nunca dita quanto se cobra
  'tests/sem-consulta-repetida.js',  // nenhuma ida ao banco repetida no caminho do dinheiro
  'tests/senha-nao-fica-no-navegador.js', // a senha do admin não sobrevive ao login
  'tests/total-nao-confiavel-nao-vira-tela-compravel.js' // total que não se cobra não vira tela com botão
];

/**
 * Valores falsos só para os módulos CARREGAREM: `pedidoService` importa o
 * cliente do Supabase no topo, e ele é construído no import — exige as
 * variáveis existirem. Nenhum teste toca rede ou banco.
 */
const AMBIENTE = {
  ...process.env,
  SUPABASE_URL: process.env.SUPABASE_URL ?? 'http://127.0.0.1:0',
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ?? 'teste'
};

let falharam = 0;

for (const suite of SUITES) {
  const r = spawnSync(process.execPath, [suite], { cwd: RAIZ, env: AMBIENTE, encoding: 'utf8' });
  const passou = r.status === 0;
  if (!passou) falharam += 1;

  console.log(`${passou ? '  ok  ' : 'FALHOU'}  ${suite}`);
  const saida = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (saida) console.log(saida.split('\n').map((l) => `          ${l}`).join('\n'));
}

console.log(
  falharam === 0
    ? `\n${SUITES.length} suítes — tudo passou.`
    : `\n${falharam} de ${SUITES.length} suítes falharam.`
);

process.exit(falharam === 0 ? 0 : 1);
