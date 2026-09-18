#!/usr/bin/env node
/**
 * SAN CHECKOUT — scripts/expurgo.mjs
 *
 * A mão do operador na rotina de expurgo de dado pessoal. A regra mora
 * em `src/services/expurgoService.js` — aqui é só a porta de linha de
 * comando, e ela existe por dois motivos que o ciclo automático de 24 h
 * não atende:
 *
 *   1. VER ANTES. O ciclo automático roda calado. Este script mostra o
 *      que ele faria, linha por tabela, sem escrever nada.
 *   2. O PEDIDO DO TITULAR (LGPD art. 18). Um pedido de exclusão chega
 *      por e-mail (`juridico@`) e é atendido caso a caso — precisa de
 *      alguém executando, com o documento em mão.
 *
 * Uso:
 *   npm run expurgo                                   # o prazo, só mostra
 *   npm run expurgo -- --apagar                       # o prazo, de verdade
 *   npm run expurgo -- --titular 552.085.198-01       # um pedido, só mostra
 *   npm run expurgo -- --titular 552.085.198-01 --apagar
 *
 * O padrão é NÃO escrever. Anonimizar é irreversível sobre a tabela do
 * dinheiro, e um script que escreve por padrão é um acidente esperando a
 * hora — a mesma escolha de `limpar-registros-de-teste.mjs`.
 *
 * ⚠️ Precisa de SUPABASE_URL e SUPABASE_SERVICE_KEY (o mesmo par que o
 * servidor usa), porque reaproveita o cliente do serviço em vez de abrir
 * um caminho novo até o banco. Rodar de dentro do contêiner de produção
 * é o jeito de não copiar a chave para lugar nenhum.
 */

import { expurgarDadoPessoal, expurgarDadoPessoalDoTitular, ANOS_DE_RETENCAO, dataDeCorte } from '../src/services/expurgoService.js';

const APAGAR = process.argv.includes('--apagar');
const iTitular = process.argv.indexOf('--titular');
const TITULAR = iTitular === -1 ? null : process.argv[iTitular + 1];

if (iTitular !== -1 && !TITULAR) {
  console.error('--titular precisa do CPF ou CNPJ em seguida.');
  process.exit(1);
}

function mostrar(relatorios) {
  for (const r of relatorios) {
    console.log(`\n  ${r.tabela}`);
    console.log(`    examinadas .............. ${r.examinadas}`);
    console.log(`    a anonimizar ............ ${r.anonimizadas}  (${r.campos} campos)`);
    if (r.retidasPelaGuardaFiscal !== undefined) {
      console.log(`    retidas pela guarda ..... ${r.retidasPelaGuardaFiscal}` +
        (r.liberamEm ? `  (a última libera em ${r.liberamEm.slice(0, 10)})` : ''));
    }
    if (r.assinaturasVivas?.length) {
      console.log(`    assinaturas NÃO expurgadas porque ainda estão vivas:`);
      for (const a of r.assinaturasVivas) console.log(`      ${a.id} (${a.status})`);
      console.log(`    → o documento é a chave de cancelamento delas (API.md §5.5).`);
      console.log(`      Cancelar por conta própria seria decidir por outra pessoa`);
      console.log(`      algo com consequência financeira: peça o cancelamento ao`);
      console.log(`      titular, e o expurgo alcança na rodada seguinte.`);
    }
    for (const e of r.erros ?? []) console.log(`    ERRO: ${e}`);
  }
}

const corte = dataDeCorte().toISOString().slice(0, 10);

if (TITULAR) {
  console.log(`\nPedido do titular (LGPD art. 18) — documento informado, retenção de ${ANOS_DE_RETENCAO} anos.`);
  console.log(`Só o que é anterior a ${corte} pode ser anonimizado agora.`);
  console.log(APAGAR ? '\nMODO REAL: vai escrever.' : '\nSIMULAÇÃO: nada será escrito. Use --apagar para valer.');
  /* Documento inválido é erro de quem digitou, não defeito — merece uma
     linha, não uma pilha. Quem roda isto está atendendo um pedido de
     titular, possivelmente com prazo correndo, e não precisa decifrar
     rastro de exceção para descobrir que errou um dígito. */
  try {
    mostrar(await expurgarDadoPessoalDoTitular(TITULAR, { simular: !APAGAR }));
  } catch (erro) {
    console.error(`\n  ${erro.message}\n`);
    process.exit(1);
  }
} else {
  console.log(`\nExpurgo por PRAZO — ${ANOS_DE_RETENCAO} anos, corte em ${corte}.`);
  console.log(APAGAR ? '\nMODO REAL: vai escrever.' : '\nSIMULAÇÃO: nada será escrito. Use --apagar para valer.');
  mostrar(await expurgarDadoPessoal({ simular: !APAGAR }));
}

console.log('');
