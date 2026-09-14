-- ---------------------------------------------------------------------
-- 0004 — fixa o search_path das duas funções da 0002.
--
-- O linter de segurança do Supabase (0011_function_search_path_mutable)
-- acusa função sem search_path fixo: quem chama pode trocar o search_path
-- da sessão e fazer a função resolver um nome (tabela, operador) para um
-- objeto plantado noutro schema. Nas duas funções aqui o risco é remoto
-- (são `security invoker`, rodam com os direitos de quem chama, e o
-- backend usa a service_key), mas fixar o caminho fecha o aviso e é a
-- higiene que a Lei 3/`seguranca-san` pede.
--
-- `public`, não `''`: os corpos referenciam `webhook_rejeicoes` sem
-- qualificar, então um search_path vazio quebraria a resolução. Com
-- `public`, o `pg_catalog` continua implícito e primeiro (jsonb_agg,
-- sum, min, coalesce resolvem), e `webhook_rejeicoes` resolve em public.
--
-- ALTER FUNCTION (não CREATE OR REPLACE): muda só o atributo, não o
-- corpo — migration mínima e reversível.
-- ---------------------------------------------------------------------

alter function public.registrar_rejeicoes_webhook(timestamptz, integer, jsonb)
  set search_path = public;

alter function public.resumo_rejeicoes_webhook()
  set search_path = public;
