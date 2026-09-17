#!/usr/bin/env bash
# SAN CHECKOUT — scripts/ensaio-restauracao.sh
#
# O ensaio de restauração que a Lei 6 exige: "backup nunca restaurado é
# backup hipotético". Sobe um Postgres descartável da MESMA major da
# produção, aplica as migrations, carrega o despejo de dados, e confere.
#
# Mede os dois números que o CONSTRAINTS.md tem de declarar:
#   RTO real = quanto tempo levou daqui até o banco de pé com os dados
#   RPO real = idade do dado mais recente que sobreviveu
#
# Os dados vêm ANONIMIZADOS (padrão de `backup-dados.mjs`): o CPF real não
# é necessário para provar que o restore funciona, e não se puxa base de
# produção para máquina de desenvolvimento.
#
# Uso:  scripts/ensaio-restauracao.sh [arquivo-de-dados.sql]
#       sem argumento, gera um despejo novo da produção.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
TRAB="${TMPDIR:-/tmp}/ensaio-$(date -u +%Y%m%dT%H%M%SZ)"
PORTA=55432
export PGHOST=127.0.0.1 PGPORT=$PORTA PGUSER=ensaio PGDATABASE=postgres

limpar() {
  [ -d "$TRAB/pg" ] && su postgres -s /bin/bash -c "'$PGBIN/pg_ctl' -D '$TRAB/pg' -m immediate stop" >/dev/null 2>&1 || true
}
trap limpar EXIT

echo "== ensaio de restauração =="
echo "postgres: $("$PGBIN/postgres" --version)"

DADOS="${1:-}"
if [ -z "$DADOS" ]; then
  DADOS="$TRAB/dados.sql"
  mkdir -p "$TRAB"
  echo "-- gerando despejo da produção..."
  node "$RAIZ/scripts/backup-dados.mjs" "$DADOS" >/dev/null
fi
echo "dados: $DADOS ($(grep -c '^INSERT' "$DADOS") linhas)"

# --- o cronômetro do RTO começa aqui: é o que um restore custa de verdade
INICIO=$(date +%s)

# O Postgres recusa rodar como root, por desenho dele. O cluster do ensaio
# é do usuário `postgres`; o psql segue de onde estamos, por TCP.
mkdir -p "$TRAB/pg" "$TRAB/sock"
chown -R postgres:postgres "$TRAB"
COMO_PG=(su postgres -s /bin/bash -c)
"${COMO_PG[@]}" "'$PGBIN/initdb' -D '$TRAB/pg' -U ensaio --auth=trust --encoding=UTF8 >/dev/null"
"${COMO_PG[@]}" "'$PGBIN/pg_ctl' -D '$TRAB/pg' -o '-p $PORTA -c listen_addresses=127.0.0.1 -c unix_socket_directories=$TRAB/sock' -l '$TRAB/pg.log' -w start >/dev/null"

# ON_ERROR_STOP em tudo: o padrão do psql é seguir em erro, em silêncio —
# que é exatamente como um restore "bem-sucedido" chega quebrado.
for m in "$RAIZ"/supabase/migrations/*.sql; do
  echo "-- $(basename "$m")"
  psql -v ON_ERROR_STOP=1 -q -f "$m"
done

psql -v ON_ERROR_STOP=1 -q -f "$DADOS"

FIM=$(date +%s)
RTO=$(( FIM - INICIO ))
echo "RTO medido: ${RTO}s"

echo "== conferência contra a produção =="
RTO_SEGUNDOS=$RTO node "$RAIZ/scripts/conferir-restauracao.mjs"
