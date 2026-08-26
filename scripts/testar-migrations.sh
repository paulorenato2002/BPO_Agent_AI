#!/usr/bin/env bash
# =============================================================================
# Testa as migrations da camada operacional num Postgres DESCARTÁVEL em Docker.
#
# NUNCA toca o banco de produção. Sobe um container próprio, aplica o baseline
# do schema existente + todas as migrations, roda as asserções e derruba tudo.
#
# Requisitos: Docker em execução.
# Uso:  bash scripts/testar-migrations.sh
# =============================================================================
set -uo pipefail

CONTAINER="pg-teste-effective"
DB="effective_teste"
IMAGEM="postgres:17-alpine"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

vermelho() { printf '\033[31m%s\033[0m\n' "$1"; }
verde()    { printf '\033[32m%s\033[0m\n' "$1"; }
titulo()   { printf '\n\033[1m%s\033[0m\n' "$1"; }

falhas=0

psql_arquivo() {
  docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q < "$1"
}

titulo "1. Subindo Postgres descartável"
if ! docker info >/dev/null 2>&1; then
  vermelho "Docker não está em execução. Inicie o Docker Desktop e tente de novo."
  exit 1
fi

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=teste -e POSTGRES_DB="$DB" \
  -p 55432:5432 "$IMAGEM" >/dev/null

# O entrypoint do postgres sobe um servidor TEMPORÁRIO para inicializar e o
# reinicia em seguida. `pg_isready` responde OK durante essa fase, e o schema
# aplicado ali é perdido no restart. Por isso exigimos estabilidade: três
# consultas reais bem-sucedidas, com intervalo.
estavel=0
for _ in $(seq 1 90); do
  if docker exec "$CONTAINER" psql -U postgres -d "$DB" -tAc 'select 1' >/dev/null 2>&1; then
    estavel=$((estavel + 1))
    [ "$estavel" -ge 3 ] && break
  else
    estavel=0
  fi
  sleep 1
done
if [ "$estavel" -lt 3 ]; then
  vermelho "  Postgres não estabilizou a tempo."
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  exit 1
fi
verde "  container pronto e estável ($IMAGEM)"

titulo "2. Baseline do schema existente (somente teste)"
if psql_arquivo "$RAIZ/supabase/baseline/0000_baseline_existente_TESTE.sql" >/dev/null 2>/tmp/erro; then
  verde "  OK   baseline aplicado"
else
  vermelho "  FALHA no baseline"; head -20 /tmp/erro; falhas=$((falhas+1))
fi

titulo "3. Aplicando migrations"
for f in "$RAIZ"/supabase/migrations/*.sql; do
  nome=$(basename "$f")
  if psql_arquivo "$f" >/dev/null 2>/tmp/erro; then
    verde "  OK   $nome"
  else
    vermelho "  FALHA $nome"; grep -iE '^ERROR' /tmp/erro | head -5; falhas=$((falhas+1))
  fi
done

titulo "4. Idempotência (reaplicando tudo)"
reaplicacao_ok=1
for f in "$RAIZ"/supabase/migrations/*.sql; do
  if ! psql_arquivo "$f" >/dev/null 2>/tmp/erro; then
    vermelho "  FALHA ao reaplicar $(basename "$f")"; grep -iE '^ERROR' /tmp/erro | head -5
    reaplicacao_ok=0; falhas=$((falhas+1))
  fi
done
[ "$reaplicacao_ok" = "1" ] && verde "  OK   todas as migrations são idempotentes"

titulo "5. Asserções"
# Roda UMA vez só: as asserções inserem massa de teste e não são idempotentes
# (o container é descartável, então isso não é problema).
saida_testes=$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 \
                 < "$RAIZ/supabase/testes/teste_migrations.sql" 2>&1)
status_testes=$?
echo "$saida_testes" | grep -E "OK  |FALHOU|TODOS OS TESTES" | sed 's/^NOTICE:  //'
if [ "$status_testes" -ne 0 ]; then
  vermelho "  asserções falharam"
  echo "$saida_testes" | grep -E "^ERROR" | head -5
  falhas=$((falhas+1))
fi

titulo "6. Limpeza"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
verde "  container removido"

echo
if [ "$falhas" -eq 0 ]; then
  verde "=== TUDO PASSOU ==="
  exit 0
else
  vermelho "=== $falhas ETAPA(S) COM FALHA ==="
  exit 1
fi
