/**
 * SAN CHECKOUT v2 — src/controllers/adminController.js
 * Tela de admin (`public/admin.html`) pra cadastrar contratante novo
 * sem abrir o Supabase na mão. Protegido por UMA chave mestra
 * (`CHECKOUT_ADMIN_USER` + `CHECKOUT_ADMIN_PASS_HASH`) — ver `verificarAdminKey` abaixo,
 * aplicado a toda rota de `/api/admin` em `adminRoutes.js`.
 *
 * A tela é servida como arquivo estático pelo Cloudflare Pages, em
 * `/admin.html`. Até 11/09/2026 havia um "atalho escondido" no
 * formulário público do checkout (digitar um e-mail específico
 * redirecionava pra cá), sustentado por um contratante de mentira com
 * pedido de R$ 0,00 — removido, porque escondia o caminho de quem olhava
 * o checkout e de mais ninguém: a URL sempre respondeu direto. Esconder
 * o caminho é trabalho da camada de borda (ver `CONSTRAINTS.md` §2.6),
 * não de um campo de formulário.
 *
 * O que nunca dependeu disso, e continua valendo: quem chega na tela sem
 * usuário+senha não lista nem cria nada, porque as duas coisas são
 * sempre validadas aqui, no backend.
 */

import { randomBytes } from 'node:crypto';
import { supabase } from '../config/supabase.js';
import { gerarApiKey } from '../utils/chaveContratante.js';
import { compararSeguro, documentoValido, emailValido, cepValido, normalizarDocumento } from '../utils/validadores.js';
import { senhaConfere } from '../utils/senhaAdmin.js';
import { emitirToken, verificarToken, VALIDADE_SEGUNDOS } from '../utils/sessaoAdmin.js';
import { responderErro } from '../utils/erros.js';
import { listarErros } from '../services/erroService.js';
import { listarInbox, reenfileirar as reenfileirarNaInbox, resumoInbox } from '../services/webhookInboxService.js';
import { listarOutbox, reenviar as reenviarNaOutbox, resumoOutbox } from '../services/outboxService.js';
import { FUSO, inicioDoDiaCivil, ultimosDiasCivis } from '../utils/diaCivil.js';
import { agregarMetricas } from '../services/metricaService.js';
import { criarSubconta as criarSubcontaNaAsaas, tipoDaContaMae } from '../services/asaasService.js';
import { METODOS_VALIDOS } from '../services/pedidoService.js';
import { CICLOS_ASAAS } from '../utils/ciclos.js';
import { alvoDeRedeSeguro } from '../utils/alvoDeRede.js';
import { origemPermitida } from '../utils/retornoSeguro.js';
import {
  listarEventosWebhook,
  contarEventosNaoTratados,
  ultimoEventoRecebido,
  resumoRejeicoes
} from '../services/auditoriaWebhookService.js';

/** Aplicado a toda rota de /api/admin — um guard só, não um por handler. */
/**
 * `async` de propósito: a conferência da senha é uma derivação lenta
 * (~800 ms). Na versão síncrona ela bloquearia o event loop por esse
 * tempo inteiro, e toda rota de pagamento em voo congelaria junto a
 * cada tentativa de login no admin.
 */
export function verificarAdminKey(requisicao, resposta, proximo) {
  const { CHECKOUT_ADMIN_USER, CHECKOUT_ADMIN_PASS_HASH } = process.env;
  if (!CHECKOUT_ADMIN_USER || !CHECKOUT_ADMIN_PASS_HASH) {
    return resposta.status(503).json({ erro: 'CHECKOUT_ADMIN_USER/CHECKOUT_ADMIN_PASS_HASH não configurados — admin desativado.' });
  }

  /* Só token. A senha entra por UM lugar só, o `abrirSessao` abaixo —
     que é o que torna possível limitar a força bruta num ponto e deixar
     o resto do painel barato. Aceitar senha aqui também manteria os
     830 ms por clique e daria dois caminhos para proteger em vez de um.

     Deixou de ser `async` de propósito: não há mais nada lento aqui. */
  const { valido, motivo } = verificarToken(requisicao.get('X-Admin-Token'), CHECKOUT_ADMIN_PASS_HASH);
  if (!valido) {
    /* `sessaoExpirada` existe para o painel saber a diferença entre
       "seu token venceu, entre de novo" e "você não deveria estar
       aqui" — sem isso, o operador vê "inválido" e acha que errou a
       senha. */
    return resposta.status(401).json({
      erro: motivo === 'vencido' ? 'Sessão expirada. Entre novamente.' : 'Sessão inválida.',
      sessaoExpirada: true
    });
  }
  proximo();
}

/**
 * POST /api/admin/sessao — o ÚNICO lugar que confere senha.
 *
 * É aqui, e só aqui, que os ~830 ms de scrypt são pagos: uma vez por
 * login, em vez de uma vez por clique. Por ser o único ponto, é também
 * o único que precisa de limite apertado contra força bruta — ver o
 * limitador próprio em `server.js`.
 *
 * `async` de propósito, e o motivo é o mesmo de antes: a derivação
 * bloquearia o event loop por 830 ms, e toda cobrança em voo congelaria
 * junto a cada tentativa de login.
 */
export async function abrirSessao(requisicao, resposta) {
  const { CHECKOUT_ADMIN_USER, CHECKOUT_ADMIN_PASS_HASH } = process.env;
  if (!CHECKOUT_ADMIN_USER || !CHECKOUT_ADMIN_PASS_HASH) {
    return resposta.status(503).json({ erro: 'CHECKOUT_ADMIN_USER/CHECKOUT_ADMIN_PASS_HASH não configurados — admin desativado.' });
  }

  const { usuario, senha } = requisicao.body ?? {};

  // As duas checagens rodam SEMPRE, mesmo com o usuário errado: sair
  // cedo quando o usuário não bate faria a resposta voltar rápido e
  // entregaria, por tempo, se o nome de usuário existe.
  const usuarioOk = compararSeguro(usuario, CHECKOUT_ADMIN_USER);
  const senhaOk = await senhaConfere(senha, CHECKOUT_ADMIN_PASS_HASH);
  if (!usuarioOk || !senhaOk) {
    return resposta.status(401).json({ erro: 'Usuário ou senha de admin inválidos.' });
  }

  resposta.json({
    token: emitirToken(usuario, CHECKOUT_ADMIN_PASS_HASH),
    expiraEm: new Date(Date.now() + VALIDADE_SEGUNDOS * 1000).toISOString()
  });
}

export async function listarContratantes(requisicao, resposta) {
  // Por padrão a lista mostra só quem está em uso — é para isso que
  // arquivar serve. `?incluirArquivados=1` traz tudo, para o operador
  // poder desarquivar o que arquivou por engano.
  const incluirArquivados = requisicao.query?.incluirArquivados === '1';

  /* A `api_key` NÃO sai na listagem (H-08, 24/09/2026). Até aqui a tela
     recebia todas as chaves de todos os contratantes a cada abertura, e
     um XSS no admin (ou um token de sessão vazado) levava tudo de uma
     vez. A chave inteira só aparece UMA vez: na resposta de criação e na
     de rotação — quem precisa dela é quem acabou de gerá-la. Aqui vai
     só o final, para o operador reconhecer qual está em uso. */
  let consulta = supabase
    .from('contratantes')
    .select('id, nome, api_base_url, api_key, webhook_url, wallet_id, metodos_habilitados, retorno_dominios, ciclos_permitidos, criado_em, arquivado_em')
    .order('criado_em', { ascending: false });

  if (!incluirArquivados) consulta = consulta.is('arquivado_em', null);

  const { data, error } = await consulta;
  if (error) return responderErro(resposta, error, 'admin.listarContratantes');
  resposta.json((data ?? []).map(mascararChave));
}

/** `api_key` → `api_key_final` (últimos 4). Nunca a chave inteira. */
export function mascararChave(contratante) {
  if (!contratante) return contratante;
  const { api_key: chave, ...resto } = contratante;
  return { ...resto, api_key_final: typeof chave === 'string' && chave.length >= 4 ? chave.slice(-4) : null };
}

/**
 * Arquiva ou desarquiva. Uma rota só para os dois sentidos de propósito:
 * são a mesma operação com sinal trocado, e separá-las duplicaria a
 * checagem de existência e a resposta.
 *
 * **Arquivar não apaga nada**, e é por isso que este endpoint existe em
 * vez de um DELETE: `cobrancas.contratante_id` é `on delete set null`,
 * então apagar um contratante deixaria o histórico financeiro dele sem
 * dono. Ver `CONSTRAINTS.md` §1.10.
 *
 * O efeito real está em `pedidoService.buscarContratante`: arquivado
 * deixa de resolver pedido e deixa de autenticar estorno. Aqui é só o
 * carimbo de data.
 */
export async function arquivarContratante(requisicao, resposta) {
  const arquivar = requisicao.body?.arquivar;
  if (typeof arquivar !== 'boolean') {
    return resposta.status(400).json({ erro: 'arquivar deve ser true ou false.' });
  }

  const { data, error } = await supabase
    .from('contratantes')
    .update({ arquivado_em: arquivar ? new Date().toISOString() : null })
    .eq('id', requisicao.params.id)
    .select('id, nome, arquivado_em')
    .maybeSingle();

  if (error) return responderErro(resposta, error, 'admin.arquivarContratante');
  if (!data) return resposta.status(404).json({ erro: 'Contratante não encontrado.' });
  resposta.json(data);
}

/**
 * POST /api/admin/contratantes/:id/rotacionar-chave — troca a `api_key`.
 *
 * POR QUE ISTO EXISTE, se o `PATCH` recusa mexer na chave de propósito
 * Porque "nunca trocar" não é política de segredo, é ausência de uma.
 * Chave vaza — vai para um print, um chat, um log do parceiro — e até
 * 13/09/2026 o único caminho para trocar era editar a linha no SQL
 * Editor, que o `README.md` proíbe, ou recriar o contratante, que o
 * §1.10 do `CONSTRAINTS.md` veta quando existe cobrança paga. Ficava
 * assim: a chave exposta continuava valendo para sempre.
 *
 * TROCA IMEDIATA, E É O PONTO DELA. A chave antiga para de autenticar
 * no mesmo instante — é o que se quer de uma chave queimada. A
 * integração do contratante fica fora do ar até ele colar a nova, e por
 * isso a tela avisa antes de confirmar, com o nome dele escrito.
 * Convivência de duas chaves (janela de graça) seria mais gentil e é
 * outra funcionalidade: precisa de coluna nova e de prazo, e enquanto
 * não existir, gentileza aqui significaria deixar a chave vazada viva
 * mais um tempo.
 *
 * A chave nova é gerada aqui, nunca aceita do corpo — mesma regra do
 * cadastro, mesma função (`gerarApiKey`).
 */
export async function rotacionarChaveContratante(requisicao, resposta) {
  const { id } = requisicao.params;

  const { data, error } = await supabase
    .from('contratantes')
    .update({ api_key: gerarApiKey() })
    .eq('id', id)
    .select('id, nome, api_key')
    .maybeSingle();

  if (error) return responderErro(resposta, error, 'admin.rotacionarChaveContratante');
  if (!data) return resposta.status(404).json({ erro: 'Contratante não encontrado.' });
  resposta.json(data);
}

function slugValido(valor) {
  return /^[a-z0-9][a-z0-9-]{1,49}$/.test(String(valor ?? ''));
}

/**
 * Alvo de requisição de saída do checkout (`api_base_url`, `webhook_url`):
 * precisa ser https e de host público, não só uma URL que parseia. O
 * porquê está em `utils/alvoDeRede.js` — a chave do contratante viaja
 * nesse endereço, e http vazaria o segredo; host interno vira SSRF.
 */
function urlValida(valor) {
  return alvoDeRedeSeguro(valor);
}

/**
 * Origens autorizadas a receber o comprador de volta depois do
 * pagamento (`?returnUrl=` no link do checkout).
 *
 * Cada entrada passa pelo MESMO guarda dos alvos de saída (https, host
 * público) e é guardada já normalizada como origem — `URL.origin`, sem
 * caminho, sem query, sem barra final. Normalizar na escrita é o que
 * mantém a comparação da hora do pagamento sendo um `Set.has` exato, em
 * vez de casamento de texto, que é onde mora toda a família de bypasses
 * de open redirect (ver `utils/retornoSeguro.js`).
 *
 * undefined = não mexe (PATCH). Lista inválida = null (rejeita). Lista
 * vazia é legítima: significa "só a origem da api_base_url".
 */
function retornoDominiosValidos(valor) {
  if (valor === undefined) return undefined;
  if (valor === null) return [];
  if (!Array.isArray(valor)) return null;
  if (valor.length > 10) return null;

  const origens = [];
  for (const entrada of valor) {
    const origem = origemPermitida(entrada);
    if (!origem) return null;
    if (!origens.includes(origem)) origens.push(origem);
  }
  return origens;
}

/** undefined = não mexe (usado no PATCH); lista inválida = null (rejeita). */
function metodosHabilitadosValidos(valor) {
  if (valor === undefined) return undefined;
  if (!Array.isArray(valor) || valor.length === 0) return null;
  return valor.every((m) => METODOS_VALIDOS.includes(m)) ? valor : null;
}

export async function criarContratante(requisicao, resposta) {
  const { id, nome, apiBaseUrl, webhookUrl, walletId, metodosHabilitados, retornoDominios } = requisicao.body ?? {};

  if (!slugValido(id)) {
    return resposta.status(400).json({ erro: 'id inválido — use um slug (letras minúsculas, números, hífen), ex.: "trimundi9".' });
  }
  if (!nome) return resposta.status(400).json({ erro: 'nome é obrigatório.' });
  if (!urlValida(apiBaseUrl)) return resposta.status(400).json({ erro: 'apiBaseUrl precisa ser https e de host público (a chave do contratante viaja nesse endereço).' });
  if (webhookUrl && !urlValida(webhookUrl)) return resposta.status(400).json({ erro: 'webhookUrl precisa ser https e de host público.' });

  const metodos = metodosHabilitados === undefined ? METODOS_VALIDOS : metodosHabilitadosValidos(metodosHabilitados);
  if (metodos === null) return resposta.status(400).json({ erro: `metodosHabilitados precisa ser uma lista não-vazia com valores entre: ${METODOS_VALIDOS.join(', ')}.` });

  const dominios = retornoDominios === undefined ? [] : retornoDominiosValidos(retornoDominios);
  if (dominios === null) return resposta.status(400).json({ erro: 'retornoDominios precisa ser uma lista (até 10) de origens https com host público — ex.: "https://www.loja.com.br".' });

  // Sempre gerada aqui, nunca aceita do body — evita chave fraca ou
  // reaproveitada entre projetos.
  const apiKey = gerarApiKey();

  const { data, error } = await supabase
    .from('contratantes')
    .insert({
      id,
      nome,
      api_base_url: apiBaseUrl,
      api_key: apiKey,
      webhook_url: webhookUrl || null,
      wallet_id: walletId || null,
      metodos_habilitados: metodos,
      retorno_dominios: dominios
    })
    .select('id, nome, api_base_url, api_key, webhook_url, wallet_id, metodos_habilitados, retorno_dominios, criado_em')
    .single();

  if (error) {
    if (error.code === '23505') return resposta.status(409).json({ erro: `Já existe um contratante com id "${id}".` });
    return responderErro(resposta, error, 'admin.criarContratante');
  }

  resposta.status(201).json(data);
}

/**
 * PATCH /api/admin/contratantes/:id — edita um contratante já
 * cadastrado. Todo campo é opcional (só atualiza o que vier no body).
 *
 * `id` não muda. A `api_key` **se troca**, mas não por aqui — tem rota
 * própria (`rotacionar-chave`, acima), porque trocar segredo é ação
 * deliberada com consequência imediata para o contratante, e não podia
 * acontecer de carona num salvamento de formulário.
 */
export async function atualizarContratante(requisicao, resposta) {
  const { id } = requisicao.params;
  const { nome, apiBaseUrl, webhookUrl, walletId, metodosHabilitados, retornoDominios, ciclosPermitidos } = requisicao.body ?? {};

  /* `ciclosPermitidos` (M-10): lista no vocabulário da Asaas, ou `null`
     para "sem restrição". Qualquer coisa fora do conjunto fechado é 400
     nomeando os aceitos. */
  let ciclos;
  if (ciclosPermitidos !== undefined) {
    if (ciclosPermitidos === null || (Array.isArray(ciclosPermitidos) && ciclosPermitidos.length === 0)) ciclos = null;
    else if (Array.isArray(ciclosPermitidos) && ciclosPermitidos.every((c) => CICLOS_ASAAS.includes(c)) && ciclosPermitidos.length <= CICLOS_ASAAS.length) ciclos = [...new Set(ciclosPermitidos)];
    else return resposta.status(400).json({ erro: `ciclosPermitidos precisa ser uma lista com valores entre: ${CICLOS_ASAAS.join(', ')} — ou vazia para sem restrição.` });
  }

  if (apiBaseUrl !== undefined && !urlValida(apiBaseUrl)) {
    return resposta.status(400).json({ erro: 'apiBaseUrl precisa ser https e de host público (a chave do contratante viaja nesse endereço).' });
  }
  if (webhookUrl && !urlValida(webhookUrl)) return resposta.status(400).json({ erro: 'webhookUrl precisa ser https e de host público.' });

  const metodos = metodosHabilitadosValidos(metodosHabilitados);
  if (metodos === null) return resposta.status(400).json({ erro: `metodosHabilitados precisa ser uma lista não-vazia com valores entre: ${METODOS_VALIDOS.join(', ')}.` });

  const dominios = retornoDominiosValidos(retornoDominios);
  if (dominios === null) return resposta.status(400).json({ erro: 'retornoDominios precisa ser uma lista (até 10) de origens https com host público — ex.: "https://www.loja.com.br".' });

  const patch = {};
  if (nome !== undefined) patch.nome = nome;
  if (apiBaseUrl !== undefined) patch.api_base_url = apiBaseUrl;
  if (webhookUrl !== undefined) patch.webhook_url = webhookUrl || null;
  if (walletId !== undefined) patch.wallet_id = walletId || null;
  if (metodos !== undefined) patch.metodos_habilitados = metodos;
  if (dominios !== undefined) patch.retorno_dominios = dominios;
  if (ciclos !== undefined) patch.ciclos_permitidos = ciclos;

  if (Object.keys(patch).length === 0) return resposta.status(400).json({ erro: 'Nenhum campo pra atualizar.' });

  const { data, error } = await supabase
    .from('contratantes')
    .update(patch)
    .eq('id', id)
    .select('id, nome, api_base_url, api_key, webhook_url, wallet_id, metodos_habilitados, retorno_dominios, ciclos_permitidos, criado_em')
    .maybeSingle();

  if (error) return responderErro(resposta, error, 'admin.atualizarContratante');
  if (!data) return resposta.status(404).json({ erro: 'Contratante não encontrado.' });

  resposta.json(mascararChave(data));
}

/**
 * GET /api/admin/metricas — a saúde do checkout em números.
 *
 * A métrica que mais diz sobre um checkout brasileiro é **quantos Pix
 * gerados viram Pix pagos**. Antes disso não existia: qualquer decisão
 * sobre o checkout (inclusive quais melhorias priorizar) era chute.
 *
 * ponytail: sai tudo de `cobrancas`, que já registra criação e status —
 * sem tabela nova, sem serviço de BI, sem evento extra em toda página.
 *
 * O que NÃO é medido, de propósito: quem abriu o checkout e saiu sem
 * gerar cobrança nenhuma. Isso exigiria gravar uma linha por abertura
 * de página (e lidar com bot e recarregamento). A taxa de pagamento
 * abaixo já responde a pergunta principal — se e quando isso virar
 * insuficiente, aí vale a tabela.
 */
/**
 * GET /api/admin/metricas?dias=N — a métrica de sucesso.
 *
 * ── O que mudou em 16/09/2026, e por quê ─────────────────────────────
 * Até aqui a janela era "as últimas N×24 h" e não havia recorte por dia.
 * A prontidão operacional exige que a métrica responda literalmente
 * **"quantos ontem?"**, e "últimas 24 h" às 10h da manhã mistura metade
 * de hoje com metade de ontem — parecido, e não a mesma coisa.
 *
 * Agora a janela é por **dia civil de Brasília**, decidida no servidor
 * (`src/utils/diaCivil.js`). Isso não é detalhe de fuso: o processo de
 * produção roda em **UTC** (medido dentro do contêiner em 16/09), então
 * qualquer conta com data local do servidor erraria das 21h à meia-noite
 * de Brasília — três horas por dia.
 *
 * ── As DUAS bases de dia, e por que as duas existem ──────────────────
 * A resposta traz dois recortes por dia, com nomes diferentes de
 * propósito, porque respondem perguntas diferentes e confundi-las é o
 * jeito mais fácil de ler o número errado:
 *
 *   `confirmadasPorDia` — por `confirmado_em`. É **a métrica**: quantas
 *       cobranças ENTRARAM naquele dia, independente de quando foram
 *       geradas. É o que responde "quantos ontem?".
 *
 *   `geradasPorDia` — por `criado_em`. Visão de **coorte**: das
 *       cobranças nascidas naquele dia, quantas viraram dinheiro. Serve
 *       para avaliar a tela e o link, não a entrada de caixa.
 *
 * Uma cobrança gerada dia 15 e paga dia 16 conta em `geradasPorDia[15]`
 * e em `confirmadasPorDia[16]`. Os dois números estarem certos e
 * diferentes é o comportamento correto, não uma inconsistência.
 *
 * ── `confirmadasSemData` ─────────────────────────────────────────────
 * Linha confirmada ANTES da migration 0008 não tem `confirmado_em`.
 * Essas não são jogadas num dia qualquer nem escondidas: vão para um
 * campo próprio. Nulo é informação, não falta.
 */
export async function obterMetricas(requisicao, resposta) {
  const dias = Math.min(Math.max(Number(requisicao.query.dias) || 30, 1), 365);

  const janela = ultimosDiasCivis(dias);
  const primeiroDia = janela[0];
  const desde = inicioDoDiaCivil(primeiroDia);

  // Busca por `criado_em` OU `confirmado_em` dentro da janela: uma
  // cobrança gerada antes da janela e confirmada dentro dela É a métrica
  // daquele dia, e filtrar só por `criado_em` a perderia — que é
  // exatamente o caso de assinatura, cujo ciclo nasce e confirma em
  // momentos diferentes.
  // Sem milissegundos. Medido em 16/09 contra o PostgREST de produção:
  // as duas formas funcionam — ele tolera o ponto do `.000Z` dentro do
  // valor, embora parta `coluna.op.valor` nos dois primeiros pontos. O
  // corte fica por não depender dessa tolerância, não porque quebrava.
  // Um segundo de granularidade não muda uma janela de dias.
  const limite = `${desde.toISOString().slice(0, 19)}Z`;

  const { data, error } = await supabase
    .from('cobrancas')
    /* `ambiente` e `e_teste` entram aqui porque o filtro de negócio
       (RN-33) mora no agregador: coluna que não vem no `select` chega
       como `undefined`, e `undefined !== 'producao'` excluiria TODA
       cobrança em silêncio — hoje daria o número certo por coincidência
       (é tudo sandbox) e erraria para sempre depois da troca. */
    .select(
      'contratante_id, metodo_pagamento, status, valor_cobrado, criado_em, ' +
      'confirmado_em, ambiente, e_teste'
    )
    .or(`criado_em.gte.${limite},confirmado_em.gte.${limite}`);

  if (error) return responderErro(resposta, error, 'admin.obterMetricas');

  // A conta mora em `metricaService.agregarMetricas`, que é função pura
  // e tem autoteste. Aqui só fica o que precisa de banco.
  resposta.json({
    fuso: FUSO,
    periodoDias: dias,
    desde: desde.toISOString(),
    ...agregarMetricas(data, janela)
  });
}

// --- Subcontas Asaas ---------------------------------------------------
// Tela separada do cadastro de contratante, operacional (não faz parte
// do contrato do API.md — quem usa isto é o operador, não o
// integrador): cria a conta na Asaas via API (POST /v3/accounts) em vez
// de exigir que o operador crie na mão pelo site da Asaas. O wallet_id
// gerado aqui ainda precisa ser colado manualmente no contratante
// certo — nunca ligado automaticamente entre as duas tabelas.

export async function listarSubcontas(requisicao, resposta) {
  const incluirArquivadas = requisicao.query?.incluirArquivados === '1';

  let consulta = supabase
    .from('subcontas')
    .select('*')
    .order('criado_em', { ascending: false });

  if (!incluirArquivadas) consulta = consulta.is('arquivado_em', null);

  const { data, error } = await consulta;
  if (error) return responderErro(resposta, error, 'admin.listarSubcontas');
  // A chave da subconta também não sai em listagem (H-08).
  resposta.json((data ?? []).map(mascararChave));
}

/**
 * Arquiva ou desarquiva uma subconta. Faz MENOS que o de contratante, e
 * a diferença importa: a subconta é uma conta na Asaas, que continua
 * existindo lá, recebendo split e aparecendo no painel deles. Isto aqui
 * só tira da lista do painel do checkout.
 *
 * Não existe apagar subconta pela API da Asaas sem entrar na conta dela,
 * então "excluir" seria mentira — e a tela diz isso em vez de fingir.
 *
 * A resposta inclui `contratantesUsando`: se o `wallet_id` desta
 * subconta ainda está no cadastro de algum contratante ATIVO, arquivar
 * esconde da lista algo que segue recebendo dinheiro. Não é bloqueio,
 * é informação — quem decide é o operador, mas não às cegas.
 */
export async function arquivarSubconta(requisicao, resposta) {
  const arquivar = requisicao.body?.arquivar;
  if (typeof arquivar !== 'boolean') {
    return resposta.status(400).json({ erro: 'arquivar deve ser true ou false.' });
  }

  const { data, error } = await supabase
    .from('subcontas')
    .update({ arquivado_em: arquivar ? new Date().toISOString() : null })
    .eq('id', requisicao.params.id)
    .select('id, nome, wallet_id, arquivado_em')
    .maybeSingle();

  if (error) return responderErro(resposta, error, 'admin.arquivarSubconta');
  if (!data) return resposta.status(404).json({ erro: 'Subconta não encontrada.' });

  let contratantesUsando = [];
  if (data.wallet_id) {
    const { data: ligados } = await supabase
      .from('contratantes')
      .select('id, nome')
      .eq('wallet_id', data.wallet_id)
      .is('arquivado_em', null);
    contratantesUsando = ligados ?? [];
  }

  resposta.json({ ...data, contratantesUsando });
}

/**
 * Traduz uma recusa da Asaas na criação de subconta para algo que o
 * operador consiga AGIR, em vez de um número.
 *
 * Existe por causa de 12/09/2026: a tela mostrou "Asaas respondeu 403",
 * que não diz nem o que está errado nem onde consertar. 401 e 403 nessa
 * rota quase sempre são a mesma coisa — a conta-mãe não pode criar
 * subconta —, e a causa nº 1 está escrita na documentação da Asaas:
 * **conta de pessoa física (CPF) não cria subconta, só pessoa jurídica
 * (CNPJ)**. Vale por ambiente: a conta do sandbox é outra conta, e pode
 * ser PF mesmo que a de produção seja PJ.
 *
 * ⚠️ **Conta PF com informações comerciais de CNPJ parece PJ e não é.**
 * Medido no sandbox em 17/09/2026: `/v3/myAccount` dizia `FISICA` (CPF)
 * enquanto `/v3/myAccount/commercialInfo` dizia `JURIDICA` (CNPJ), na
 * mesma conta, com o comercial aprovado. A regra de subconta olha o
 * REGISTRO, não o comercial — e preencher o CNPJ da empresa ali não
 * converte a conta. É a confusão mais provável de quem "já mudou para
 * PJ" e continua levando 403.
 *
 * Até 17/09 esta explicação lia só o comercial e concluía o contrário,
 * mandando procurar permissão e CNAE quando o problema era o tipo da
 * conta. Ver `docs/erros/2026-09-17-diagnostico-de-subconta-lia-o-endpoint-errado.md`.
 *
 * A consulta extra só roda no caminho do erro, nunca no caminho feliz,
 * e falhar nela não pode piorar a mensagem original — por isso o catch
 * devolve string vazia em vez de estourar.
 */
async function explicarRecusaDeSubconta(erroAsaas) {
  if (erroAsaas.status !== 401 && erroAsaas.status !== 403) return '';

  try {
    const { tipo, tipoComercial, divergem, companyType } = await tipoDaContaMae();

    if (tipo === 'fisica') {
      const ressalva = divergem
        ? ' ATENÇÃO: as informações COMERCIAIS desta conta estão como pessoa jurídica'
          + `${companyType ? ` (${companyType})` : ''}, o que faz a conta parecer PJ no painel — mas a Asaas`
          + ' aplica a regra de subconta sobre o REGISTRO da conta, e ele é CPF.'
          + ' Preencher o CNPJ nas informações comerciais não converte a conta.'
        : '';
      return 'a conta-mãe na Asaas (neste ambiente) está REGISTRADA como PESSOA FÍSICA (CPF), '
        + 'e a Asaas só deixa conta pessoa jurídica (CNPJ) criar subconta.'
        + ressalva
        + ' O caminho é a Asaas converter o registro da conta para CNPJ — isso se pede ao suporte deles,'
        + ' e o tipo de documento da SUBCONTA não muda nada (CPF e CNPJ levam o mesmo 403, medido em 17/09).';
    }

    if (tipo === 'juridica') {
      return `a conta-mãe está registrada como pessoa jurídica${companyType ? ` (${companyType})` : ''}`
        + `${tipoComercial === 'fisica' ? ', embora as informações comerciais estejam como pessoa física' : ''}`
        + ', então o problema NÃO é o tipo de conta — restam permissão de subcontas não liberada nesta conta'
        + ' ou CNAE incompatível. Isso se resolve com o suporte da Asaas.';
    }

    return 'não consegui ler o tipo da conta-mãe para dizer o porquê — confira em /v3/myAccount (o REGISTRO, '
      + 'não o commercialInfo) se ela é CNPJ.';
  } catch {
    return '';
  }
}

export async function criarSubconta(requisicao, resposta) {
  const corpo = requisicao.body ?? {};
  /* A MESMA função que as fronteiras do comprador usam, não uma cópia
     do mesmo `replace`. A regra "documento é uma chave só, em dígitos"
     (RN-32) tem de ter um dono; repetida em dois lugares, um dia vale
     em um. É o mesmo argumento dos tetos de campo em
     `utils/validadores.js`. */
  const documentoDigitos = normalizarDocumento(corpo.documento);
  const cepDigitos = String(corpo.cep ?? '').replace(/\D/g, '');
  const faturamento = Number(corpo.faturamento);
  const ehPessoaFisica = documentoDigitos.length === 11;

  if (!corpo.nome) return resposta.status(400).json({ erro: 'nome é obrigatório.' });
  if (!emailValido(corpo.email)) return resposta.status(400).json({ erro: 'email inválido.' });
  if (!documentoValido(documentoDigitos)) return resposta.status(400).json({ erro: 'documento (CPF ou CNPJ) inválido.' });
  if (!corpo.endereco || !corpo.enderecoNumero || !corpo.bairro) {
    return resposta.status(400).json({ erro: 'endereço, número e bairro são obrigatórios (exigência antifraude da Asaas).' });
  }
  if (!cepValido(cepDigitos)) return resposta.status(400).json({ erro: 'cep inválido.' });
  if (!Number.isFinite(faturamento) || faturamento <= 0) return resposta.status(400).json({ erro: 'faturamento inválido.' });
  if (ehPessoaFisica && !corpo.dataNascimento) return resposta.status(400).json({ erro: 'dataNascimento é obrigatória pra subconta pessoa física.' });
  if (!ehPessoaFisica && !corpo.tipoEmpresa) return resposta.status(400).json({ erro: 'tipoEmpresa é obrigatório pra subconta pessoa jurídica.' });

  let criada;
  try {
    criada = await criarSubcontaNaAsaas({
      nome: corpo.nome,
      email: corpo.email,
      documentoDigitos,
      telefone: corpo.telefone,
      celular: corpo.celular,
      endereco: corpo.endereco,
      enderecoNumero: corpo.enderecoNumero,
      complemento: corpo.complemento,
      bairro: corpo.bairro,
      cepDigitos,
      faturamento,
      tipoEmpresa: corpo.tipoEmpresa,
      dataNascimento: corpo.dataNascimento
    });
  } catch (erroAsaas) {
    const detalhe = await explicarRecusaDeSubconta(erroAsaas);
    return resposta
      .status(erroAsaas.status && erroAsaas.status < 500 ? 400 : 502)
      .json({ erro: `Asaas recusou a criação da subconta: ${erroAsaas.message}${detalhe ? ` — ${detalhe}` : ''}` });
  }

  const { data, error } = await supabase
    .from('subcontas')
    .insert({
      asaas_account_id: criada.asaasAccountId,
      nome: corpo.nome,
      email: corpo.email,
      documento: documentoDigitos,
      telefone: corpo.telefone || null,
      celular: corpo.celular || null,
      endereco: corpo.endereco,
      endereco_numero: corpo.enderecoNumero,
      complemento: corpo.complemento || null,
      bairro: corpo.bairro,
      cep: cepDigitos,
      faturamento,
      tipo_empresa: ehPessoaFisica ? null : corpo.tipoEmpresa,
      data_nascimento: ehPessoaFisica ? corpo.dataNascimento : null,
      wallet_id: criada.walletId,
      api_key: criada.apiKey
    })
    .select('*')
    .single();

  if (error) {
    // A subconta já existe na Asaas nesse ponto — só o INSERT local
    // falhou. Loga os dados devolvidos pra não se perderem: sem isso,
    // o operador teria que recriar a subconta na Asaas à toa.
    console.error('[admin.criarSubconta] Supabase falhou DEPOIS da Asaas já ter criado a subconta — dados pra recuperar manualmente:', criada);
    return responderErro(resposta, error, 'admin.criarSubconta');
  }

  resposta.status(201).json(data);
}

/** A Asaas só manda o link de ativação por e-mail, nunca na resposta
 *  da API — este endpoint só existe pra colar esse link manualmente
 *  depois que o operador recebe o e-mail. */
export async function atualizarLinkAtivacaoSubconta(requisicao, resposta) {
  const { linkAtivacao } = requisicao.body ?? {};
  if (!linkAtivacao) return resposta.status(400).json({ erro: 'linkAtivacao é obrigatório.' });

  const { data, error } = await supabase
    .from('subcontas')
    .update({ link_ativacao: linkAtivacao })
    .eq('id', requisicao.params.id)
    .select('*')
    .single();

  if (error) return responderErro(resposta, error, 'admin.atualizarLinkAtivacaoSubconta');
  if (!data) return resposta.status(404).json({ erro: 'Subconta não encontrada.' });
  resposta.json(data);
}

// --- Auditoria do webhook (Lei 8) --------------------------------------
// O log existe porque evento que o código não trata tinha um destino só:
// `console.log` da hospedagem, retenção curta, e ninguém olha. Ver
// CONSTRAINTS.md §2.2 para o que está marcado no painel da Asaas, e
// `auditoriaWebhookService.js` para o que é (e o que não é) gravado.

/**
 * Quando o operador vir isto no painel, é porque a Asaas mudou a
 * elegibilidade da conta para Pix Automático. A instrução tem que vir
 * junto do evento, não numa conversa de meses atrás: são 10 eventos no
 * grupo e marcar os errados é pior que não marcar nenhum.
 *
 * Os 10 nomes foram conferidos na documentação oficial da Asaas em
 * 11/09/2026 (Eventos para Pix Automático).
 */
const INSTRUCOES_POR_EVENTO = {
  PIX_AUTOMATIC_RECURRING_ELIGIBILITY_UPDATED: {
    titulo: 'A Asaas mudou a elegibilidade desta conta para Pix Automático',
    passos: [
      'Confira no painel da Asaas se a conta foi LIBERADA (o evento também dispara se ela for bloqueada).',
      'Se foi liberada, vá em Integrações → Webhooks → editar o webhook do checkout, grupo Pix Automático.',
      'Marque SOMENTE os cinco de autorização: _AUTHORIZATION_CREATED, _ACTIVATED, _CANCELLED (dois L), _EXPIRED e _REFUSED. São os únicos que o código trata.',
      'Marque também _PAYMENT_INSTRUCTION_REFUSED: é cobrança da recorrência que não foi agendada, ou seja, dinheiro que não entra. O código ainda não trata, mas cai aqui neste log.',
      'NÃO marque _PAYMENT_INSTRUCTION_CREATED, _SCHEDULED nem _CANCELLED: disparam a cada cobrança da recorrência e não dizem nada que a confirmação já não diga.',
      'Só depois disso habilite "Assinatura por Pix" em algum contratante — antes da liberação, o método falha na hora de cobrar.'
    ]
  }
};

export async function listarAuditoriaWebhook(requisicao, resposta) {
  try {
    const eventos = await listarEventosWebhook({
      limite: requisicao.query.limite,
      resultado: requisicao.query.resultado || undefined,
      evento: requisicao.query.evento || undefined,
      antesDe: requisicao.query.antesDe || undefined
    });

    // O contratante é resolvido AQUI, sobre a página que está sendo
    // exibida — e não gravado a cada webhook. Ver o comentário na
    // migration 0002: o caminho do dinheiro não paga consulta extra
    // para enfeitar coluna de diagnóstico.
    const referencias = [...new Set(eventos.map((e) => e.referencia_id).filter(Boolean))];
    const porReferencia = new Map();

    if (referencias.length > 0) {
      // Duas consultas com `.in()` em vez de uma `.or()` montada por
      // concatenação. O `referencia_id` vem do payload da Asaas — dado
      // de fora, mesmo depois da guarda de origem — e vírgula ou
      // parêntese num id escaparia de um filtro montado como texto.
      // `.in()` recebe array e escapa sozinho; o custo é uma consulta
      // a mais numa tela que quase ninguém abre.
      const colunas = 'charge_id, asaas_checkout_id, pedido_id, contratante_id, status';
      const [porCharge, porCheckout] = await Promise.all([
        supabase.from('cobrancas').select(colunas).in('charge_id', referencias),
        supabase.from('cobrancas').select(colunas).in('asaas_checkout_id', referencias)
      ]);

      for (const c of [...(porCharge.data ?? []), ...(porCheckout.data ?? [])]) {
        if (c.charge_id) porReferencia.set(c.charge_id, c);
        if (c.asaas_checkout_id) porReferencia.set(c.asaas_checkout_id, c);
      }
    }

    resposta.json(eventos.map((e) => ({
      ...e,
      cobranca: porReferencia.get(e.referencia_id) ?? null,
      instrucao: INSTRUCOES_POR_EVENTO[e.evento] ?? null
    })));
  } catch (erro) {
    responderErro(resposta, erro, 'admin.listarAuditoriaWebhook');
  }
}

export async function obterResumoWebhook(requisicao, resposta) {
  // Faltava o piso — achado no ciclo de revisão do projeto inteiro em
  // 18/09/2026: `dias=-100` calculava uma data no FUTURO em
  // `contarEventosNaoTratados`, e "0 eventos não tratados" saía sem
  // sintoma, mesmo havendo. Mesmo padrão do `obterMetricas` acima.
  const dias = Math.min(Math.max(Number(requisicao.query.dias) || 7, 1), 90);
  try {
    const [naoTratados, ultimo, rejeicoes] = await Promise.all([
      contarEventosNaoTratados(dias),
      ultimoEventoRecebido(),
      resumoRejeicoes()
    ]);

    resposta.json({ periodoDias: dias, naoTratados, ultimoEvento: ultimo, rejeicoes });
  } catch (erro) {
    responderErro(resposta, erro, 'admin.obterResumoWebhook');
  }
}


/**
 * GET /api/admin/erros — a captura de exceção da Lei 8, para ler.
 *
 * Devolve a linha como está gravada, sem enfeite: ela já nasce raspada
 * (`erroService.rasparMensagem`) e sem corpo, query, cabeçalho ou URL
 * com valores. Não há nada a filtrar aqui — se houvesse, o lugar de
 * filtrar seria a gravação, não a leitura.
 *
 * Ordenada por `ultima_vez`: o que está acontecendo agora vem primeiro,
 * e `ocorrencias` diz se é rajada ou caso isolado.
 */
/* ------------------------------------------------------------------
   As FILAS (M-07): inbox do webhook, outbox das notificações, e o
   reenvio administrativo — pelo MESMO id, nunca um evento novo.
------------------------------------------------------------------ */

export async function listarFilaInbox(requisicao, resposta) {
  try {
    resposta.json({ linhas: await listarInbox({ limite: requisicao.query.limite, status: requisicao.query.status || undefined }) });
  } catch (erro) {
    responderErro(resposta, erro, 'admin.listarFilaInbox');
  }
}

export async function reenfileirarInbox(requisicao, resposta) {
  try {
    const ok = await reenfileirarNaInbox(String(requisicao.params.id));
    if (!ok) return resposta.status(404).json({ erro: 'Evento não encontrado, ou ainda em processamento.' });
    resposta.json({ reenfileirado: true });
  } catch (erro) {
    responderErro(resposta, erro, 'admin.reenfileirarInbox');
  }
}

export async function listarFilaOutbox(requisicao, resposta) {
  try {
    resposta.json({
      linhas: await listarOutbox({
        limite: requisicao.query.limite,
        status: requisicao.query.status || undefined,
        contratanteId: requisicao.query.contratante || undefined
      })
    });
  } catch (erro) {
    responderErro(resposta, erro, 'admin.listarFilaOutbox');
  }
}

export async function reenviarOutbox(requisicao, resposta) {
  try {
    const ok = await reenviarNaOutbox(String(requisicao.params.id));
    if (!ok) return resposta.status(404).json({ erro: 'Notificação não encontrada, ou ainda sendo enviada.' });
    resposta.json({ reenviada: true });
  } catch (erro) {
    responderErro(resposta, erro, 'admin.reenviarOutbox');
  }
}

export async function obterResumoFilas(_req, resposta) {
  try {
    const [inbox, outbox] = await Promise.all([resumoInbox(), resumoOutbox()]);
    resposta.json({ inbox, outbox });
  } catch (erro) {
    responderErro(resposta, erro, 'admin.obterResumoFilas');
  }
}

export async function listarErrosCapturados(requisicao, resposta) {
  try {
    resposta.json({ erros: await listarErros({ limite: requisicao.query.limite }) });
  } catch (erro) {
    responderErro(resposta, erro, 'admin.listarErrosCapturados');
  }
}
