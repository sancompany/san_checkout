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
import { compararSeguro, documentoValido, emailValido, cepValido } from '../utils/validadores.js';
import { senhaConfere } from '../utils/senhaAdmin.js';
import { emitirToken, verificarToken, VALIDADE_SEGUNDOS } from '../utils/sessaoAdmin.js';
import { responderErro } from '../utils/erros.js';
import { criarSubconta as criarSubcontaNaAsaas, tipoDaContaMae } from '../services/asaasService.js';
import { METODOS_VALIDOS } from '../services/pedidoService.js';
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

  let consulta = supabase
    .from('contratantes')
    .select('id, nome, api_base_url, api_key, webhook_url, wallet_id, metodos_habilitados, criado_em, arquivado_em')
    .order('criado_em', { ascending: false });

  if (!incluirArquivados) consulta = consulta.is('arquivado_em', null);

  const { data, error } = await consulta;
  if (error) return responderErro(resposta, error, 'admin.listarContratantes');
  resposta.json(data);
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

function slugValido(valor) {
  return /^[a-z0-9][a-z0-9-]{1,49}$/.test(String(valor ?? ''));
}

function urlValida(valor) {
  try {
    new URL(valor);
    return true;
  } catch {
    return false;
  }
}

/** undefined = não mexe (usado no PATCH); lista inválida = null (rejeita). */
function metodosHabilitadosValidos(valor) {
  if (valor === undefined) return undefined;
  if (!Array.isArray(valor) || valor.length === 0) return null;
  return valor.every((m) => METODOS_VALIDOS.includes(m)) ? valor : null;
}

export async function criarContratante(requisicao, resposta) {
  const { id, nome, apiBaseUrl, webhookUrl, walletId, metodosHabilitados } = requisicao.body ?? {};

  if (!slugValido(id)) {
    return resposta.status(400).json({ erro: 'id inválido — use um slug (letras minúsculas, números, hífen), ex.: "trimundi9".' });
  }
  if (!nome) return resposta.status(400).json({ erro: 'nome é obrigatório.' });
  if (!urlValida(apiBaseUrl)) return resposta.status(400).json({ erro: 'apiBaseUrl precisa ser uma URL válida.' });
  if (webhookUrl && !urlValida(webhookUrl)) return resposta.status(400).json({ erro: 'webhookUrl precisa ser uma URL válida.' });

  const metodos = metodosHabilitados === undefined ? METODOS_VALIDOS : metodosHabilitadosValidos(metodosHabilitados);
  if (metodos === null) return resposta.status(400).json({ erro: `metodosHabilitados precisa ser uma lista não-vazia com valores entre: ${METODOS_VALIDOS.join(', ')}.` });

  // Sempre gerada aqui, nunca aceita do body — evita chave fraca ou
  // reaproveitada entre projetos.
  const apiKey = randomBytes(24).toString('hex');

  const { data, error } = await supabase
    .from('contratantes')
    .insert({
      id,
      nome,
      api_base_url: apiBaseUrl,
      api_key: apiKey,
      webhook_url: webhookUrl || null,
      wallet_id: walletId || null,
      metodos_habilitados: metodos
    })
    .select('id, nome, api_base_url, api_key, webhook_url, wallet_id, metodos_habilitados, criado_em')
    .single();

  if (error) {
    if (error.code === '23505') return resposta.status(409).json({ erro: `Já existe um contratante com id "${id}".` });
    return responderErro(resposta, error, 'admin.criarContratante');
  }

  resposta.status(201).json(data);
}

/**
 * PATCH /api/admin/contratantes/:id — edita um contratante já
 * cadastrado. Todo campo é opcional (só atualiza o que vier no body);
 * `id` e `api_key` nunca mudam por aqui (api_key é o segredo que o
 * contratante já usa pra chamar /estornar — trocar quebraria a
 * integração dele sem aviso).
 */
export async function atualizarContratante(requisicao, resposta) {
  const { id } = requisicao.params;
  const { nome, apiBaseUrl, webhookUrl, walletId, metodosHabilitados } = requisicao.body ?? {};

  if (apiBaseUrl !== undefined && !urlValida(apiBaseUrl)) {
    return resposta.status(400).json({ erro: 'apiBaseUrl precisa ser uma URL válida.' });
  }
  if (webhookUrl && !urlValida(webhookUrl)) return resposta.status(400).json({ erro: 'webhookUrl precisa ser uma URL válida.' });

  const metodos = metodosHabilitadosValidos(metodosHabilitados);
  if (metodos === null) return resposta.status(400).json({ erro: `metodosHabilitados precisa ser uma lista não-vazia com valores entre: ${METODOS_VALIDOS.join(', ')}.` });

  const patch = {};
  if (nome !== undefined) patch.nome = nome;
  if (apiBaseUrl !== undefined) patch.api_base_url = apiBaseUrl;
  if (webhookUrl !== undefined) patch.webhook_url = webhookUrl || null;
  if (walletId !== undefined) patch.wallet_id = walletId || null;
  if (metodos !== undefined) patch.metodos_habilitados = metodos;

  if (Object.keys(patch).length === 0) return resposta.status(400).json({ erro: 'Nenhum campo pra atualizar.' });

  const { data, error } = await supabase
    .from('contratantes')
    .update(patch)
    .eq('id', id)
    .select('id, nome, api_base_url, api_key, webhook_url, wallet_id, metodos_habilitados, criado_em')
    .maybeSingle();

  if (error) return responderErro(resposta, error, 'admin.atualizarContratante');
  if (!data) return resposta.status(404).json({ erro: 'Contratante não encontrado.' });

  resposta.json(data);
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
export async function obterMetricas(requisicao, resposta) {
  const dias = Math.min(Number(requisicao.query.dias) || 30, 365);
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('cobrancas')
    .select('contratante_id, metodo_pagamento, status, valor_cobrado, criado_em')
    .gte('criado_em', desde);

  if (error) return responderErro(resposta, error, 'admin.obterMetricas');

  const CONFIRMADOS = ['confirmado'];
  // Cobrança que ainda pode virar pagamento não conta como perdida —
  // senão a taxa de hoje sempre pareceria péssima.
  const EM_ABERTO = ['pendente', 'em_analise'];

  const vazio = () => ({ geradas: 0, pagas: 0, emAberto: 0, perdidas: 0, valorPago: 0 });
  const porMetodo = {};
  const porContratante = {};
  const total = vazio();

  for (const c of data ?? []) {
    const metodo = c.metodo_pagamento ?? 'desconhecido';
    const contratante = c.contratante_id ?? 'sem contratante';
    porMetodo[metodo] ??= vazio();
    porContratante[contratante] ??= vazio();

    const paga = CONFIRMADOS.includes(c.status);
    const aberta = EM_ABERTO.includes(c.status);

    for (const alvo of [total, porMetodo[metodo], porContratante[contratante]]) {
      alvo.geradas += 1;
      if (paga) { alvo.pagas += 1; alvo.valorPago += Number(c.valor_cobrado ?? 0); }
      else if (aberta) alvo.emAberto += 1;
      else alvo.perdidas += 1;
    }
  }

  /** Taxa sobre o que já se RESOLVEU (pagas + perdidas). Incluir o que
   *  ainda está em aberto no denominador faria a taxa parecer pior só
   *  porque a cobrança é recente. */
  const comTaxa = (n) => {
    const resolvidas = n.pagas + n.perdidas;
    return {
      ...n,
      valorPago: Math.round(n.valorPago * 100) / 100,
      taxaPagamento: resolvidas > 0 ? Math.round((n.pagas / resolvidas) * 1000) / 10 : null
    };
  };

  const mapear = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, comTaxa(v)]));

  resposta.json({
    periodoDias: dias,
    desde,
    total: comTaxa(total),
    porMetodo: mapear(porMetodo),
    porContratante: mapear(porContratante)
  });
}

// --- Subcontas Asaas ---------------------------------------------------
// Tela separada do cadastro de contratante (ver INTEGRACAO.md/status-
// atual.md): cria a conta na Asaas via API (POST /v3/accounts) em vez
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
  resposta.json(data);
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
 * A consulta extra só roda no caminho do erro, nunca no caminho feliz,
 * e falhar nela não pode piorar a mensagem original — por isso o catch
 * devolve string vazia em vez de estourar.
 */
async function explicarRecusaDeSubconta(erroAsaas) {
  if (erroAsaas.status !== 401 && erroAsaas.status !== 403) return '';

  try {
    const { tipo, companyType } = await tipoDaContaMae();
    if (tipo === 'fisica') {
      return 'sua conta-mãe na Asaas (neste ambiente) está cadastrada como PESSOA FÍSICA (CPF), '
        + 'e a Asaas só deixa conta pessoa jurídica (CNPJ) criar subconta. '
        + 'Troque o cadastro da conta para CNPJ no painel da Asaas deste ambiente, ou peça a liberação ao suporte.';
    }
    if (tipo === 'juridica') {
      return `a conta-mãe é pessoa jurídica${companyType ? ` (${companyType})` : ''}, então o problema NÃO é o tipo de conta — `
        + 'restam permissão de subcontas não liberada nesta conta ou CNAE incompatível. Isso se resolve com o suporte da Asaas.';
    }
    return 'não consegui ler o tipo da conta-mãe para dizer o porquê — confira no painel da Asaas deste ambiente se ela é CNPJ.';
  } catch {
    return '';
  }
}

export async function criarSubconta(requisicao, resposta) {
  const corpo = requisicao.body ?? {};
  const documentoDigitos = String(corpo.documento ?? '').replace(/\D/g, '');
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
  const dias = Math.min(Number(requisicao.query.dias) || 7, 90);
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
