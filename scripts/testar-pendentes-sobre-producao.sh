#!/usr/bin/env bash
# =============================================================================
# Ensaia o arquivo de pendentes sobre uma RÉPLICA do estado atual da produção.
#
# O `npm run test:migrations` aplica tudo desde o baseline. Isso prova que as
# migrations funcionam em conjunto, mas NÃO é a operação que a pessoa vai fazer
# no SQL Editor: lá o banco já tem parte delas aplicada.
#
# Aqui reproduzimos a situação real — banco com as migrations até 20260830, e
# só então o arquivo colado — porque é onde um erro de ordem ou uma constraint
# que já existe apareceriam.
#
# NUNCA toca produção. Container descartável.
# =============================================================================
set -uo pipefail

CONTAINER="pg-ensaio-pendentes"
DB="ensaio"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# O que o diagnóstico de 2026-09-09 mostrou já aplicado no banco real.
JA_APLICADAS=(
  20260826120000 20260826120100 20260826120200 20260826120300 20260826120400
  20260826120500 20260826120600 20260826120700 20260826120800
  20260827100000 20260827100100 20260827100200 20260827110000
  20260828100000 20260829100000 20260830100000
)

verde()    { printf '\033[32m%s\033[0m\n' "$1"; }
vermelho() { printf '\033[31m%s\033[0m\n' "$1"; }
titulo()   { printf '\n\033[1m%s\033[0m\n' "$1"; }

rodar() { docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q < "$1"; }

if ! docker info >/dev/null 2>&1; then
  vermelho "Docker não está em execução."
  exit 1
fi

titulo "1. Réplica do estado atual da produção"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=teste -e POSTGRES_DB="$DB" \
  postgres:17-alpine >/dev/null

estavel=0
for _ in $(seq 1 90); do
  if docker exec "$CONTAINER" psql -U postgres -d "$DB" -tAc 'select 1' >/dev/null 2>&1; then
    estavel=$((estavel + 1)); [ "$estavel" -ge 3 ] && break
  else estavel=0; fi
  sleep 1
done
[ "$estavel" -lt 3 ] && { vermelho "  Postgres não estabilizou."; docker rm -f "$CONTAINER" >/dev/null; exit 1; }

rodar "$RAIZ/supabase/baseline/0000_baseline_existente_TESTE.sql" >/dev/null 2>&1
for prefixo in "${JA_APLICADAS[@]}"; do
  arquivo=$(ls "$RAIZ"/supabase/migrations/${prefixo}_*.sql 2>/dev/null | head -1)
  [ -z "$arquivo" ] && continue
  rodar "$arquivo" >/dev/null 2>/tmp/erro_base || {
    vermelho "  FALHA ao montar a réplica em $(basename "$arquivo")"
    grep -iE '^ERROR' /tmp/erro_base | head -3; docker rm -f "$CONTAINER" >/dev/null; exit 1
  }
done
verde "  réplica pronta (migrations até 20260830, como a produção hoje)"

falhas=0

titulo "2. Colando o arquivo de pendentes"
if rodar "$RAIZ/supabase/aplicar/2026-09-09_pendentes.sql" >/dev/null 2>/tmp/erro; then
  verde "  OK   aplicou sem erro"
else
  vermelho "  FALHOU"; grep -iE '^ERROR' /tmp/erro | head -10; falhas=$((falhas+1))
fi

titulo "3. Colando de novo (alguém sempre cola duas vezes)"
if rodar "$RAIZ/supabase/aplicar/2026-09-09_pendentes.sql" >/dev/null 2>/tmp/erro2; then
  verde "  OK   idempotente"
else
  vermelho "  FALHOU na segunda aplicação"; grep -iE '^ERROR' /tmp/erro2 | head -10; falhas=$((falhas+1))
fi

titulo "4. O que passou a existir"
docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA <<'SQL' | sed 's/^/  /'
select 'tabela  ' || table_name from information_schema.tables
 where table_schema='public' and table_name in
   ('fila_arquivamento','empresa_pastas','pastas_sem_empresa')
union all
select 'função  ' || routine_name from information_schema.routines
 where routine_schema='public' and routine_name in
   ('enfileirar_arquivamento','assumir_arquivamento','concluir_arquivamento',
    'falhar_arquivamento','sincronizar_pastas_empresas')
union all
select 'regra   CLIENTE_DOCUMENTO ativa' from public.regras_arquivamento
 where codigo='CLIENTE_DOCUMENTO' and ativo
order by 1;
SQL

titulo "5. Asserções sobre a réplica"
for teste in teste_fila teste_mapa_pastas; do
  saida=$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 \
            < "$RAIZ/supabase/testes/$teste.sql" 2>&1)
  if [ $? -eq 0 ]; then
    verde "  OK   $teste"
  else
    vermelho "  FALHOU $teste"; echo "$saida" | grep -E '^ERROR' | head -5; falhas=$((falhas+1))
  fi
done

titulo "6. Limpeza"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
verde "  container removido"

echo
if [ "$falhas" -eq 0 ]; then
  verde "=== O ARQUIVO DE PENDENTES É SEGURO PARA COLAR ==="
  exit 0
else
  vermelho "=== $falhas PROBLEMA(S) — não cole ainda ==="
  exit 1
fi
