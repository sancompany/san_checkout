# A migration 0009 estava aplicada no banco mas não registrada no histórico do Supabase

**Quando:** 22/09/2026, verificação de um achado suspeito da auditoria
externa (Codex) sobre possível divergência entre
`supabase/migrations/` e o histórico real de migrations do Supabase.
**Onde:** `supabase/migrations/0009_ambiente_e_teste.sql`.

## O que aconteceu

`mcp__Supabase__list_migrations` (o histórico oficial que o Supabase
mantém) listava `0001` até `0008`, depois pulava direto para `0010` —
faltando `0009` (`ambiente_e_teste`, a migration de RN-33: as colunas
`ambiente`/`e_teste` de `cobrancas`, descritas extensamente no
`CLAUDE.md`, em uso desde 17/09/2026).

As COLUNAS existiam de verdade em produção (conferido por
`information_schema.columns`) — a migration tinha sido aplicada. Só o
REGISTRO no histórico do Supabase é que faltava, o que sugere que ela
foi aplicada por um caminho que não passa pelo mecanismo de tracking
(SQL Editor do painel, ou uma chamada direta fora do fluxo de
`apply_migration`), em algum momento antes desta sessão.

Risco real: qualquer ferramenta que decida o que aplicar comparando
contra o histórico do Supabase (em vez de olhar o schema real) correria
o risco de tentar reaplicar `0009` um dia, ou de um `supabase db push`
futuro se confundir sobre o que já existe.

## A correção

`0009_ambiente_e_teste.sql` é **inteiramente idempotente** — todo
`ALTER TABLE` é `ADD COLUMN IF NOT EXISTS`, a constraint tem uma guarda
`IF NOT EXISTS` própria, a função é `CREATE OR REPLACE`, o índice é
`CREATE INDEX IF NOT EXISTS`. Reaplicá-la via `apply_migration` foi
seguro: nenhuma linha mudou (conferido depois — 17 linhas, todas
`sandbox`, a constraint continua existindo com o mesmo nome), e agora
`list_migrations` mostra o registro (`ambiente_e_teste`, com a data de
hoje — o histórico não tem como saber que a aplicação REAL foi em
17/09, só registra quando foi vista).

## Lição

O histórico de migrations do Supabase é um REGISTRO do que passou pelo
mecanismo de tracking dele, não uma prova do estado real do schema — os
dois podem divergir sem erro nenhum aparecer, porque um `ALTER TABLE`
rodado fora do fluxo funciona perfeitamente e só deixa de aparecer numa
lista que ninguém checa no dia a dia. O sinal de alerta não foi um erro:
foi um NÚMERO FALTANDO numa sequência — o mesmo tipo de sinal que já
apareceu antes neste projeto (documento dizendo "18 suítes" quando eram
35, `RUNBOOK` citando migrations `0001…0006` quando existiam nove).
Contar é barato; vale a pena fazer de vez em quando mesmo sem suspeita
nenhuma.
