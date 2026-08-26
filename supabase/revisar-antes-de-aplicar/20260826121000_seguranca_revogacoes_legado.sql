-- =============================================================================
-- ⚠️  NÃO É APLICADO AUTOMATICAMENTE — EXIGE REVISÃO E APROVAÇÃO EXPLÍCITA
--
-- Esta migration está FORA de `supabase/migrations/` de propósito: ela altera
-- privilégios das 26 tabelas JÁ EXISTENTES. Se alguma outra aplicação, script,
-- automação ou integração hoje acessa o banco com a chave `anon`, ela PARA de
-- funcionar no instante em que este script rodar.
--
-- ANTES DE APLICAR, responda:
--   1. Existe alguma aplicação usando a chave anon contra estas tabelas?
--   2. Existe algum front-end público lendo dados diretamente?
--   3. Existe automação (n8n, script, integração) usando anon?
--
-- Se a resposta for "não" para as três, este script é seguro.
-- Se for "sim" para alguma, migre aquele consumo para o backend antes.
--
-- COMO APLICAR (depois de aprovado):
--   mova o arquivo para `supabase/migrations/` e rode a migration,
--   ou execute o conteúdo no SQL Editor do Supabase.
--
-- REVERSÃO: ver bloco comentado no final do arquivo.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Diagnóstico — rode PRIMEIRO, isoladamente, e leia o resultado.
--    Estas consultas não alteram nada.
-- -----------------------------------------------------------------------------

-- 1a. Quais privilégios `anon` tem hoje nas tabelas do schema public?
--
-- select table_name, string_agg(distinct privilege_type, ', ' order by privilege_type) as privilegios
-- from information_schema.role_table_grants
-- where grantee = 'anon' and table_schema = 'public'
-- group by table_name
-- order by table_name;

-- 1b. Quais tabelas têm RLS habilitada?
--
-- select relname as tabela, relrowsecurity as rls_habilitada, relforcerowsecurity as rls_forcada
-- from pg_class
-- where relnamespace = 'public'::regnamespace and relkind = 'r'
-- order by relname;

-- 1c. Quais políticas existem hoje?
--
-- select schemaname, tablename, policyname, roles, cmd, qual, with_check
-- from pg_policies
-- where schemaname = 'public'
-- order by tablename, policyname;

-- 1d. Existem views SECURITY DEFINER (ignoram a RLS de quem consulta)?
--
-- select c.relname as view_name,
--        coalesce(
--          (select option_value from pg_options_to_table(c.reloptions)
--            where option_name = 'security_invoker'), 'não definido'
--        ) as security_invoker
-- from pg_class c
-- where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
-- order by c.relname;


-- -----------------------------------------------------------------------------
-- 2. Revogações — o efeito real deste script
-- -----------------------------------------------------------------------------

do $$
declare
  t record;
begin
  for t in
    select tablename
    from pg_tables
    where schemaname = 'public'
  loop
    -- 2a. `anon` (usuário não autenticado) não deve ter acesso a dado operacional.
    execute format('revoke all on public.%I from anon;', t.tablename);

    -- 2b. TRUNCATE e TRIGGER nunca devem ser concedidos a usuários comuns:
    --     TRUNCATE apaga a tabela inteira ignorando políticas de linha;
    --     TRIGGER permite instalar código que roda com privilégio do dono.
    execute format('revoke truncate, trigger, references on public.%I from authenticated;', t.tablename);
  end loop;
end;
$$;

-- 2c. `anon` não precisa nem enxergar o schema.
revoke usage on schema public from anon;

-- 2d. Impede que NOVAS tabelas voltem a ser concedidas a anon automaticamente.
--     (O Supabase configura default privileges amplos por padrão.)
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;


-- -----------------------------------------------------------------------------
-- 3. Verificação — rode DEPOIS. Deve retornar zero linhas.
-- -----------------------------------------------------------------------------
--
-- select table_name, privilege_type
-- from information_schema.role_table_grants
-- where grantee = 'anon' and table_schema = 'public';


-- =============================================================================
-- REVERSÃO (se algo quebrar)
-- =============================================================================
--
-- Restaura o comportamento padrão do Supabase. Use apenas se precisar voltar:
--
-- grant usage on schema public to anon;
-- grant select on all tables in schema public to anon;
-- alter default privileges in schema public grant select on tables to anon;
--
-- ATENÇÃO: restaurar isso reabre leitura anônima. Prefira migrar o consumidor
-- afetado para o backend em vez de reverter.
-- =============================================================================
