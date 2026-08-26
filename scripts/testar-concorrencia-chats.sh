#!/usr/bin/env bash
# =============================================================================
# Testa o limite de 10 chats sob CONCORRÊNCIA REAL.
#
# O teste de asserção normal roda numa sessão só, então não prova nada sobre
# corrida: duas transações simultâneas poderiam ler "9 ativas" ao mesmo tempo e
# ambas inserirem o 11º. Aqui abrimos conexões paralelas de verdade.
#
# Cenário: usuário com 9 conversas ativas; N conexões tentam criar a 10ª e a
# 11ª ao mesmo tempo. Exatamente 1 pode virar a 10ª; as demais devem falhar.
#
# Uso: bash scripts/testar-concorrencia-chats.sh
# =============================================================================
set -uo pipefail

CONTAINER="pg-concorrencia-effective"
DB="teste_concorrencia"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USUARIO="11111111-1111-1111-1111-111111111111"
PARALELAS=8

vermelho() { printf '\033[31m%s\033[0m\n' "$1"; }
verde()    { printf '\033[32m%s\033[0m\n' "$1"; }
titulo()   { printf '\n\033[1m%s\033[0m\n' "$1"; }

psql_c() { docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -tAq "$@"; }

titulo "1. Preparando banco descartável"
docker info >/dev/null 2>&1 || { vermelho "Docker não está em execução."; exit 1; }
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=teste -e POSTGRES_DB="$DB" \
  postgres:17-alpine >/dev/null
# Mesma precaução do outro script: o postgres reinicia depois da inicialização,
# e aplicar schema durante a fase temporária o perde silenciosamente.
estavel=0
for _ in $(seq 1 90); do
  if docker exec "$CONTAINER" psql -U postgres -d "$DB" -tAc "select 1" >/dev/null 2>&1; then
    estavel=$((estavel + 1)); [ "$estavel" -ge 3 ] && break
  else estavel=0; fi
  sleep 1
done
[ "$estavel" -ge 3 ] || { vermelho "Postgres não estabilizou."; docker rm -f "$CONTAINER" >/dev/null 2>&1; exit 1; }

psql_c < "$RAIZ/supabase/baseline/0000_baseline_existente_TESTE.sql" >/dev/null 2>&1
for f in "$RAIZ"/supabase/migrations/*.sql; do
  psql_c < "$f" >/dev/null 2>&1 || { vermelho "falha aplicando $(basename "$f")"; exit 1; }
done
verde "  schema pronto"

titulo "2. Usuário com 9 conversas ativas"
psql_c <<SQL >/dev/null
insert into auth.users (id, email) values ('$USUARIO','concorrencia@teste.local')
  on conflict do nothing;
insert into public.perfis_usuarios (usuario_id, nome, papel)
  values ('$USUARIO','Teste Concorrencia','analista') on conflict (usuario_id) do nothing;
delete from public.conversas_agente where usuario_id = '$USUARIO';
insert into public.conversas_agente (usuario_id, titulo)
  select '$USUARIO', 'Conversa ' || g from generate_series(1,9) g;
SQL
verde "  ativas agora: $(psql_c -c "select count(*) from public.conversas_agente where usuario_id='$USUARIO' and status='ativa'")"

titulo "3. $PARALELAS conexões tentando criar conversa AO MESMO TEMPO"
# Cada processo abre sua própria conexão e transação. Só 1 pode vencer.
for i in $(seq 1 $PARALELAS); do
  (
    docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -tAq <<SQL >/dev/null 2>&1
begin;
insert into public.conversas_agente (usuario_id, titulo) values ('$USUARIO','Corrida $i');
commit;
SQL
    echo "$?" > "/tmp/concorrencia_$i.status"
  ) &
done
wait

sucessos=0
for i in $(seq 1 $PARALELAS); do
  [ "$(cat "/tmp/concorrencia_$i.status" 2>/dev/null)" = "0" ] && sucessos=$((sucessos+1))
  rm -f "/tmp/concorrencia_$i.status"
done

finais=$(psql_c -c "select count(*) from public.conversas_agente where usuario_id='$USUARIO' and status='ativa'")

echo "  tentativas            : $PARALELAS"
echo "  commits bem-sucedidos : $sucessos"
echo "  conversas ativas ao fim: $finais"

titulo "4. Resultado"
falhas=0
if [ "$sucessos" -eq 1 ]; then
  verde "  OK   exatamente 1 conexão conseguiu criar"
else
  vermelho "  FALHA esperado 1 sucesso, houve $sucessos"; falhas=$((falhas+1))
fi

if [ "$finais" -eq 10 ]; then
  verde "  OK   limite respeitado sob concorrência (10 ativas)"
else
  vermelho "  FALHA limite furado: $finais conversas ativas"; falhas=$((falhas+1))
fi

titulo "5. Limpeza"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
verde "  container removido"

echo
if [ "$falhas" -eq 0 ]; then verde "=== CONCORRÊNCIA: PASSOU ==="; exit 0
else vermelho "=== CONCORRÊNCIA: $falhas FALHA(S) ==="; exit 1; fi
