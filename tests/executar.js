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
  'tests/ajudantes.js',              // os ajudantes das suítes também são código, e um já teve bug
  'tests/o-que-os-documentos-afirmam.js', // os números que os documentos afirmam, conferidos contra a realidade
  'src/utils/validadores.js',        // tetos de campo e comparação de credencial
  'src/utils/alvoDeRede.js',         // https + host público para alvo de saída (anti-SSRF)
  'src/utils/retornoSeguro.js',      // returnUrl: allowlist por origem (anti open redirect)
  'src/utils/assinaturaWebhook.js',  // assinatura HMAC do webhook de saída
  'src/utils/tokenRenovacao.js',     // token de renovação: só quem tem a api_key forja
  'src/services/taxaService.js',     // conversão das taxas da Asaas
  'src/services/pedidoService.js',   // id imprevisível e método habilitado
  'src/utils/chaveContratante.js',   // a api_key: tamanho, formato, e não repetir
  'src/utils/senhaAdmin.js',         // hash da senha do admin (scrypt)
  'src/utils/sessaoAdmin.js',        // token de sessão do admin: forja, adulteração, validade
  'src/services/auditoriaWebhookService.js', // redação do log: nenhum dado de pessoa sobrevive
  'src/services/erroService.js',     // captura de exceção: nenhum dado de pessoa entra no diagnóstico
  'src/utils/diaCivil.js',           // dia civil de Brasília decidido no servidor (guarda do ICU)
  'src/services/metricaService.js',  // a conta da métrica: por dia de confirmação, não por 24h
  'src/services/proporcionalService.js', // o acerto da troca de plano: as sete regras do dono, em aritmética
  'src/services/expurgoService.js',  // expurgo de dado pessoal: lista branca do que fica, e o piso do prazo
  'src/controllers/webhookController.js', // caminho crítico do webhook: guarda, mapa de status, soma de taxas
  'src/controllers/cobrancaConsultaController.js', // conciliação: cancelada vem do `deleted`, ciclo vem da Asaas
  'src/controllers/trocaPlanoController.js', // troca de plano: cobra o acerto ANTES de alterar, e relê o que a Asaas fez
  'tests/valor-vem-do-servidor.js',  // o corpo da requisição nunca dita quanto se cobra
  'tests/sem-consulta-repetida.js',  // nenhuma ida ao banco repetida no caminho do dinheiro
  'tests/senha-nao-fica-no-navegador.js', // a senha do admin não sobrevive ao login
  'tests/total-nao-confiavel-nao-vira-tela-compravel.js', // total que não se cobra não vira tela com botão
  'tests/retorno-nao-vira-open-redirect.js', // returnUrl: quem decide o destino é o servidor, e continua sendo
  'tests/nenhuma-chamada-de-saida-sem-teto.js', // fetch sem signal espera para sempre: varre src/ inteiro
  'tests/assinatura-pausada-continua-cancelavel.js', // pausar não pode ser porta de mão única
  'tests/renovacao-exige-token-nao-so-documento.js', // renovar não pode confiar só no documento do body
  'tests/piso-de-valor-recusa-antes-de-cobrar.js', // a Asaas recusa abaixo de R$ 5,00: recusar aqui, não no clique
  'tests/pull-nao-segue-para-onde-quiser.js', // a resposta do contratante não pode virar o alvo (SSRF) nem encher a memória
  'tests/rotas-http-respondem-como-prometido.js', // a pilha do Express montada de verdade: login por token, guarda, teto, 404
  'tests/documento-e-uma-chave-so.js', // CPF pontuado e CPF em dígitos não podem ser duas chaves para a mesma pessoa
  'tests/toda-rota-publica-tem-teto.js', // lição nº 23: a lista de rotas limitadas contra a lista de rotas montadas
  'tests/o-processo-nao-morre-calado.js' // queda por rejeição/exceção não deixava linha nenhuma em `erros` (Lei 8)
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
