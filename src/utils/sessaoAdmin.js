/**
 * SAN CHECKOUT — src/utils/sessaoAdmin.js
 *
 * Token de sessão do painel administrativo.
 *
 * O PROBLEMA QUE ELE RESOLVE
 * A senha do admin é verificada com scrypt a N=2^17 — ~830 ms de CPU por
 * derivação, medido em produção em 12/09/2026. Isso é correto e
 * deliberado: é o que torna caro tentar adivinhar a senha.
 *
 * O erro era COBRAR ESSE PREÇO EM TODA REQUISIÇÃO. Cada clique no painel
 * remandava usuário e senha, e o servidor derivava de novo. Arquivar um
 * contratante custava três requisições — o PATCH e duas recargas de
 * lista —, ou seja ~2,5 s de espera para uma operação que toca uma linha
 * do banco. E o custo era do SERVIDOR: 10 requisições por minuto
 * significavam 8,3 s de CPU por minuto numa instância de 0,5 vCPU.
 *
 * Derivação de senha serve para **provar quem você é**, uma vez. O que
 * mantém você autenticado depois disso é um token — barato de verificar,
 * caro de forjar.
 *
 * O DESENHO, E POR QUE CADA ESCOLHA
 *
 * **Assinado, não guardado.** O token carrega o usuário e o vencimento,
 * mais um HMAC do conteúdo. Verificar é recalcular o HMAC:
 * microssegundos, sem banco, sem memória compartilhada. Guardar sessão
 * numa tabela custaria uma ida ao banco por requisição — trocaria 830 ms
 * de CPU por 35 ms de rede, quando dá para gastar zero.
 *
 * **A chave do HMAC é derivada do HASH DA SENHA.** Não é enfeite: trocar
 * a senha do admin passa a **invalidar todos os tokens existentes**,
 * automaticamente, sem lista de revogação e sem código extra. É a
 * propriedade que se espera de "troquei a senha" e que quase nenhum
 * esquema de token entrega de graça.
 *
 * **Sem segredo novo no ambiente.** Uma variável a mais é uma variável a
 * mais para faltar num deploy — e o modo de falha de um segredo de
 * assinatura ausente é o pior que existe: assinar com vazio e aceitar
 * qualquer token. Derivando do hash, que já é obrigatório, esse caminho
 * não existe.
 *
 * O QUE ELE DELIBERADAMENTE NÃO FAZ
 * Não há revogação individual. Sair do painel apaga o token do
 * navegador, que é exatamente a mesma garantia de antes, quando sair
 * apagava a senha guardada. Token roubado vale até vencer; senha
 * roubada valia para sempre. É estritamente melhor que o que havia, e o
 * limite fica declarado no CONSTRAINTS.md §2.6.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

/** Oito horas: um dia de trabalho do operador sem reentrar, e nada além
 *  disso. Token que não vence é senha com outro nome. */
export const VALIDADE_SEGUNDOS = 8 * 60 * 60;

/** Rótulo de contexto no HMAC. Impede que a mesma chave, se um dia for
 *  usada para assinar outra coisa, produza assinaturas intercambiáveis
 *  entre os dois usos. */
const CONTEXTO = 'sessao-admin-v1';

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deBase64url(texto) {
  return Buffer.from(String(texto).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** A chave de assinatura sai do hash da senha — ver o cabeçalho. */
function chaveDeAssinatura(hashDaSenha) {
  return createHmac('sha256', String(hashDaSenha ?? '')).update(CONTEXTO).digest();
}

function assinar(corpo, hashDaSenha) {
  return base64url(createHmac('sha256', chaveDeAssinatura(hashDaSenha)).update(corpo).digest());
}

/**
 * Emite um token. Chamado UMA vez, depois de a senha conferir.
 * @param {string} usuario
 * @param {string} hashDaSenha — o CHECKOUT_ADMIN_PASS_HASH
 */
export function emitirToken(usuario, hashDaSenha) {
  const conteudo = {
    u: String(usuario ?? ''),
    exp: Math.floor(Date.now() / 1000) + VALIDADE_SEGUNDOS,
    /* Um nonce, para que dois logins seguidos do mesmo usuário no mesmo
       segundo não gerem o mesmo token. Não é segurança — a assinatura é
       —, é higiene: token repetido confunde qualquer diagnóstico. */
    n: base64url(randomBytes(9))
  };
  const corpo = base64url(JSON.stringify(conteudo));
  return `${corpo}.${assinar(corpo, hashDaSenha)}`;
}

/**
 * Verifica um token. É o caminho quente: roda em toda requisição do
 * painel e precisa custar praticamente nada.
 *
 * @returns {{ valido: boolean, usuario?: string, motivo?: string }}
 */
export function verificarToken(token, hashDaSenha) {
  if (typeof token !== 'string' || !token) return { valido: false, motivo: 'ausente' };
  if (!hashDaSenha) return { valido: false, motivo: 'sem hash configurado' };

  const partes = token.split('.');
  if (partes.length !== 2) return { valido: false, motivo: 'formato' };

  const [corpo, assinaturaRecebida] = partes;

  /* Compara a assinatura ANTES de olhar o conteúdo. O conteúdo vem de
     fora; só depois de a assinatura fechar é que ele deixa de ser texto
     de estranho e passa a ser dado nosso. */
  const esperada = Buffer.from(assinar(corpo, hashDaSenha));
  const recebida = Buffer.from(String(assinaturaRecebida));
  if (recebida.length === 0 || recebida.length !== esperada.length) {
    return { valido: false, motivo: 'assinatura' };
  }
  if (!timingSafeEqual(recebida, esperada)) return { valido: false, motivo: 'assinatura' };

  let conteudo;
  try {
    conteudo = JSON.parse(deBase64url(corpo).toString('utf8'));
  } catch {
    return { valido: false, motivo: 'conteudo' };
  }

  if (!Number.isInteger(conteudo?.exp)) return { valido: false, motivo: 'sem vencimento' };
  if (conteudo.exp <= Math.floor(Date.now() / 1000)) return { valido: false, motivo: 'vencido' };

  return { valido: true, usuario: String(conteudo.u ?? '') };
}

/* ====================================================================
   AUTOTESTE — `node src/utils/sessaoAdmin.js`
   ==================================================================== */
if (process.argv[1]?.endsWith('sessaoAdmin.js')) {
  const assertReal = (await import('node:assert/strict')).default;
  /* O número de checagens era CHUMBADO no `console.log` do fim, e já
     estava errado — acrescentar assertiva não mexia nele. Contador
     chumbado é documento falso barato de produzir e caro de notar, e em
     17/09/2026 oito autotestes deste repositório tinham um. O proxy
     conta sem precisar reescrever as chamadas que já estavam aqui. */
  let checagens = 0;
  const assert = new Proxy(assertReal, {
    get(alvo, nome) {
      const valor = alvo[nome];
      if (typeof valor !== 'function') return valor;
      return (...argumentos) => { checagens += 1; return valor.apply(alvo, argumentos); };
    }
  });

  const HASH = 'scrypt$131072$8$1$c2FsdA==$aGFzaA==';

  const t = emitirToken('operador', HASH);
  assert.ok(t.includes('.'), 'token tem as duas partes');
  assert.equal(verificarToken(t, HASH).valido, true, 'token recém-emitido vale');
  assert.equal(verificarToken(t, HASH).usuario, 'operador', 'devolve o usuário');

  // --- forjar não pode funcionar ---
  assert.equal(verificarToken(t, 'scrypt$131072$8$1$b3V0cm8=$b3V0cm8=').valido, false, 'token não vale com OUTRO hash');
  assert.equal(verificarToken(t.slice(0, -1) + 'x', HASH).valido, false, 'assinatura adulterada não vale');
  const [corpo] = t.split('.');
  assert.equal(verificarToken(`${corpo}.`, HASH).valido, false, 'assinatura vazia não vale');
  assert.equal(verificarToken(corpo, HASH).valido, false, 'sem assinatura não vale');

  /* O ataque óbvio: trocar o conteúdo mantendo a assinatura. Alguém
     edita o vencimento para 2099 e reenvia. */
  const falsificado = JSON.parse(deBase64url(corpo).toString('utf8'));
  falsificado.exp = 4102444800;
  const corpoFalso = base64url(JSON.stringify(falsificado));
  assert.equal(verificarToken(`${corpoFalso}.${t.split('.')[1]}`, HASH).valido, false, 'conteúdo trocado com assinatura velha não vale');

  // --- vencimento ---
  const vencido = base64url(JSON.stringify({ u: 'x', exp: Math.floor(Date.now() / 1000) - 1, n: 'z' }));
  assert.equal(verificarToken(`${vencido}.${assinar(vencido, HASH)}`, HASH).valido, false, 'token vencido não vale');
  assert.equal(verificarToken(`${vencido}.${assinar(vencido, HASH)}`, HASH).motivo, 'vencido', 'e diz que venceu');

  /* Sem vencimento é recusa, não "vale para sempre". Falhar fechado. */
  const semExp = base64url(JSON.stringify({ u: 'x', n: 'z' }));
  assert.equal(verificarToken(`${semExp}.${assinar(semExp, HASH)}`, HASH).valido, false, 'token sem vencimento não vale');

  // --- lixo e ausência ---
  for (const lixo of ['', null, undefined, 42, 'a.b.c', 'semponto', {}]) {
    assert.equal(verificarToken(lixo, HASH).valido, false, `lixo não vale: ${String(lixo)}`);
  }
  assert.equal(verificarToken(t, '').valido, false, 'sem hash configurado, nada vale');
  assert.equal(verificarToken(t, undefined).valido, false, 'hash indefinido, nada vale');

  // --- dois tokens seguidos são diferentes ---
  assert.notEqual(emitirToken('a', HASH), emitirToken('a', HASH), 'dois logins geram tokens diferentes');

  // --- e o que importa: é barato ---
  const inicio = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) verificarToken(t, HASH);
  const msPorVerificacao = Number(process.hrtime.bigint() - inicio) / 1e6 / 1000;
  assert.ok(msPorVerificacao < 1, `verificar precisa custar menos de 1ms (custou ${msPorVerificacao.toFixed(3)}ms)`);

  console.log(`sessaoAdmin: ${checagens} checagens OK — ${(msPorVerificacao * 1000).toFixed(0)}µs por verificação, contra ~830ms do scrypt`);
}
