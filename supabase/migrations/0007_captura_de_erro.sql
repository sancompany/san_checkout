-- 0007 — captura de exceção com contexto (Lei 8)
--
-- A Lei 8 pede, para projeto com usuário externo, "captura de exceção
-- com contexto da requisição". Até aqui o erro inesperado ia só para
-- `console.error`, e o log do painel do Northflank tem retenção curta:
-- o erro que importa acontece daqui a três semanas, às duas da manhã,
-- num webhook — e quando alguém for procurar, já não está lá.
--
-- ── Por que AGREGA por impressão digital, e não uma linha por erro ───
-- Uma linha por ocorrência daria escrita ilimitada no banco a qualquer
-- um que descobrisse uma rota pública que devolve 500. É o mesmo risco
-- que o `CONSTRAINTS.md` §2.5 já tinha resolvido para as tentativas
-- recusadas do webhook, e a resposta aqui é a mesma ideia por outro
-- caminho: a chave primária é a impressão digital do erro
-- (contexto + tipo + primeiro quadro da pilha), então o tamanho da
-- tabela é limitado pelos pontos de erro que EXISTEM no nosso código,
-- não pelo número de requisições. Repetição vira `ocorrencias + 1`.
--
-- Isso também é melhor para operar: "este erro aconteceu 4.312 vezes
-- desde terça" é a informação útil; 4.312 linhas iguais não são.
--
-- ── O que NÃO entra aqui, e por quê ──────────────────────────────────
-- Nada de corpo da requisição, query string, cabeçalho, IP ou URL com
-- valores. A mesma lista branca do §2.5, pelo mesmo motivo: o que não
-- está previsto não entra. `rota` guarda o PADRÃO do Express
-- (`/api/checkout/status/:contratanteId/:pedidoId`), nunca a URL real —
-- a URL real carrega o `pedidoId`, que por desenho é imprevisível
-- (`exigirIdImprevisivel`) e portanto é credencial, não identificador.
--
-- `mensagem` é o único campo de texto livre, e é raspado antes de
-- gravar (`rasparMensagem`, em `src/services/erroService.js`).
--
-- ── Retenção ─────────────────────────────────────────────────────────
-- 30 dias, mais curto que os 90 da auditoria do webhook: isto é
-- diagnóstico, não rastro de cobrança. Expurgo junto do que já roda no
-- boot e a cada 24h (`server.js`).

create table if not exists erros (
  -- contexto + tipo + primeiro quadro nosso da pilha, em sha256.
  impressao_digital text primary key,

  contexto    text not null,          -- o rótulo que `responderErro` já recebe
  rota        text,                   -- PADRÃO da rota, nunca a URL com valores
  metodo      text,
  status      integer,
  nome        text,                   -- TypeError, PostgrestError, ...
  codigo      text,                   -- 23505, ECONNRESET, ...
  mensagem    text,                   -- raspada e truncada
  pilha       text,                   -- só quadros de src/, sem caminho absoluto

  ocorrencias  integer     not null default 1,
  primeira_vez timestamptz not null default now(),
  ultima_vez   timestamptz not null default now()
);

-- O painel lê "o que está acontecendo agora", então a ordem é por
-- última vez, decrescente.
create index if not exists idx_erros_ultima_vez on erros (ultima_vez desc);

-- Mesma postura das outras tabelas: o backend fala por service_role, que
-- ignora RLS. Sem policy nenhuma, `anon` e `authenticated` ficam negados
-- por padrão caso a anon key vaze ou seja usada por engano.
alter table erros enable row level security;

-- ── O incremento tem de ser atômico ──────────────────────────────────
-- Um `upsert` pelo cliente do Supabase sobrescreveria `ocorrencias` com
-- 1 a cada gravação, e ler-somar-escrever pela aplicação perde contagem
-- em duas requisições simultâneas — que é exatamente o cenário de um
-- erro em rajada, o único momento em que a contagem importa.
--
-- `set search_path = ''` e nome qualificado: mesma regra da migration
-- 0004, para a função não resolver `erros` num schema plantado por
-- quem controlar o search_path da sessão.
create or replace function public.registrar_erro(
  p_impressao text,
  p_contexto  text,
  p_rota      text,
  p_metodo    text,
  p_status    integer,
  p_nome      text,
  p_codigo    text,
  p_mensagem  text,
  p_pilha     text
) returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.erros (
    impressao_digital, contexto, rota, metodo, status, nome, codigo, mensagem, pilha
  ) values (
    p_impressao, p_contexto, p_rota, p_metodo, p_status, p_nome, p_codigo, p_mensagem, p_pilha
  )
  on conflict (impressao_digital) do update set
    ocorrencias = public.erros.ocorrencias + 1,
    ultima_vez  = now(),
    -- o estado mais recente vence: mesmo bug pode mudar de status ou de
    -- mensagem entre versões, e o que se depura é o de agora.
    status      = excluded.status,
    mensagem    = excluded.mensagem,
    codigo      = excluded.codigo,
    rota        = coalesce(excluded.rota, public.erros.rota);
$$;
