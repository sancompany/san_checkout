/**
 * src/utils/rotaSegura.js — handler do Express que lança não derruba o
 * processo (C1-01, remediação da Estação 6).
 *
 * O Express 4 não observa a promessa que um handler `async` devolve: uma
 * exceção depois do primeiro `await` vira rejeição sem dono, e o tratador
 * de `unhandledRejection` do `server.js` encerra o processo de propósito
 * (Lei 8). Com uma instância só, qualquer pedido que faça um handler
 * lançar derrubaria checkout, webhook e workers juntos.
 *
 * `comRejeicaoTratada(alvo)` troca os métodos de registro (`use`, `get`,
 * `post`…) do `app` ou do roteador por versões que envolvem cada handler:
 * o que ele lançar, síncrono ou assíncrono, vai para `next(erro)` — o
 * tratador de erro do fim da pilha, que responde 500 genérico e grava em
 * `erros`. Fica de fora, intocado:
 *   - tratador de erro (4 parâmetros): o Express o reconhece pela aridade;
 *   - roteador e sub-app montados (têm `.handle`): quem os protege é o
 *     `comRejeicaoTratada` deles próprios — por isso `roteador()`.
 *
 * `tests/rota-que-lanca-nao-derruba-o-processo.js` confere que nenhum
 * `Router()`/`express()` de `src/` nasce sem isto.
 */
import { Router } from 'express';

const METODOS = ['use', 'all', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function envolver(handler) {
  if (Array.isArray(handler)) return handler.map(envolver);
  if (typeof handler !== 'function' || handler.length === 4 || typeof handler.handle === 'function') return handler;
  return function handlerComDono(requisicao, resposta, proximo) {
    /* FP1B-1: o motivo vira SEMPRE um Error. Um `throw undefined` (ou uma
       rejeição com `null`, `'route'`) chegava ao `next()` como "siga em
       frente" — numa guarda, isso era passar adiante em vez de recusar. */
    const falhar = (erro) => {
      if (erro instanceof Error) return proximo(erro);
      /* FP1R-B-1/B-2: o texto de um objeto qualquer pode LANÇAR
         (`Object.create(null)`), e isso aqui dentro seria uma rejeição sem
         dono; e o erro do PostgREST é objeto puro — sem guardar `code` e
         `message`, todo 500 do banco virava "[object Object]" e a mesma
         impressão digital em `erros`. */
      let texto = 'motivo ilegível';
      try { texto = typeof erro?.message === 'string' ? erro.message : String(erro); } catch { /* fica o texto fixo */ }
      const embrulho = new Error(`handler falhou sem Error: ${texto}`);
      try { if (erro && typeof erro === 'object') { embrulho.cause = erro; if (typeof erro.code === 'string') embrulho.code = erro.code; } } catch { /* idem */ }
      return proximo(embrulho);
    };
    try {
      const resultado = handler.call(this, requisicao, resposta, proximo);
      if (resultado && typeof resultado.then === 'function') resultado.then(undefined, falhar);
      return resultado;
    } catch (erro) {
      return falhar(erro);
    }
  };
}

export function comRejeicaoTratada(alvo) {
  for (const metodo of METODOS) {
    if (typeof alvo[metodo] !== 'function') continue; // o `Route` não tem `use`
    const original = alvo[metodo].bind(alvo);
    alvo[metodo] = (...argumentos) => original(...argumentos.map(envolver));
  }
  /* `router.route('/x').get(…)` registra no objeto `Route`, não no
     roteador — sem isto, o handler dele escaparia (C2-L4). */
  if (typeof alvo.route === 'function') {
    const rota = alvo.route.bind(alvo);
    alvo.route = (...argumentos) => comRejeicaoTratada(rota(...argumentos));
  }
  return alvo;
}

/** O `Router()` do projeto: nenhum handler dele derruba o processo. */
export const roteador = () => comRejeicaoTratada(Router());
