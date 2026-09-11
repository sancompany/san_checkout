-- =====================================================================
-- 0002 — LOG DE AUDITORIA DO WEBHOOK DA ASAAS.
--
-- Rodar UMA vez no SQL Editor do Supabase, depois do 0001. Não editar
-- este arquivo depois de aplicado — correção é 0003 (Lei 6, regra em
-- CONSTRAINTS.md §2.1).
--
-- POR QUE EXISTE
-- Até aqui, evento que o código não trata tinha um destino só:
-- `console.log` no Render, retenção curta, e só aparece pra quem for
-- olhar. Isso torna inútil marcar evento "pra usar um dia" — ele chega
-- e some. Estas duas tabelas dão destino visível a esse evento, e é o
-- que a Lei 8 (observabilidade) pede neste projeto.
--
-- O QUE ELAS DELIBERADAMENTE NÃO GUARDAM
-- O payload cru. O webhook da Asaas carrega nome, e-mail, CPF/CNPJ,
-- telefone e endereço do comprador; gravar isso numa tabela seria
-- trocar um vazamento que expira (log do Render) por um permanente,
-- com backup, consulta e uma tela a mais onde CPF aparece. O que entra
-- em `campos` é o resultado da redação por LISTA BRANCA feita no
-- `auditoriaWebhookService.js`: escalar de uso diagnóstico entra com
-- valor, todo o resto vira só o CAMINHO da chave, sem valor nenhum.
-- Lista branca e não lista negra porque lista negra falha aberta, e
-- falhar aberta aqui significa CPF na tabela.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Uma linha por webhook recebido (já autenticado pela guarda).
-- ---------------------------------------------------------------------
create table if not exists webhook_eventos (
  id uuid primary key default gen_random_uuid(),
  recebido_em timestamptz not null default now(),

  evento text,                     -- nome do evento Asaas, como veio
  rota text,                       -- qual ramo do roteador pegou: checkout,
                                   -- payment, subconta, chave_api,
                                   -- pix_automatico — nulo quando nenhum
  resultado text not null,         -- tratado | nao_mapeado | erro
  detalhe text,                    -- mensagem curta quando resultado = erro

  referencia_tipo text,            -- payment | checkout | subscription | account
  referencia_id text,              -- payment.id / checkout.id / account.id
  status_mapeado text,             -- status local que o evento gerou, se gerou

  campos jsonb                     -- redigido; ver o bloco acima
);

-- Sem `cobranca_id`/`contratante_id` de propósito: preencher essas
-- colunas exigiria uma consulta a mais POR WEBHOOK, no caminho onde
-- dinheiro é confirmado, só para enfeitar uma coluna de diagnóstico.
-- O `referencia_id` já é o `charge_id`/`asaas_checkout_id`, então o
-- painel resolve o contratante numa consulta só, sobre a página que
-- está sendo exibida — custo na leitura, que é rara, em vez de na
-- escrita, que é o caminho crítico.

create index if not exists idx_webhook_eventos_recebido on webhook_eventos(recebido_em desc);
create index if not exists idx_webhook_eventos_resultado on webhook_eventos(resultado, recebido_em desc);
create index if not exists idx_webhook_eventos_evento on webhook_eventos(evento, recebido_em desc);
create index if not exists idx_webhook_eventos_referencia on webhook_eventos(referencia_id);

-- ---------------------------------------------------------------------
-- 2. Tentativas RECUSADAS pela guarda de origem, agregadas por hora.
--
-- Uma linha por requisição seria caminho de escrita ilimitada aberto a
-- quem não tem token nenhum: quem descobrisse a URL encheria a tabela
-- de graça. Por hora, o pior caso é 24 linhas por dia, independente do
-- volume da sondagem — e `amostras` é limitada a 20 por hora, então
-- nem ela cresce com o ataque.
--
-- Estas linhas NÃO são expurgadas: são minúsculas e o total histórico
-- é a soma delas. O que expira são as amostras (ver o expurgo no
-- auditoriaWebhookService.js).
-- ---------------------------------------------------------------------
create table if not exists webhook_rejeicoes (
  hora timestamptz primary key,    -- início da hora, em UTC
  total integer not null default 0,
  amostras jsonb not null default '[]'::jsonb
);

-- O token errado NUNCA entra na amostra. Além de ser credencial em
-- texto puro (proibido pela skill `seguranca-san`), quem erra de letra
-- ao digitar o token CERTO gravaria o token certo aqui dentro. A
-- amostra guarda só: quando, de qual IP, e se veio header de token.

-- ---------------------------------------------------------------------
-- 3. Dobra atômica do lote de rejeições numa linha de hora.
--
-- O backend acumula em memória e descarrega de tempos em tempos, então
-- o incremento chega como lote. Ler-somar-gravar do lado do Node seria
-- corrida se um dia existir mais de uma instância; aqui é uma
-- instrução só.
--
-- `security invoker` (o padrão, explicitado de propósito): se um dia a
-- SUPABASE_ANON_KEY vazar, a chamada roda como `anon` e esbarra na RLS
-- abaixo em vez de escrever. Função com direitos do dono seria um furo
-- com o formato exato do que a RLS existe para fechar.
-- ---------------------------------------------------------------------
create or replace function registrar_rejeicoes_webhook(
  p_hora timestamptz,
  p_quantidade integer,
  p_amostras jsonb
) returns void
language sql
security invoker
as $funcao$
  insert into webhook_rejeicoes (hora, total, amostras)
  values (p_hora, p_quantidade, coalesce(p_amostras, '[]'::jsonb))
  on conflict (hora) do update
    set total = webhook_rejeicoes.total + excluded.total,
        amostras = coalesce(
          (
            select jsonb_agg(item)
              from (
                select item
                  from jsonb_array_elements(webhook_rejeicoes.amostras || excluded.amostras) as item
                 limit 20
              ) as limitadas
          ),
          '[]'::jsonb
        );
$funcao$;

-- ---------------------------------------------------------------------
-- 4. Resumo histórico das rejeições.
--
-- O painel mostra o total desde sempre. Somar isso no Node exigiria
-- trazer todas as linhas de hora (uma por hora, para sempre) e ainda
-- esbarraria no limite de 1000 linhas do PostgREST depois de 41 dias.
-- Uma agregação no banco devolve dois números.
-- ---------------------------------------------------------------------
create or replace function resumo_rejeicoes_webhook()
returns table (total_geral bigint, primeira_hora timestamptz)
language sql
security invoker
as $resumo$
  select coalesce(sum(total), 0)::bigint, min(hora) from webhook_rejeicoes;
$resumo$;

-- ---------------------------------------------------------------------
-- 5. RLS — mesma decisão do 0001: o backend usa a service_key, que
-- ignora RLS; isto fecha a porta caso a anon key vaze ou seja usada
-- por engano. Sem policy nenhuma, fica tudo negado para anon e
-- authenticated. Custo zero para o backend atual.
-- ---------------------------------------------------------------------
alter table webhook_eventos enable row level security;
alter table webhook_rejeicoes enable row level security;

-- VERIFICADO em 11/09/2026, não só afirmado: este arquivo inteiro foi
-- rodado num Postgres 16 limpo em cima do 0001, e depois, com um papel
-- `anon` criado à mão e com `grant all` nas duas tabelas, conferiu-se
-- que ele lê zero linhas, que o `insert` dele é barrado por privilégio
-- insuficiente e que a chamada de `registrar_rejeicoes_webhook`
-- também é. A dobra por hora foi exercitada no mesmo teste: dois lotes
-- na mesma hora somam (3 + 5000 = 5003), a amostra para em 20 mesmo
-- recebendo 31, hora diferente vira linha própria, e `null` em
-- `p_amostras` não quebra.
