/**
 * SAN CHECKOUT v2 — src/config/supabase.js
 * Cliente Supabase do backend do checkout.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('[supabase] SUPABASE_URL ou SUPABASE_SERVICE_KEY ausentes no .env.');
}

/**
 * Teto de tempo em TODA ida ao banco (INFO-09, 25/09/2026). O cliente do
 * Supabase usa o `fetch` global, e `fetch` sem `signal` espera para
 * sempre: um Supabase que aceita a conexão e não responde pendurava a
 * requisição do comprador E a passada do worker — que, pendurada, nunca
 * mais roda (`utils/passadas.js` não deixa a seguinte começar). 20 s é
 * muito acima de qualquer consulta deste projeto, e é a mesma ordem do
 * teto da Asaas. Um `signal` que o chamador já passe continua valendo.
 */
const TIMEOUT_SUPABASE_MS = 20_000;

function fetchComTeto(url, opcoes = {}) {
  const controlador = new AbortController();
  const teto = setTimeout(() => controlador.abort(), TIMEOUT_SUPABASE_MS);
  teto.unref?.();
  opcoes.signal?.addEventListener('abort', () => controlador.abort(), { once: true });
  /* `error`, nunca seguir (SEC-006): a chave `service_role` vai no
     cabeçalho `apikey`, que é próprio do Supabase — num redirecionamento
     o `fetch` só descarta `Authorization`, e o `apikey` seguiria para o
     destino novo. O PostgREST não redireciona nada que usamos. */
  return fetch(url, { ...opcoes, signal: controlador.signal, redirect: 'error' });
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { global: { fetch: fetchComTeto } });
