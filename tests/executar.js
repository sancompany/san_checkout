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
  'src/utils/accessJwt.js',          // o JWT do Cloudflare Access: assinatura RS256, aud do painel, iss da equipe, type app (SEC-015)
  'src/services/auditoriaWebhookService.js', // redação do log: nenhum dado de pessoa sobrevive
  'src/services/erroService.js',     // captura de exceção: nenhum dado de pessoa entra no diagnóstico
  'src/utils/diaCivil.js',           // dia civil de Brasília decidido no servidor (guarda do ICU)
  'src/utils/dinheiro.js',           // centavos inteiros: `Number('')`/`Number(null)` nunca viram zero (M-05)
  'src/utils/ciclos.js',             // a camada canônica de ciclos: mensal/3/QUARTERLY são o mesmo ciclo, e nada cai em MONTHLY por omissão (M-10)
  'src/services/transicoesFinanceiras.js', // a máquina de estados: CONFIRMED atrasado nunca desfaz um estorno (C-03)
  'src/services/webhookInboxService.js',   // a inbox: corpo mínimo sem pessoa, idempotência por id do evento (C-01)
  'src/services/outboxService.js',         // a outbox: entrega assinada, id único, recuo finito (H-01)
  'src/utils/passadas.js',                 // uma passada de worker por vez: o tique seguinte não atropela a anterior (SEC-023)
  'src/services/cotacaoService.js',        // a cotação: o retrato do preço mostrado, comparado em centavos (C-02)
  'src/services/reconciliacaoService.js',  // reserva órfã que virou cobrança na Asaas é completada, nunca liberada (H-06)
  'src/services/irmasObsoletasService.js', // irmã de pedido pago: lê a Asaas antes de excluir, nunca exclui o que está pago (RN-51)
  'src/services/metricaService.js',  // a conta da métrica: por dia de confirmação, não por 24h
  'src/services/proporcionalService.js', // o acerto da troca de plano: as sete regras do dono, em aritmética
  'src/services/classificacaoFinanceiraService.js', // veredito único PAID/DECLINED_FINAL/UNKNOWN — status ambíguo nunca é recusa por suposição
  'src/services/trocaIntencaoService.js', // TTL da aprovação: 15 min ou a virada do dia civil, o que vier primeiro
  'src/services/trocaExecucaoService.js', // a coreografia da aprovação: cobra→classifica→aplica, nunca cobra duas vezes
  'src/services/trocaSweeperService.js', // a rede de segurança: reclassifica, retoma, escalona depois de N tentativas
  'src/controllers/trocaAprovacaoController.js', // /troca/contexto e /troca/aprovar: mapeamento estado→HTTP, nunca vaza cartão/documento
  'src/services/expurgoService.js',  // expurgo de dado pessoal: lista branca do que fica, e o piso do prazo
  'src/controllers/webhookController.js', // caminho crítico do webhook: guarda, mapa de status, soma de taxas
  'src/controllers/cobrancaConsultaController.js', // conciliação: cancelada vem do `deleted`, ciclo vem da Asaas
  'src/controllers/trocaPlanoController.js', // troca de plano: cobra o acerto ANTES de alterar, e relê o que a Asaas fez
  'src/controllers/checkoutController.js', // Pix/Boleto: reserva ANTES de cobrar — fecha a corrida de cobrança duplicada na Asaas
  'src/controllers/refundController.js', // estorno: reivindica ANTES de chamar a Asaas — fecha a corrida de estorno duplicado
  'tests/estorno-repetido-nao-devolve-duas-vezes.js', // CR-02: resposta perdida + repetição devolviam o dinheiro duas vezes (SEC-002)
  'src/controllers/assinaturaController.js', // cancelar/pausar/retomar: mesmo arrendamento da troca de plano — fecha a corrida entre as quatro operações
  'tests/valor-vem-do-servidor.js',  // o corpo da requisição nunca dita quanto se cobra
  'tests/sem-consulta-repetida.js',  // nenhuma ida ao banco repetida no caminho do dinheiro
  'tests/senha-nao-fica-no-navegador.js', // a senha do admin não sobrevive ao login
  'tests/total-nao-confiavel-nao-vira-tela-compravel.js', // total que não se cobra não vira tela com botão
  'tests/retorno-nao-vira-open-redirect.js', // returnUrl: quem decide o destino é o servidor, e continua sendo
  'tests/nenhuma-chamada-de-saida-sem-teto.js', // fetch sem signal espera para sempre: varre src/ inteiro
  'tests/data-para-asaas-e-de-brasilia.js', // vencimento em UTC adiou o 1º ciclo da assinatura real (25/09): varre src/ inteiro
  'tests/sessao-concluida-nao-e-pagamento.js', // CHECKOUT_PAID com o 1º ciclo PENDING virou "Assinatura Ativa" (25/09)
  'tests/telefone-com-codigo-do-pais.js', // autopreenchimento +55 virava DDD 55: front e servidor com a mesma regra (25/09)
  'tests/pedido-pago-nao-cobra-de-novo.js', // contratante esqueceu o pago e o pedido reabriu: o NOSSO banco também decide (25/09)
  'tests/pagamento-de-um-pedido-invalida-as-irmas.js', // pago no cartão, o Pix/boleto antigo deixa de ser pagável; dois pagos = duplicidade marcada (RN-51/52)
  'tests/instrumento-obsoleto-nunca-volta.js', // CR-03: pop-up de outro preço/parcela reaproveitada; "a cobrança do pedido" era a mais recente (SEC-004/005)
  'tests/assinatura-pausada-continua-cancelavel.js', // pausar não pode ser porta de mão única
  'tests/renovacao-exige-token-nao-so-documento.js', // renovar não pode confiar só no documento do body
  'tests/piso-de-valor-recusa-antes-de-cobrar.js', // a Asaas recusa abaixo de R$ 5,00: recusar aqui, não no clique
  'tests/pull-nao-segue-para-onde-quiser.js', // a resposta do contratante não pode virar o alvo (SSRF) nem encher a memória
  'tests/saida-nunca-segue-redirecionamento.js', // CR-04: a outbox seguia 307 levando CPF e assinatura para dentro (SEC-006/021)
  'tests/identificador-canonico-em-toda-fronteira.js', // CR-01: `../` e `%2F` num id viravam outro caminho autenticado (SEC-001/003/017/026)
  'tests/webhook-confere-na-asaas.js', // CR-05: o corpo do evento confirmava dinheiro; estorno antes da confirmação era descartado (SEC-007/008/019, JULES-004)
  'tests/acerto-de-troca-nunca-fica-orfao.js', // CR-02: processo morto entre cobrar o acerto e gravar o charge_id deixava a troca órfã para sempre (SEC-009/010)
  'tests/nenhuma-promessa-sem-dono.js', // CR-06: aviso sem await nem catch derrubava o processo (SEC-013) — varre src/ inteiro
  'tests/uma-assinatura-viva-por-plano.js', // CR-08: reabrir o link do plano abria uma SEGUNDA assinatura no mesmo cartão (SEC-012)
  'tests/assinatura-nasce-inteira.js', // CR-06/08: falha de banco na 1ª confirmação deixava a assinatura órfã, e o 1º ciclo recusado a deixava invisível (SEC-014/011)
  'tests/rotas-http-respondem-como-prometido.js', // a pilha do Express montada de verdade: login por token, guarda, teto, 404
  'tests/admin-so-pelo-access.js', // CR-09: a API do admin respondia a quem chamasse a origem direto, sem o Access (SEC-015)
  'tests/escrita-de-estado-e-condicional.js', // CR-07: conciliação, liberação de reserva e Pix Automático gravavam por cima de um estorno (SEC-020/022/025)
  'tests/erro-da-asaas-nao-vaza.js', // CR-12: a descrição da Asaas ia crua ao log, e o 401 dela (a NOSSA chave) chegava ao contratante como se fosse a dele (SEC-028, INFO-11)
  'tests/ci-so-le-e-fixa-o-que-roda.js', // CR-13: CI sem `permissions:`, gitleaks baixado sem checksum, imagem pela `latest` (SEC-034)
  'tests/sessao-de-assinatura-nao-vaza-por-cpf.js', // NEW-02: com o CPF de alguém, a rota pública entregava a sessão pendente dele — preenchida com nome, e-mail, telefone e endereço
  'tests/filtro-or-so-interpola-o-que-o-servidor-fez.js', // CR-01/JX-01: valor de fora num .or() do PostgREST é filtro, não valor — varre src/ inteiro
  'tests/banco-sem-privilegio-publico.js', // CR-09: a chave PÚBLICA do Supabase tinha tudo nas 12 tabelas, TRUNCATE incluído (INFO-13) — varre as migrations
  'tests/rota-que-lanca-nao-derruba-o-processo.js', // C1-01: handler async do Express 4 que lança derrubava o processo — um JWT com `alg` objeto bastava, sem login
  'tests/documento-e-uma-chave-so.js', // CPF pontuado e CPF em dígitos não podem ser duas chaves para a mesma pessoa
  'tests/toda-rota-publica-tem-teto.js', // lição nº 23: a lista de rotas limitadas contra a lista de rotas montadas
  'tests/o-processo-nao-morre-calado.js', // queda por rejeição/exceção não deixava linha nenhuma em `erros` (Lei 8)
  'tests/nome-do-item-nao-passa-do-teto-da-asaas.js', // items[].name > 30 caracteres quebrava Cartão/Assinatura por inteiro
  'tests/rodape-nao-cita-identidade-antiga.js', // reidentificação pra CPF (17/09) não tocou o rodapé das telas
  'tests/popup-fecha-ao-confirmar.js', // pop-up da Asaas ficava aberta pra sempre depois do pagamento
  'tests/dez-cliques-uma-sessao.js',   // C-04: dez requisições simultâneas, UMA sessão/cobrança na Asaas
  'tests/cliente-asaas-uma-vez-por-documento.js', // H-05: dez requisições simultâneas, UM cliente na Asaas
  'tests/outbox-sobrevive-a-reinicio.js', // H-01: o aviso ao contratante sobrevive à morte do processo (dois processos de verdade)
  'tests/segredo-nao-sai-do-admin.js'  // H-08: api_key inteira só na criação/rotação; listagem leva os 4 últimos
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
