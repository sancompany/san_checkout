/**
 * SAN CHECKOUT v2 — src/utils/puxarDoContratante.js
 *
 * A ida do checkout até a API do contratante (o "pull" do modelo —
 * `API.md` §1), com os dois buracos que o ciclo de segurança da Estação
 * 6 deixou declarados e não fechados (`docs/pendencias.md`, "SSRF
 * residual").
 *
 * O cadastro do contratante já é conferido por `alvoDeRedeSeguro`:
 * `api_base_url` precisa ser https e de host público (RN-14). Mas essa
 * checagem é ESTÁTICA, feita uma vez, sobre o endereço cadastrado — e
 * quem responde é o servidor do contratante. Faltavam duas coisas:
 *
 *   1. REDIRECIONAMENTO. O `fetch` segue redirect sozinho, sem perguntar.
 *      Um contratante malicioso — ou só comprometido — responde `302` para
 *      `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
 *      e o checkout busca a credencial da nuvem e devolve o corpo pro
 *      chamador. A checagem de cadastro não vê isso: o endereço
 *      cadastrado continua público e https; quem virou o alvo foi a
 *      resposta.
 *
 *   2. TAMANHO DO CORPO. `resposta.json()` lê até o fim, sem teto. A
 *      instância tem 512 MiB; um corpo de alguns giga derruba o processo
 *      — e com ele a confirmação de pagamento de TODOS os contratantes,
 *      que é o mesmo dano do `fetch` sem timeout de 15/09
 *      (`CONSTRAINTS.md` §2.7.1).
 *
 * As três decisões que este arquivo toma, e por quê:
 *
 * - **Segue redirect, mas revalida cada salto.** Recusar redirect por
 *   inteiro quebraria o contratante que só corrige barra final ou sobe
 *   de http para https, e isso é a maioria dos redirects honestos.
 *
 * - **Redirect para OUTRA origem é recusado.** Não é só SSRF: a
 *   requisição leva a `X-Checkout-Key` do contratante no cabeçalho, que é
 *   a credencial de CONSULTA E ESTORNO dele. Seguir para outra origem
 *   entregaria essa chave a quem respondeu o `Location`. Mandar sem a
 *   chave seria pior de entender (o destino legítimo responderia 401 e o
 *   erro apontaria para o lugar errado), então a recusa é explícita e o
 *   caminho de conserto é cadastrar o endereço final.
 *
 * - **O teto de corpo é contado no fluxo, não lido do `Content-Length`.**
 *   O cabeçalho vem de quem estamos desconfiando; acreditar nele é
 *   pedir para ser enganado por um corpo sem `Content-Length` ou com um
 *   valor mentiroso. O cabeçalho serve só para cortar cedo o que já se
 *   declara grande demais.
 */

import { alvoDeRedeSeguro } from './alvoDeRede.js';

/** Um pedido ou plano em JSON tem alguns KB. 1 MiB é folga de duas
 *  ordens de grandeza e ainda assim cabe 512 vezes na instância. */
export const TETO_CORPO_BYTES = 1024 * 1024;

/** Barra final, http→https e troca de caminho na mesma origem cabem
 *  nisto com sobra. Cadeia mais longa que isso é laço ou abuso. */
export const MAXIMO_DE_SALTOS = 3;

/** O erro que este módulo levanta para "a resposta do contratante não é
 *  aceitável". Quem chama traduz para a mensagem do comprador — daqui
 *  nunca sai texto de tela. */
export class RespostaRecusada extends Error {
  constructor(motivo) {
    super(motivo);
    this.name = 'RespostaRecusada';
    this.motivo = motivo;
  }
}

function mesmaOrigem(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Lê o corpo contando byte a byte e aborta ao passar do teto.
 *
 * `resposta.json()` não serve: ele só devolve depois de ler tudo, e "tudo"
 * é justamente o que não se pode deixar acontecer. Aqui o processo para
 * de ler assim que o limite estoura — o resto do corpo nunca entra na
 * memória.
 */
async function lerComTeto(resposta, teto) {
  const declarado = Number(resposta.headers.get('content-length'));
  if (Number.isFinite(declarado) && declarado > teto) {
    throw new RespostaRecusada('corpo grande demais');
  }

  if (!resposta.body) return '';

  const leitor = resposta.body.getReader();
  const pedacos = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      total += value.byteLength;
      if (total > teto) throw new RespostaRecusada('corpo grande demais');
      pedacos.push(value);
    }
  } finally {
    // Cancelar solta a conexão mesmo quando saímos pelo erro: sem isto,
    // o socket de um corpo gigante fica aberto até o timeout.
    await leitor.cancel().catch(() => {});
  }

  return new TextDecoder().decode(
    pedacos.length === 1 ? pedacos[0] : Buffer.concat(pedacos.map((p) => Buffer.from(p)))
  );
}

/**
 * GET autenticado na API do contratante, com redirect revalidado e corpo
 * com teto.
 *
 * @param {string} url endereço completo, já montado por quem chama
 * @param {object} opcoes
 * @param {string} opcoes.chave a `X-Checkout-Key` do contratante
 * @param {AbortSignal} opcoes.signal o mesmo timeout de quem chama
 * @param {number} [opcoes.teto] teto de corpo, em bytes
 * @param {function} [opcoes.aceitarAlvo] SÓ PARA O AUTOTESTE. O padrão é
 *        `alvoDeRedeSeguro`, e nenhum chamador de produção passa este
 *        parâmetro — a suíte `tests/pull-nao-segue-para-onde-quiser.js`
 *        varre o `src/` e falha se alguém passar. Ele existe porque o
 *        validador exige https com host público, e um servidor de teste
 *        vive em `http://127.0.0.1` — sem a injeção, a única forma de
 *        testar o redirect seria não testar.
 * @returns {Promise<{ status: number, corpo: any }>} `corpo` é `null`
 *          quando a resposta não é JSON utilizável — quem chama decide.
 * @throws {RespostaRecusada} redirect para fora, cadeia longa demais,
 *         alvo inseguro ou corpo acima do teto
 */
export async function puxarDoContratante(url, { chave, signal, teto = TETO_CORPO_BYTES, aceitarAlvo = alvoDeRedeSeguro }) {
  /* Teto de tempo é obrigatório, e a falta dele é erro de programação,
     não resposta ruim do contratante. A varredura de
     `tests/nenhuma-chamada-de-saida-sem-teto.js` vê o `signal` sendo
     repassado aqui dentro e fica satisfeita — ela não tem como saber se
     quem chamou passou algo. Este guarda tem. */
  if (!signal) throw new Error('puxarDoContratante exige um AbortSignal: chamada de saída sem teto de tempo.');

  let alvo = url;

  for (let salto = 0; salto <= MAXIMO_DE_SALTOS; salto += 1) {
    /* O alvo é revalidado a CADA salto, inclusive o primeiro. O primeiro
       já passou pela checagem de cadastro, mas revalidar aqui custa nada
       e fecha o caso de um `api_base_url` cadastrado antes da RN-14
       existir. */
    if (!aceitarAlvo(alvo)) throw new RespostaRecusada('alvo inseguro');

    const resposta = await fetch(alvo, {
      method: 'GET',
      headers: { 'X-Checkout-Key': chave },
      signal,
      // O ponto inteiro: nada é seguido sem passar pelas regras abaixo.
      redirect: 'manual'
    });

    const ehRedirect = resposta.status >= 300 && resposta.status < 400;
    if (!ehRedirect) {
      const texto = await lerComTeto(resposta, teto);
      let corpo = null;
      try { corpo = JSON.parse(texto); } catch { corpo = null; }
      return { status: resposta.status, corpo };
    }

    const destino = resposta.headers.get('location');
    if (!destino) throw new RespostaRecusada('redirect sem destino');

    // Relativo (`/pedido/x`) resolve contra o alvo atual e continua na
    // mesma origem — é o caso honesto mais comum.
    let proximo;
    try {
      proximo = new URL(destino, alvo).toString();
    } catch {
      throw new RespostaRecusada('redirect com destino inválido');
    }

    if (!mesmaOrigem(proximo, url)) throw new RespostaRecusada('redirect para outra origem');

    alvo = proximo;
  }

  throw new RespostaRecusada('redirect demais');
}
