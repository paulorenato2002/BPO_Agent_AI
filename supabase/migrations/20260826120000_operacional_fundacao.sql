-- =============================================================================
-- Camada operacional da Effective — Fundação
--
-- Cria: funções auxiliares (auditoria/RLS), perfis_usuarios, competencias_operacionais.
--
-- SEGURANÇA / PRESERVAÇÃO:
--   - Nenhuma tabela existente é alterada, renomeada ou removida.
--   - Todos os objetos criados aqui usam o prefixo `op_` (funções) ou nomes
--     novos que não colidem com o schema atual (26 tabelas de cadastro,
--     serviços, precificação e onboarding).
--   - Script idempotente: pode ser reaplicado sem erro.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Trigger de auditoria
--
-- ORDEM IMPORTA: funções `language sql` têm o corpo validado no momento da
-- criação (check_function_bodies), então as funções auxiliares de RLS — que
-- consultam perfis_usuarios — só podem ser criadas DEPOIS da tabela existir.
-- Por isso elas estão na seção 3, e não aqui.
-- -----------------------------------------------------------------------------

-- Mantém `updated_at` sempre coerente. Nome prefixado (`op_`) para não colidir
-- com triggers/funções já existentes no banco.
create or replace function public.op_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.op_set_updated_at() is
  'Trigger de auditoria: atualiza updated_at em cada UPDATE (camada operacional).';


-- -----------------------------------------------------------------------------
-- 2. perfis_usuarios
--    Usuários INTERNOS da Effective (não confundir com empresa_pessoas, que
--    representa pessoas ligadas às empresas clientes).
-- -----------------------------------------------------------------------------

create table if not exists public.perfis_usuarios (
  id             uuid primary key default gen_random_uuid(),
  usuario_id     uuid not null unique references auth.users(id) on delete cascade,
  nome           text not null,
  email          text,
  papel          varchar(30) not null default 'analista',
  departamento   varchar(60),
  ativo          boolean not null default true,
  observacoes    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid,
  updated_by     uuid,
  constraint perfis_usuarios_papel_check
    check (papel in ('administrador', 'socio', 'supervisor', 'analista', 'estagiaria'))
);

comment on table public.perfis_usuarios is
  'Usuários internos da Effective, vinculados a auth.users. Distinto de empresa_pessoas (pessoas das empresas clientes).';
comment on column public.perfis_usuarios.usuario_id is 'FK para auth.users.id — identidade de autenticação.';
comment on column public.perfis_usuarios.papel is 'administrador | socio | supervisor | analista | estagiaria.';

create index if not exists perfis_usuarios_ativo_idx  on public.perfis_usuarios (ativo) where ativo;
create index if not exists perfis_usuarios_papel_idx  on public.perfis_usuarios (papel);

drop trigger if exists perfis_usuarios_set_updated_at on public.perfis_usuarios;
create trigger perfis_usuarios_set_updated_at
  before update on public.perfis_usuarios
  for each row execute function public.op_set_updated_at();


-- -----------------------------------------------------------------------------
-- 3. Funções auxiliares de RLS
--    Criadas AQUI (e não no topo) porque consultam perfis_usuarios.
-- -----------------------------------------------------------------------------

-- Retorna true se o usuário autenticado é um usuário INTERNO ATIVO da Effective.
-- security definer: precisa ler perfis_usuarios independentemente da RLS dela,
-- senão a política que usa esta função entraria em recursão infinita.
create or replace function public.op_usuario_interno_ativo()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1
    from public.perfis_usuarios p
    where p.usuario_id = auth.uid()
      and p.ativo
  );
$$;

comment on function public.op_usuario_interno_ativo() is
  'RLS: true quando auth.uid() corresponde a um perfil interno ativo.';

-- Papel do usuário autenticado (null se não for usuário interno ativo).
create or replace function public.op_papel_usuario()
returns text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select p.papel
  from public.perfis_usuarios p
  where p.usuario_id = auth.uid()
    and p.ativo
  limit 1;
$$;

comment on function public.op_papel_usuario() is
  'RLS: papel do usuário interno autenticado (administrador|socio|supervisor|analista|estagiaria).';

-- Conveniência para políticas que exigem papéis elevados.
create or replace function public.op_usuario_tem_papel(variadic papeis text[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select public.op_papel_usuario() = any(papeis);
$$;

comment on function public.op_usuario_tem_papel(text[]) is
  'RLS: true se o papel do usuário autenticado está na lista informada.';


-- -----------------------------------------------------------------------------
-- 4. competencias_operacionais
--    Competência (mês/ano) de uma empresa. Ex.: "TL Academia — agosto/2026".
-- -----------------------------------------------------------------------------

create table if not exists public.competencias_operacionais (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        uuid not null references public.empresas(id) on delete restrict,
  ano               smallint not null,
  mes               smallint not null,
  -- Coluna derivada: facilita ordenação/filtro por período sem montar data na query.
  referencia        date generated always as (make_date(ano::int, mes::int, 1)) stored,
  status            varchar(30) not null default 'aberta',
  data_abertura     date,
  data_fechamento   date,
  fechada_por       uuid references public.perfis_usuarios(usuario_id) on delete set null,
  observacoes       text,
  ativo             boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid,
  updated_by        uuid,
  constraint competencias_operacionais_ano_check    check (ano between 2000 and 2100),
  constraint competencias_operacionais_mes_check    check (mes between 1 and 12),
  constraint competencias_operacionais_status_check
    check (status in ('aberta', 'em_andamento', 'em_revisao', 'fechada', 'reaberta', 'cancelada')),
  -- Evita duplicidade da mesma empresa/ano/mês.
  constraint competencias_operacionais_empresa_periodo_uk unique (empresa_id, ano, mes)
);

comment on table public.competencias_operacionais is
  'Competência mensal de uma empresa (ex.: TL Academia — agosto/2026). Base para tarefas e documentos.';
comment on column public.competencias_operacionais.referencia is
  'Coluna gerada (ano/mes/01) para ordenação e filtros por período.';

create index if not exists competencias_op_empresa_idx     on public.competencias_operacionais (empresa_id);
create index if not exists competencias_op_referencia_idx  on public.competencias_operacionais (referencia desc);
create index if not exists competencias_op_status_idx      on public.competencias_operacionais (status);

drop trigger if exists competencias_operacionais_set_updated_at on public.competencias_operacionais;
create trigger competencias_operacionais_set_updated_at
  before update on public.competencias_operacionais
  for each row execute function public.op_set_updated_at();
