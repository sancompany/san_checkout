#!/usr/bin/env node
/**
 * scripts/gerar-hash-admin.js
 *
 * Gera o valor de CHECKOUT_ADMIN_PASS_HASH a partir de uma senha.
 * Manutenção, não lógica de negócio (Lei 1).
 *
 *   node scripts/gerar-hash-admin.js
 *
 * A senha é digitada no prompt e NÃO aparece na tela nem no histórico do
 * shell — por isso não é argumento de linha de comando. Ela também não
 * sai daqui: o script imprime só o hash.
 */

import { createInterface } from 'node:readline';
import { gerarHashSenha } from '../src/utils/senhaAdmin.js';

const PERGUNTA = 'Senha do admin (não aparece na tela): ';

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

// ponytail: mexe em `_writeToOutput`, que é API interna do readline —
// é o jeito de esconder o que é digitado sem trazer dependência nova
// pra um script que roda uma vez. Se quebrar numa versão futura do
// Node, o pior caso é a senha aparecer na tela: troque por uma
// biblioteca de prompt, ou rode num terminal que ninguém está olhando.
rl._writeToOutput = (texto) => {
  if (texto.includes(PERGUNTA)) rl.output.write(PERGUNTA);
  else if (texto === '\n' || texto === '\r\n') rl.output.write(texto);
};

rl.question(PERGUNTA, async (senha) => {
  rl.close();
  console.log();

  if (!senha || senha.length < 12) {
    console.error('\nSenha muito curta. Use pelo menos 12 caracteres — este hash protege o painel que lê a chave de todos os contratantes.');
    process.exit(1);
  }

  console.log('Cole isto na variável de ambiente CHECKOUT_ADMIN_PASS_HASH:\n');
  console.log(await gerarHashSenha(senha));
  console.log('\nDepois REMOVA a variável antiga CHECKOUT_ADMIN_PASS — ela não é mais lida,');
  console.log('e senha em texto puro parada no painel do Northflank não protege nada.');
});
