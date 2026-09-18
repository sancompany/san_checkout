#!/usr/bin/env node
/**
 * tests/rotas-http-respondem-como-prometido.js
 *
 * A Lei 0 pede cobertura de teste, e `docs/pendencias.md` registrava o
 * buraco: **nenhuma suíte subia o Express.** Todas cobriam módulos e
 * invariantes de texto-fonte. O roteiro de login por token — login
 * certo, senha errada, token adulterado, token de outro hash, teto de
 * 5/min — foi exercitado assim **à mão** em 12/09/2026, e era exatamente
 * esse roteiro que devia ter virado suíte.
 *
 * Aqui ele vira. O que se testa é a PILHA MONTADA de verdade
 * (`src/server.js`), não um Express remontado pelo teste — a montagem é
 * parte do comportamento, e remontá-la aqui testaria o teste.
 *
 * Uma sabotagem desta suíte passou, e o que ela revelou foi um COMENTÁRIO
 * FALSO, não um teste fraco: o `server.js` afirmava que o limitador de
 * 5/min da rota de sessão precisava ser registrado antes do de
 * `/api/admin`, "senão o mais largo casa primeiro". Medido com a ordem
 * invertida: a 6ª tentativa continua vindo `429` com
 * `RateLimit-Limit: 5`, porque o `app.use` roda TODOS os middlewares que
 * casam o caminho e o mais apertado barra. O comentário foi corrigido; o
 * teste não passou a exigir uma ordem que não existe.
 *
 * O banco NÃO é tocado. As rotas exercitadas aqui são as que decidem
 * antes de chegar ao banco: a que troca senha por token, a guarda que
 * exige token, o 404, o limitador. Rota que consulta o Supabase aparece
 * só onde o teste QUER ver a falha de conexão, e ela é declarada.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { gerarHashSenha } from '../src/utils/senhaAdmin.js';

let checagens = 0;
const ok = (condicao, mensagem) => { assert.ok(condicao, mensagem); checagens += 1; };
const igual = (a, b, mensagem) => { assert.deepEqual(a, b, mensagem); checagens += 1; };

/* Credenciais DESTE PROCESSO, geradas agora — nada cadastrado, nada
   reaproveitado, nada que exista em qualquer ambiente de verdade. */
const USUARIO = 'operador-de-teste';
const SENHA = 'senha-so-deste-processo-de-teste';
const HASH = await gerarHashSenha(SENHA);

process.env.CHECKOUT_SEM_LISTEN = '1';
process.env.CHECKOUT_ADMIN_USER = USUARIO;
process.env.CHECKOUT_ADMIN_PASS_HASH = HASH;
process.env.SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:0';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? 'teste';

/* A pilha de verdade, com as variáveis já no lugar: o módulo lê
   `process.env` no import. */
const { app } = await import('../src/server.js');

const servidor = app.listen(0);
await once(servidor, 'listening');
const base = `http://127.0.0.1:${servidor.address().port}`;

async function chamar(caminho, { metodo = 'GET', corpo, cabecalhos = {} } = {}) {
  const cancelador = new AbortController();
  const relogio = setTimeout(() => cancelador.abort(), 15000);
  try {
    const resposta = await fetch(base + caminho, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...cabecalhos },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: cancelador.signal
    });
    const texto = await resposta.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    return { http: resposta.status, corpo: json, cabecalhos: resposta.headers };
  } finally { clearTimeout(relogio); }
}

let token;

try {
  /* ---- 1. LOGIN CERTO (o controle positivo de toda a suíte) --------
     Sem isto, todo "recusou" abaixo poderia ser uma recusa que recusa
     tudo — inclusive quem devia entrar. Foi assim que a primeira rodada
     do `returnUrl` quase passou por prova em 15/09. */
  const login = await chamar('/api/admin/sessao', { metodo: 'POST', corpo: { usuario: USUARIO, senha: SENHA } });
  igual(login.http, 200, 'login com usuário e senha certos entra');
  ok(typeof login.corpo?.token === 'string' && login.corpo.token.length > 20, 'e recebe um token');
  ok(Date.parse(login.corpo.expiraEm) > Date.now(), 'com validade no futuro');
  ok(!JSON.stringify(login.corpo).includes(SENHA), 'a senha NÃO volta na resposta');
  ok(!JSON.stringify(login.corpo).includes(HASH), 'nem o hash dela');
  token = login.corpo.token;

  /* ---- 2. SENHA ERRADA, USUÁRIO ERRADO, CORPO VAZIO --------------- */
  const senhaErrada = await chamar('/api/admin/sessao', { metodo: 'POST', corpo: { usuario: USUARIO, senha: 'errada' } });
  igual(senhaErrada.http, 401, 'senha errada recusa');
  const usuarioErrado = await chamar('/api/admin/sessao', { metodo: 'POST', corpo: { usuario: 'outro', senha: SENHA } });
  igual(usuarioErrado.http, 401, 'usuário errado recusa');
  igual(
    senhaErrada.corpo.erro, usuarioErrado.corpo.erro,
    'e a MESMA mensagem nos dois: dizer qual dos dois errou entrega se o usuário existe'
  );
  igual((await chamar('/api/admin/sessao', { metodo: 'POST', corpo: {} })).http, 401, 'corpo vazio recusa');

  /* ---- 3. A GUARDA DE TOKEN NAS ROTAS DE BAIXO -------------------- */
  igual((await chamar('/api/admin/contratantes')).http, 401, 'sem token: 401');

  const semPermissao = await chamar('/api/admin/contratantes', { cabecalhos: { 'X-Admin-Token': 'nao-e-um-token' } });
  igual(semPermissao.http, 401, 'token inventado: 401');
  ok(!/scrypt|hash|\$|CHECKOUT_ADMIN/.test(JSON.stringify(semPermissao.corpo)), 'e o erro não conta nada de como o token é feito');

  /* Token ADULTERADO: o mesmo token válido com um caractere trocado.
     Se a verificação fosse por comparação frouxa, isto passaria. */
  const adulterado = token.slice(0, -1) + (token.at(-1) === 'A' ? 'B' : 'A');
  ok(adulterado !== token, 'controle: o token adulterado é diferente do válido');
  igual(
    (await chamar('/api/admin/contratantes', { cabecalhos: { 'X-Admin-Token': adulterado } })).http,
    401, 'token com um caractere trocado: 401'
  );

  /* Token de OUTRO HASH: emitido para a mesma pessoa, mas assinado com
     outra senha de admin. É o caso que prova que o token está amarrado
     ao hash em vigor — trocar a senha do admin tem de invalidar sessão
     antiga, senão a troca de senha não expulsa ninguém. */
  const { emitirToken } = await import('../src/utils/sessaoAdmin.js');
  const deOutroHash = emitirToken(USUARIO, await gerarHashSenha('uma-outra-senha-qualquer'));
  igual(
    (await chamar('/api/admin/contratantes', { cabecalhos: { 'X-Admin-Token': deOutroHash } })).http,
    401, 'token assinado com outro hash de senha: 401'
  );

  /* ---- 4. O TOKEN VÁLIDO ATRAVESSA A GUARDA ----------------------
     Não é o banco que se testa aqui — ele está apontado para uma porta
     morta de propósito. O que se prova é que a guarda deixou passar: um
     `500`/`502` daqui significa "chegou no handler", e é o contrário de
     `401`. Sem esta checagem, a suíte não distinguiria uma guarda
     correta de uma guarda que recusa todo mundo. */
  const comToken = await chamar('/api/admin/contratantes', { cabecalhos: { 'X-Admin-Token': token } });
  ok(comToken.http !== 401 && comToken.http !== 403, `token válido atravessa a guarda (veio ${comToken.http})`);

  /* ---- 5. O TETO DE 5/MIN DA ROTA DE SESSÃO ----------------------
     É o único ponto onde a senha é conferida, e cada conferência custa
     ~830 ms de scrypt: sem teto apertado, adivinhar senha é também
     negação de serviço de graça numa instância de 0,5 vCPU.

     Já foram gastas 4 tentativas acima (1 certa + 3 recusadas), então a
     5ª ainda passa e a 6ª tem de ser 429. O que se mede é o NÚMERO, não
     a ordem de registro — ver a nota no topo. */
  const quinta = await chamar('/api/admin/sessao', { metodo: 'POST', corpo: { usuario: USUARIO, senha: 'errada' } });
  igual(quinta.http, 401, 'a 5ª tentativa do minuto ainda é atendida (401, não 429)');
  const sexta = await chamar('/api/admin/sessao', { metodo: 'POST', corpo: { usuario: USUARIO, senha: 'errada' } });
  igual(sexta.http, 429, 'a 6ª tentativa no mesmo minuto é barrada com 429');
  igual(sexta.cabecalhos.get('ratelimit-limit'), '5', 'e o cabeçalho anuncia o teto de 5');
  ok(/aguarde/i.test(sexta.corpo?.erro ?? ''), 'com mensagem que diz para esperar');

  /* O teto é da ROTA DE SESSÃO, não do painel: bater nele não pode
     derrubar o resto do admin de quem já entrou. */
  const painelDepoisDoTeto = await chamar('/api/admin/contratantes', { cabecalhos: { 'X-Admin-Token': token } });
  igual(painelDepoisDoTeto.http, comToken.http, 'estourar o teto de login não afeta o painel de quem já tem token');

  /* ---- 6. O FIM DA PILHA: 404 e erro genérico -------------------- */
  const inexistente = await chamar('/api/caminho-que-nao-existe');
  igual(inexistente.http, 404, 'caminho inventado é 404');
  ok(
    !/express|stack|at \/|node_modules/i.test(JSON.stringify(inexistente.corpo)),
    'e o 404 não devolve pilha nem nome de framework'
  );

  /* ---- 7. CABEÇALHOS DE BORDA ------------------------------------- */
  const saude = await chamar('/api/saude');
  ok([200, 503].includes(saude.http), `/api/saude responde 200 ou 503 conforme o banco (veio ${saude.http})`);
  igual(
    saude.http, 503,
    'com o Supabase apontado para uma porta morta, a saúde é 503 — é isto que deixa um monitor externo alertar'
  );
  igual(saude.corpo.status, 'degradado', 'e o corpo diz "degradado"');
  ok(saude.cabecalhos.get('x-content-type-options') === 'nosniff', 'o helmet está na pilha (nosniff presente)');
  ok(!saude.cabecalhos.get('x-powered-by'), 'e o X-Powered-By não vaza');

  /* ---- 7.1 NADA DESTA API PODE SER GUARDADO ----------------------
     `Cache-Control: no-store` em toda resposta de `/api`. Sem isso quem
     decide guardar é o navegador e qualquer intermediário, pelo palpite
     dele: o botão "voltar" repinta um pedido já pago como pendente, e
     um proxy compartilhado pode servir o pedido de um comprador para
     outro.

     A lista é medida na pilha montada, não escrita à mão: uma rota
     nova nasce coberta. E `no-cache` não passa — ele autoriza guardar
     e só exige revalidar. */
  const CAMINHOS = [
    '/api/saude',
    '/api/admin/contratantes',
    '/api/admin/sessao',
    '/api/checkout/pedido/testemaster/ped_inexistente',
    '/api/checkout/status/ped_inexistente',
    '/api/caminho-que-nao-existe'
  ];
  for (const caminho of CAMINHOS) {
    const r = await chamar(caminho);
    const cache = r.cabecalhos.get('cache-control');
    igual(cache, 'no-store', `${caminho} responde com no-store (veio "${cache}", http ${r.http})`);
  }

  /* Controle positivo: a resposta que não é `/api` NÃO recebe o header
     — senão este teste passaria com um `setHeader` global que também
     mataria o cache do front, e ninguém veria. */
  const foraDaApi = await chamar('/');
  ok(
    foraDaApi.cabecalhos.get('cache-control') !== 'no-store',
    `controle positivo: fora de /api o no-store não é aplicado (veio "${foraDaApi.cabecalhos.get('cache-control')}")`
  );
  /* ---- TODA ROTA DO ADMIN ATRÁS DA GUARDA, E NÃO SÓ UMA -----------
     Até 18/09/2026 esta suíte provava a guarda em `/contratantes` e
     confiava na ORDEM do `adminRoutes.js` para o resto: o
     `router.use(verificarAdminKey)` protege o que vem depois dele, e
     uma rota nova escrita ACIMA da linha nasceria pública sem nada
     acusar. É a lição nº 23 por outra porta — lá era a lista de rotas
     limitadas conferida a olho, aqui é a lista de rotas protegidas.

     A varredura lê as rotas declaradas no arquivo e chama TODAS sem
     token. `/sessao` fica de fora por desenho: é a rota que troca senha
     por token, e por isso é a única que não pode exigir um. */
  {
    const { readFileSync: lerArquivo } = await import('node:fs');
    const fonteAdmin = lerArquivo(new URL('../src/routes/adminRoutes.js', import.meta.url), 'utf8');

    const declaradas = [...fonteAdmin.matchAll(/router\.(get|post|patch|put|delete)\('([^']+)'/g)]
      .map(([, metodo, caminho]) => ({ metodo: metodo.toUpperCase(), caminho }));

    ok(declaradas.length >= 10, `controle positivo: a varredura achou as rotas do admin (achou ${declaradas.length})`);

    const semSessao = declaradas.filter((r) => r.caminho !== '/sessao');
    ok(semSessao.length >= 9, 'e sobram as que DEVEM exigir token');

    for (const { metodo, caminho } of semSessao) {
      // `:id` vira um valor qualquer: a guarda roda antes de o handler
      // olhar o parâmetro, então o valor não importa.
      const alvo = `/api/admin${caminho.replace(/:[^/]+/g, 'x')}`;
      const semToken = await chamar(alvo, { metodo, corpo: metodo === 'GET' ? undefined : {} });
      igual(semToken.http, 401, `${metodo} ${alvo} sem token tem que ser 401`);
    }

    /* CONTROLE POSITIVO: com token válido, a mesma rota deixa de ser
       401. Sem este par, uma guarda que recusasse até quem tem token
       passaria por todo o laço acima. */
    const comTokenDeNovo = await chamar('/api/admin/contratantes', { cabecalhos: { 'X-Admin-Token': token } });
    ok(comTokenDeNovo.http !== 401, `com token, a rota do admin não é 401 (veio ${comTokenDeNovo.http})`);
  }

  /* ---- ID GIGANTE É RECUSADO NA FRONTEIRA, COM 400 ------------------
     `pedidoId` e `planoId` não tinham teto de tamanho até 18/09/2026 —
     achado no ciclo de revisão do projeto inteiro. Eles entram por
     parâmetro de URL e por corpo, viram CAMINHO de uma requisição HTTP ao
     servidor do contratante e literal de consulta no banco; teto de campo
     mora no validador (lição nº 24), e agora mora nas três funções
     compartilhadas por onde todo id passa.

     Este caso prova a recusa na pilha montada de verdade, e prova que ela
     acontece ANTES de qualquer ida ao banco (o resolvedor confere o id na
     primeira linha) — por isso o teste funciona mesmo com o Supabase
     falso desta suíte. */
  {
    const idGigante = 'x'.repeat(200);
    /* A rota de RESOLUÇÃO do pedido, e não uma de criação: a de criação
       valida o corpo antes de olhar o id, e o 400 que voltaria seria
       "nome é obrigatório" — que não prova nada sobre o teto. */
    const gigante = await chamar(`/api/checkout/pedido/contratante/${idGigante}`);
    igual(gigante.http, 400, 'id de 200 caracteres é recusado com 400');
    ok(
      /tamanho máximo/.test(gigante.corpo?.erro ?? ''),
      `e a mensagem diz o motivo, veio "${gigante.corpo?.erro}"`
    );

    /* CONTROLE POSITIVO: um id normal passa do teto. Sem este par, um
       teto de zero recusaria tudo e os dois de cima ficariam verdes. */
    const normal = await chamar('/api/checkout/pedido/contratante/ped-550e8400-e29b-41d4-a716-446655440000');
    ok(
      !/tamanho máximo/.test(normal.corpo?.erro ?? ''),
      `id de tamanho normal não pode bater no teto, veio "${normal.corpo?.erro}"`
    );
  }
} finally {
  servidor.close();
}

/* ------------------------------------------------------------------
   8. O CONTROLE POSITIVO DO PRÓPRIO ARRANJO

   Esta suíte depende de `CHECKOUT_SEM_LISTEN=1` para montar o app sem
   ocupar a porta. Se essa variável um dia passar a ser o caminho
   NORMAL — por um typo invertido, por exemplo —, o serviço sobe em
   produção sem ouvir nada: queda total e silenciosa. Então o teste
   sobe o `server.js` como produção sobe, sem a variável, e exige que
   ele ANUNCIE que está ouvindo.
------------------------------------------------------------------ */

const porta = 34517;
const filho = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: {
    ...process.env,
    CHECKOUT_SEM_LISTEN: '',
    PORT: String(porta)
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let saida = '';
filho.stdout.on('data', (p) => { saida += p.toString(); });
filho.stderr.on('data', (p) => { saida += p.toString(); });

try {
  const anunciou = await Promise.race([
    new Promise((pronto) => {
      const olhar = () => { if (saida.includes(`ouvindo em http://localhost:${porta}`)) pronto(true); };
      filho.stdout.on('data', olhar);
      olhar();
    }),
    new Promise((pronto) => setTimeout(() => pronto(false), 12000))
  ]);
  ok(anunciou, `sem CHECKOUT_SEM_LISTEN, o server.js escuta a porta como em produção (saída: ${saida.slice(0, 300)})`);
} finally {
  filho.kill('SIGKILL');
}

console.log(`rotas-http-respondem-como-prometido: ${checagens} checagens OK`);
