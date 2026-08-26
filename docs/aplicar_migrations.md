# Aplicar as migrations no Supabase

Guia para aplicar a camada operacional pelo **SQL Editor** do painel do Supabase.

Projeto: `eoypcltwbvhcwgxoadjn`

---

## Antes de começar

As migrations foram validadas num Postgres 17 descartável, contra um baseline
**reconstruído** do schema atual (colunas, tipos, PK, FK). Esse baseline **não**
reproduz os 39 triggers, 150 índices e políticas de RLS reais do projeto.

Na prática: o SQL está correto e é idempotente, mas rode o diagnóstico do
passo 1 antes — ele detecta colisão de nome com algo que já exista.

Nada aqui apaga dados. Todos os comandos são `create ... if not exists`,
`create or replace` ou `alter table ... enable row level security`.

---

## Passo 1 — Diagnóstico (não altera nada)

Cole no SQL Editor e confira o resultado:

```sql
-- Alguma das novas tabelas já existe? Esperado: 0 linhas.
select tablename
from pg_tables
where schemaname = 'public'
  and tablename in (
    'perfis_usuarios','competencias_operacionais','modelos_rotina',
    'etapas_modelo_rotina','rotinas_empresa','tarefas_operacionais',
    'apontamentos_tempo','documentos_operacionais','documento_localizacoes',
    'execucoes_ferramenta','aprovacoes_operacionais','notificacoes_operacionais',
    'eventos_operacionais','conversas_agente','mensagens_agente'
  );

-- Alguma função com o prefixo op_ já existe? Esperado: 0 linhas.
select proname
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname like 'op\_%';

-- Alguma view vw_ já existe? Esperado: 0 linhas.
select viewname from pg_views
where schemaname = 'public' and viewname like 'vw\_%';
```

**Se as três vierem vazias, siga.** Se alguma retornar linha, me avise antes de
aplicar — significa que existe um objeto com o mesmo nome que eu não enxerguei.

---

## Passo 2 — Aplicar, na ordem

Abra cada arquivo de `supabase/migrations/`, copie o conteúdo inteiro e execute
no SQL Editor. **A ordem importa** (há dependências entre eles):

| # | Arquivo | O que cria |
|---|---|---|
| 1 | `20260826120000_operacional_fundacao.sql` | `op_set_updated_at`, `perfis_usuarios`, funções de RLS, `competencias_operacionais` |
| 2 | `20260826120100_operacional_rotinas.sql` | `modelos_rotina`, `etapas_modelo_rotina`, `rotinas_empresa` |
| 3 | `20260826120200_operacional_execucao.sql` | `tarefas_operacionais`, `apontamentos_tempo` |
| 4 | `20260826120300_operacional_documentos.sql` | `documentos_operacionais`, `documento_localizacoes` |
| 5 | `20260826120400_operacional_ferramentas.sql` | `execucoes_ferramenta`, `aprovacoes_operacionais`, `notificacoes_operacionais` |
| 6 | `20260826120500_operacional_eventos.sql` | `eventos_operacionais` (append-only) |
| 7 | `20260826120600_agente_conversas.sql` | `conversas_agente`, `mensagens_agente` |
| 8 | `20260826120700_operacional_views.sql` | as 9 views do Hub |
| 9 | `20260826120800_operacional_rls.sql` | RLS e privilégios das novas tabelas |

Execute um por vez e confirme "Success" antes do próximo.

> **Se algum falhar:** pare. Nada foi perdido — cada arquivo roda numa transação
> própria. Me mande a mensagem de erro.

---

## Passo 3 — Verificar

```sql
-- 15 tabelas novas
select count(*) as tabelas_novas
from pg_tables
where schemaname = 'public'
  and tablename in (
    'perfis_usuarios','competencias_operacionais','modelos_rotina',
    'etapas_modelo_rotina','rotinas_empresa','tarefas_operacionais',
    'apontamentos_tempo','documentos_operacionais','documento_localizacoes',
    'execucoes_ferramenta','aprovacoes_operacionais','notificacoes_operacionais',
    'eventos_operacionais','conversas_agente','mensagens_agente'
  );
-- esperado: 15

-- 9 views
select count(*) as views from pg_views
where schemaname = 'public' and viewname like 'vw\_%';
-- esperado: 9

-- RLS habilitada em todas. Esperado: 0 linhas.
select relname from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r'
  and relname in (
    'perfis_usuarios','competencias_operacionais','documentos_operacionais',
    'documento_localizacoes','eventos_operacionais','conversas_agente',
    'mensagens_agente','execucoes_ferramenta','tarefas_operacionais',
    'apontamentos_tempo','modelos_rotina','etapas_modelo_rotina',
    'rotinas_empresa','aprovacoes_operacionais','notificacoes_operacionais'
  )
  and not relrowsecurity;

-- anon não deve ter privilégio nas novas tabelas. Esperado: 0 linhas.
select table_name, privilege_type
from information_schema.role_table_grants
where grantee = 'anon' and table_schema = 'public'
  and table_name in (
    'perfis_usuarios','documentos_operacionais','conversas_agente',
    'mensagens_agente','eventos_operacionais'
  );

-- As 26 tabelas originais continuam lá. Esperado: 26.
select count(*) as originais
from pg_tables
where schemaname = 'public'
  and tablename in (
    'empresas','enderecos_empresa','pessoas','empresa_pessoas','canais_comunicacao',
    'grupos_comunicacao','grupo_participantes','servicos','planos_referencia',
    'plano_servicos','contratos','contrato_servicos','modelos_precificacao',
    'modelo_recursos_equipe','regras_precificacao_servicos','precificacoes',
    'precificacao_itens','precificacao_componentes','modelos_onboarding',
    'fases_onboarding','tarefas_modelo_onboarding','onboardings','tarefas_onboarding',
    'evidencias_tarefa_onboarding','alertas_onboarding','historico_onboarding'
  );
```

Teste rápido de que o histórico é mesmo imutável:

```sql
insert into public.eventos_operacionais (tipo_evento, descricao)
values ('teste_manual', 'validando append-only');

-- Deve FALHAR com "eventos_operacionais é append-only":
update public.eventos_operacionais set descricao = 'x' where tipo_evento = 'teste_manual';
```

---

## Passo 4 — Criar os usuários internos

O RLS depende de `perfis_usuarios`. Sem isso, usuário autenticado não enxerga nada.

1. **Authentication › Users › Add user** — crie cada usuário da equipe.
2. Copie o UUID de cada um e vincule:

```sql
insert into public.perfis_usuarios (usuario_id, nome, email, papel, departamento)
values
  ('<uuid-do-auth-users>', 'Paulo Renato', 'paulo.d.luvre@gmail.com', 'administrador', 'Diretoria');
-- papel: administrador | socio | supervisor | analista | estagiaria
```

Confira:

```sql
select p.nome, p.papel, p.ativo, u.email
from public.perfis_usuarios p
join auth.users u on u.id = p.usuario_id;
```

---

## Passo 5 (opcional, exige decisão) — Revisão de privilégios do legado

`supabase/revisar-antes-de-aplicar/20260826121000_seguranca_revogacoes_legado.sql`
revoga o acesso de `anon` às **26 tabelas existentes**.

Está fora do fluxo automático de propósito: **se alguma aplicação, script ou
automação usa a chave `anon` hoje, ela para de funcionar na hora.**

O arquivo traz o diagnóstico para rodar antes, e o bloco de reversão. Não
aplique sem responder: existe algum consumidor usando `anon` hoje?

---

## Depois de aplicar

Me avise. Aí eu:

- rodo a verificação do lado da aplicação;
- ligo o histórico de conversas (hoje ele degrada com aviso, porque as tabelas
  não existem);
- sigo com as ferramentas internas do agente.
