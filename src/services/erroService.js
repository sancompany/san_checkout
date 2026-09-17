/**
 * SAN CHECKOUT — src/services/erroService.js
 *
 * A captura de exceção que a Lei 8 exige, sem depender de conta em
 * serviço externo. Grava em `erros` (migration 0007), agregando por
 * impressão digital.
 *
 * ── A regra que atravessa este arquivo ───────────────────────────────
 * `CONSTRAINTS.md` §2.5 decidiu, para o log do webhook, **lista branca e
 * nunca lista negra, porque lista negra falha aberta — e falhar aberta
 * aqui é CPF no banco**. Vale igual aqui. Por isso o que se grava é uma
 * lista fechada de campos, e nenhum deles é corpo, query, cabeçalho, IP
 * ou URL com valores.
 *
 * Sobra um campo de texto livre — a mensagem do erro — e ele é o único
 * ponto onde lista branca não se aplica, porque mensagem é livre por
 * natureza. A saída não foi enumerar o que remover (isso seria a lista
 * negra que a regra proíbe), foi enumerar o que SOBREVIVE: letras,
 * pontuação e números curtos. Ver `rasparMensagem`.
 */

import { createHash } from 'node:crypto';
import { supabase } from '../config/supabase.js';

const TAMANHO_MAXIMO_DA_MENSAGEM = 300;
const QUADROS_DE_PILHA = 4;
const DIAS_DE_RETENCAO = 30;

/**
 * Raspa a mensagem do erro.
 *
 * **O que identifica uma pessoa é número:** CPF, CNPJ, telefone, CEP,
 * cartão, id de cobrança. O que se usa para depurar é palavra: nome de
 * restrição, tipo de erro, texto de biblioteca. Então a regra não é
 * "remova CPF" (lista negra, que falha aberta no formato que ninguém
 * previu) — é **toda sequência de 4+ dígitos sai**, junto de e-mail,
 * token longo e query string.
 *
 * Um CPF não sobrevive escrito de jeito nenhum: com ponto, com traço,
 * colado, quebrado por espaço. O que sobrevive é
 * `duplicate key value violates unique constraint "cobrancas_charge_id_key"`,
 * que é exatamente o que se quer ler às duas da manhã.
 *
 * O código numérico do erro (`23505`) é preservado à parte, em `codigo`,
 * justamente porque aqui ele seria raspado — e é dado útil.
 */
export function rasparMensagem(mensagem) {
  if (typeof mensagem !== 'string') return null;

  return mensagem
    // e-mail inteiro, antes de qualquer outra coisa (tem dígito dentro)
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, '[email]')
    // query string: o valor pode ser token, documento, qualquer coisa
    .replace(/\?[^\s]*/g, '?[...]')
    /* Credencial: corrida longa de alfanumérico QUE CONTÉM DÍGITO.
       O dígito é o que separa segredo de identificador. Sem ele esta
       regra comia `cobrancas_charge_id_key` — 23 caracteres, nenhum
       segredo, e exatamente o que se lê para depurar. Chave de API e id
       da Asaas têm dígito; nome de restrição, de índice e de coluna
       não. */
    .replace(/\b(?=[A-Za-z0-9_-]{20,}\b)(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g, '[token]')
    // QUALQUER número de 4+ dígitos, mesmo pontuado — é aqui que CPF,
    // CNPJ, telefone, CEP e cartão morrem, em qualquer formatação
    .replace(/\d[\d.\-/\s]{2,}\d/g, (t) => (/\d[\d.\-/\s]*\d/.test(t) && t.replace(/\D/g, '').length >= 4 ? '[num]' : t))
    .slice(0, TAMANHO_MAXIMO_DA_MENSAGEM);
}

/**
 * Só os quadros do nosso `src/`, e só `arquivo:linha`.
 *
 * Quadro de `node_modules` e do runtime não diz onde É o nosso bug, e
 * caminho absoluto entrega a árvore do servidor. O primeiro quadro que
 * sobra é o que entra na impressão digital.
 */
export function pilhaNossa(erro) {
  if (typeof erro?.stack !== 'string') return null;

  const quadros = erro.stack
    .split('\n')
    .map((linha) => /\/(src\/[^):\s]+):(\d+):\d+/.exec(linha))
    .filter(Boolean)
    .map((m) => `${m[1]}:${m[2]}`);

  return quadros.length ? quadros.slice(0, QUADROS_DE_PILHA).join(' < ') : null;
}

/**
 * A chave de agregação: contexto + tipo + primeiro quadro nosso.
 *
 * Não entra a mensagem — se entrasse, o mesmo bug com um id diferente na
 * mensagem viraria linha nova, e a tabela voltaria a crescer por
 * requisição, que é justamente o que a agregação existe para impedir.
 */
export function impressaoDigital({ contexto, nome, pilha }) {
  return createHash('sha256')
    .update(`${contexto ?? '-'}|${nome ?? '-'}|${pilha ?? '-'}`)
    .digest('hex')
    .slice(0, 32);
}

/** O que vai para o banco, montado e raspado — exportado para o autoteste
 *  poder afirmar sobre a linha sem precisar de banco. */
export function montarLinha(erro, { contexto, rota, metodo, status } = {}) {
  const pilha = pilhaNossa(erro);
  const nome = erro?.name ?? typeof erro;

  return {
    impressao_digital: impressaoDigital({ contexto, nome, pilha }),
    contexto: String(contexto ?? 'desconhecido').slice(0, 120),
    // `rota` é o PADRÃO do Express (req.route.path), nunca originalUrl.
    // Quem chama é responsável por isso, e o autoteste trava a regra.
    rota: rota ? String(rota).slice(0, 200) : null,
    metodo: metodo ? String(metodo).slice(0, 10) : null,
    status: Number.isInteger(status) ? status : null,
    nome: String(nome).slice(0, 80),
    codigo: erro?.code != null ? String(erro.code).slice(0, 40) : null,
    mensagem: rasparMensagem(erro?.message),
    pilha
  };
}

/**
 * Grava, agregando. Nunca lança e nunca é aguardada por quem responde:
 * a mesma regra da auditoria do webhook (§2.5) — capturar erro não pode
 * virar a causa do próximo.
 */
export async function registrarErro(erro, contextoDaRequisicao = {}) {
  try {
    const linha = montarLinha(erro, contextoDaRequisicao);

    // Upsert com incremento. `ocorrencias` não pode ser escrito pelo
    // cliente do Supabase num upsert comum (ele sobrescreveria com 1),
    // então o incremento é uma função no banco.
    const { error } = await supabase.rpc('registrar_erro', {
      p_impressao: linha.impressao_digital,
      p_contexto: linha.contexto,
      p_rota: linha.rota,
      p_metodo: linha.metodo,
      p_status: linha.status,
      p_nome: linha.nome,
      p_codigo: linha.codigo,
      p_mensagem: linha.mensagem,
      p_pilha: linha.pilha
    });

    if (error) console.error('[erroService.registrarErro]', error.message);
  } catch (falha) {
    // Engolido de propósito: se a captura de erro derrubar a requisição,
    // ela deixou de ser observabilidade e virou o defeito.
    console.error('[erroService.registrarErro] falhou em silêncio:', falha.message);
  }
}

export async function listarErros({ limite = 50 } = {}) {
  const { data, error } = await supabase
    .from('erros')
    .select('*')
    .order('ultima_vez', { ascending: false })
    .limit(Math.min(Number(limite) || 50, 200));

  if (error) throw error;
  return data ?? [];
}

/** Retenção de 30 dias — diagnóstico não herda os 5 anos do dado de
 *  cobrança nem os 90 dias da auditoria do webhook. */
export async function expurgarErros() {
  const corte = new Date(Date.now() - DIAS_DE_RETENCAO * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from('erros').delete().lt('ultima_vez', corte);
  if (error) console.error('[erroService.expurgarErros]', error.message);
}

/* ------------------------------------------------------------------
   Autoteste — `node src/services/erroService.js`
   Roda junto com os outros em `npm test`.

   A regra que este teste existe para travar é a do `CONSTRAINTS.md`
   §2.5: **nada de pessoa entra no log de diagnóstico.** A mensagem do
   erro é o único texto livre que se grava, e é por onde CPF, e-mail e
   telefone entrariam — vindos de erro do Postgres (que cita valores),
   da Asaas (que ecoa entrada) ou de uma URL com query.
------------------------------------------------------------------ */
if (process.argv[1]?.endsWith('erroService.js')) {
  const { strict: assert } = await import('node:assert');

  let checagens = 0;
  const conferir = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };

  /* --- 1. nenhum formato de CPF sobrevive --- */
  const CPF = '552.085.198-01';
  for (const forma of ['55208519801', '552.085.198-01', '552 085 198 01', '552085198-01']) {
    const raspado = rasparMensagem(`duplicate key (documento)=(${forma}) already exists`);
    conferir(
      !raspado.includes(forma) && !/\d{4,}/.test(raspado.replace(/\D/g, '').slice(0, 99) ? raspado : ''),
      `CPF escrito como "${forma}" sobreviveu: ${raspado}`
    );
    conferir(raspado.includes('duplicate key'), 'o que se depura tem que sobreviver');
  }
  conferir(!rasparMensagem(`erro com ${CPF}`).match(/\d{4}/), 'nenhuma corrida de 4+ dígitos sobrevive');

  /* --- 2. e-mail, telefone, CEP, token --- */
  const casos = [
    ['falha ao notificar joao.silva+tag@empresa.com.br', 'joao.silva', '[email]'],
    ['telefone 11987654321 inválido', '11987654321', '[num]'],
    ['cep 04567-000 não encontrado', '04567-000', '[num]'],
    ['GET https://api.asaas.com/v3/x?access_token=abc123', 'access_token', '?[...]'],
    ['chave d1711163f450f3fda3bee4ae93fc731cc45b557c recusada', 'd1711163f450', '[token]']
  ];
  for (const [entrada, proibido, esperado] of casos) {
    const raspado = rasparMensagem(entrada);
    conferir(!raspado.includes(proibido), `"${proibido}" sobreviveu em: ${raspado}`);
    conferir(raspado.includes(esperado), `esperava ${esperado} em: ${raspado}`);
  }

  /* --- 3. o que é útil para depurar continua legível --- */
  const util = rasparMensagem('duplicate key value violates unique constraint "cobrancas_charge_id_key"');
  conferir(
    util.includes('unique constraint') && util.includes('cobrancas_charge_id_key'),
    `nome de restrição tem que sobreviver inteiro: ${util}`
  );

  /* --- 4. a pilha só traz nosso código, sem caminho absoluto --- */
  const erro = new Error('qualquer');
  erro.stack = [
    'Error: qualquer',
    '    at consultarAssinatura (/home/user/san_checkout/src/controllers/cobrancaConsultaController.js:288:11)',
    '    at /home/user/san_checkout/node_modules/express/lib/router/route.js:149:13',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)'
  ].join('\n');
  const pilha = pilhaNossa(erro);
  conferir(pilha === 'src/controllers/cobrancaConsultaController.js:288', `pilha inesperada: ${pilha}`);
  conferir(!pilha.includes('/home/user'), 'caminho absoluto entrega a árvore do servidor');
  conferir(!pilha.includes('node_modules'), 'quadro de dependência não diz onde é o nosso bug');

  /* --- 5. a impressão digital agrupa o MESMO bug e separa bugs diferentes --- */
  const base = { contexto: 'consulta.x', nome: 'TypeError', pilha: 'src/a.js:10' };
  conferir(
    impressaoDigital(base) === impressaoDigital({ ...base }),
    'mesmo erro tem que cair na mesma linha, senão a tabela cresce por requisição'
  );
  conferir(
    impressaoDigital(base) !== impressaoDigital({ ...base, pilha: 'src/b.js:10' }),
    'bugs em lugares diferentes não podem se fundir'
  );

  /* E a mesma propriedade pela porta que a produção usa — `montarLinha`.
     Testar só `impressaoDigital` direto deixava passar a versão em que a
     MENSAGEM entra na chave: aí o mesmo bug com outro id no texto vira
     linha nova, e a tabela volta a crescer por requisição, que é a única
     coisa que a agregação existe para impedir. */
  const mesmoBug = (documento) => {
    const e = new Error(`duplicate key (documento)=(${documento}) already exists`);
    e.stack = `Error: x\n    at f (/app/src/services/cobrancaService.js:77:9)`;
    return montarLinha(e, { contexto: 'webhook.ciclo', metodo: 'POST', status: 500 });
  };
  conferir(
    mesmoBug('11122233344').impressao_digital === mesmoBug('99988877766').impressao_digital,
    'o MESMO bug com outro valor na mensagem tem que cair na MESMA linha'
  );

  /* --- 6. a linha montada não tem campo fora da lista branca --- */
  const linha = montarLinha(
    Object.assign(new Error('erro em 55208519801'), { code: '23505' }),
    { contexto: 'teste', rota: '/api/checkout/status/:contratanteId/:pedidoId', metodo: 'GET', status: 500 }
  );
  const PERMITIDOS = ['impressao_digital', 'contexto', 'rota', 'metodo', 'status', 'nome', 'codigo', 'mensagem', 'pilha'];
  for (const campo of Object.keys(linha)) {
    conferir(PERMITIDOS.includes(campo), `campo fora da lista branca: ${campo}`);
  }
  conferir(!linha.mensagem.includes('55208519801'), 'a mensagem gravada não pode carregar documento');
  conferir(linha.codigo === '23505', 'o código do erro é preservado à parte — seria raspado na mensagem');
  conferir(
    linha.rota.includes(':pedidoId') && !/\d{4,}/.test(linha.rota),
    'rota tem que ser o PADRÃO, nunca a URL com o pedidoId real'
  );

  /* --- 7. a volta completa por um Express de verdade ---------------
     Os testes acima afirmam sobre `montarLinha`. Este afirma sobre o
     MECANISMO: `responderErro` tira a rota de `resposta.req`, e se isso
     um dia vier `undefined` (troca de versão do Express, middleware
     novo, rota montada de outro jeito), o contexto viraria `null` em
     silêncio — captura sem contexto, que é metade de nada.

     E trava a propriedade que importa mais: o `pedidoId` da URL real
     NUNCA pode aparecer na linha gravada. Ele é imprevisível por
     desenho, logo é credencial. */
  const { default: express } = await import('express');

  const capturadas = [];
  const app = express();
  const rotas = express.Router();
  rotas.get('/status/:contratanteId/:pedidoId', (requisicao, resposta) => {
    const r = resposta.req;
    capturadas.push(montarLinha(new Error('falhou'), {
      contexto: 'consulta.statusPublico',
      rota: r?.route?.path ? `${r.baseUrl ?? ''}${r.route.path}` : null,
      metodo: r?.method,
      status: 502
    }));
    resposta.status(502).json({ erro: 'generico' });
  });
  app.use('/api/checkout', rotas);

  const servidor = app.listen(0);
  await new Promise((ok) => servidor.once('listening', ok));
  /* Valor de fixture, deliberadamente reconhecível como fixture.
     A primeira versão chamava isto de `pedidoDaFixture` e usava uma
     string de alta entropia — nome com "secreto" guardando valor
     aleatório é a assinatura de uma credencial, e o `gitleaks` do CI
     barrou o merge por isso (regra `generic-api-key`). Ele estava
     certo: quem varre segredo não adivinha intenção, e um teste não
     vale enfraquecer o scanner. O que o teste precisa é de um valor que
     apareceria na URL e não pode vazar para a linha gravada — e um
     valor obviamente falso entrega isso igual. */
  const pedidoDaFixture = 'ped-fixture-a11y-nao-e-credencial';
  // Com teto, como toda chamada de saída deste `src/` — inclusive esta,
  // que fala com localhost. `tests/nenhuma-chamada-de-saida-sem-teto.js`
  // varre o diretório inteiro e pegou este `fetch` quando ele nasceu sem
  // `signal`: a guarda vale para o arquivo, não para a produção só, e
  // abrir exceção para "código de teste" abriria a porta para código de
  // produção dentro deste bloco (`CONSTRAINTS.md` §2.7.1).
  const controlador = new AbortController();
  const teto = setTimeout(() => controlador.abort(), 5000);
  try {
    await fetch(
      `http://127.0.0.1:${servidor.address().port}/api/checkout/status/mostrai/${pedidoDaFixture}`,
      { signal: controlador.signal }
    );
  } finally {
    clearTimeout(teto);
    servidor.close();
  }

  const gravada = capturadas[0];
  conferir(gravada !== undefined, 'a requisição real tem que produzir uma linha');
  conferir(
    gravada.rota === '/api/checkout/status/:contratanteId/:pedidoId',
    `a rota gravada tem que ser o padrão montado, veio "${gravada.rota}"`
  );
  conferir(
    !JSON.stringify(gravada).includes(pedidoDaFixture),
    'o pedidoId da URL real NÃO pode aparecer em campo nenhum da linha'
  );
  conferir(gravada.metodo === 'GET', 'o método tem que sair de resposta.req');

  /* --- 8. entrada esquisita não estoura --- */
  conferir(rasparMensagem(undefined) === null, 'mensagem ausente vira null, não explode');
  conferir(montarLinha({}).nome === 'object', 'erro que não é Error ainda vira linha');
  conferir(pilhaNossa({}) === null, 'sem pilha devolve null');

  console.log(`erroService: ${checagens} checagens OK`);
}
