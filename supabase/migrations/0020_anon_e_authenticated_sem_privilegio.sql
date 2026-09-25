-- =====================================================================
-- 0020 — ANON E AUTHENTICATED SEM PRIVILÉGIO NENHUM (25/09/2026)
--
-- INFO-13 da remediação da Estação 6
-- (`docs/SECURITY_STATION_6_REMEDIATION_2026-09-25.md`).
--
-- Este backend fala com o Postgres SÓ como `service_role` (a chave do
-- `SUPABASE_SERVICE_KEY`). Os papéis `anon` e `authenticated` — os da
-- chave pública do Supabase — não são usados por nada deste projeto, e
-- mesmo assim tinham, pelos privilégios padrão do Supabase, tudo em todas
-- as tabelas: medido em produção antes desta migration, 84 privilégios
-- cada um nas 12 tabelas de `public` (SELECT, INSERT, UPDATE, DELETE,
-- TRUNCATE, REFERENCES, TRIGGER), mais EXECUTE nas quatro funções.
--
-- O que segurava era só o RLS: ligado nas 12, sem política nenhuma —
-- negação total. Continua sendo a primeira barreira. Esta é a segunda:
-- se um dia alguém escrever uma política permissiva ou desligar o RLS de
-- uma tabela por engano, a chave pública continua sem alcançar nada. E o
-- TRUNCATE é um privilégio que o RLS nem olha.
--
-- O `service_role` NÃO é tocado: ele tem os próprios privilégios,
-- explícitos, em cada tabela e em cada função (conferido nas ACLs antes:
-- `service_role=arwdDxtm/postgres` e `service_role=X/postgres`) — não os
-- herda do `anon` nem do `PUBLIC`.
--
-- Função nova daqui em diante: o PostgreSQL dá EXECUTE ao `PUBLIC` em
-- toda função criada, por padrão GLOBAL, e esse padrão não se revoga por
-- esquema. Quem criar função em `public` escreve, na mesma migration,
-- `revoke execute on function … from public, anon, authenticated;` — e
-- `tests/banco-sem-privilegio-publico.js` confere.
--
-- Seguro de aplicar e de repetir: `revoke` de privilégio que não existe
-- não é erro. Nenhuma linha é tocada.
-- =====================================================================

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

-- Tabela e sequência criadas pelo `postgres` daqui em diante já nascem
-- sem os dois (os padrões do Supabase para eles são POR ESQUEMA, e por
-- esquema se revogam).
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
