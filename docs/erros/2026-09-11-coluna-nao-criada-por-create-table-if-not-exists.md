# Coluna nova não entra por `create table if not exists`

**Sintoma.** Depois de rodar o `schema.sql` inteiro em produção, o painel
administrativo respondia "Erro interno — tente novamente em instantes."
já no login. O checkout continuava funcionando normalmente.

**Causa raiz.** A coluna `contratantes.metodos_habilitados` foi declarada
**dentro** do `create table if not exists contratantes (...)`, que é
no-op numa tabela que já existe. Diferente de `cobrancas`, `assinaturas`
e `subcontas`, a tabela `contratantes` não tinha nenhum
`alter table ... add column if not exists`: a migração existia apenas
como **comentário** no bloco de MIGRAÇÃO no fim do arquivo. Rodar o
schema não criava nada.

O painel quebrou porque `admin.listarContratantes` faz `select` explícito
da coluna. O checkout não quebrou porque lê com `?? null`, e nulo é
tratado como "libera tudo" — o fallback mascarou a ausência.

**Correção.** `alter table contratantes add column if not exists
metodos_habilitados text[] not null default array[...]` no corpo
executável do `supabase/schema.sql`, logo abaixo do `create table`, no
mesmo padrão das outras três tabelas.

**Guarda.** O `not null default` preenche as linhas existentes na mesma
operação.

**Como evitar na origem.** Toda coluna acrescentada **depois** da
primeira ida a produção precisa de `alter table ... add column if not
exists` no corpo executável, nunca em comentário. Sinal de alerta que
passou batido: um campo voltando `null` da API sem motivo claro — foi
explicado como "linha antiga" quando era "coluna inexistente".

**Ecossistema:** sim — o padrão "um arquivo de schema idempotente rodado de novo" é comum fora do Postgres também, e em todos eles `create table if not exists` é no-op numa tabela existente: coluna nova exige alteração explícita no corpo executável.
