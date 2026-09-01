-- =============================================================================
-- Estrutura FIXA do Drive
--
-- `regras_arquivamento` responde "onde vai um documento desta classe".
-- Esta tabela responde uma pergunta diferente: "quais pastas precisam existir
-- ANTES de qualquer documento chegar".
--
-- São coisas separadas de propósito. 01_CLIENTES_ATIVOS e 02_CLIENTES_INATIVOS
-- precisam existir, mas nenhum documento é arquivado direto dentro delas — são
-- contêineres das pastas de empresa. Cadastrá-las como regra de arquivamento
-- faria com que aparecessem como destino selecionável na classificação, o que
-- está errado.
--
-- Nenhuma pasta de empresa, ano, competência ou projeto entra aqui: essas
-- nascem sob demanda, no arquivamento.
-- =============================================================================

create or replace function public.op_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;


-- -----------------------------------------------------------------------------
-- 1. Tabela
-- -----------------------------------------------------------------------------

create table if not exists public.estrutura_fixa_drive (
  id              uuid primary key default gen_random_uuid(),
  -- Identidade estável usada pelo código. O NOME da pasta pode mudar; a chave
  -- não. É por 'clientes_ativos' que o resolvedor encontra o contêiner.
  chave           varchar(60) not null unique,
  -- Segmentos literais do caminho, a partir da raiz do Drive.
  caminho_modelo  jsonb not null,
  descricao       text,
  ordem           integer not null default 0,
  ativo           boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid,
  updated_by      uuid,
  constraint estrutura_fixa_drive_modelo_array_check
    check (jsonb_typeof(caminho_modelo) = 'array' and jsonb_array_length(caminho_modelo) > 0),
  -- Estrutura FIXA não pode depender de valor de runtime. Se um {ANO} entrasse
  -- aqui, o script de bootstrap criaria uma pasta chamada literalmente "{ANO}".
  constraint estrutura_fixa_drive_sem_placeholder_check
    check (caminho_modelo::text not like '%{%')
);

comment on table public.estrutura_fixa_drive is
  'Pastas que precisam existir antes de qualquer documento. Não são destinos de arquivamento.';
comment on column public.estrutura_fixa_drive.chave is
  'Identidade estável usada pelo código (ex.: clientes_ativos). O nome da pasta pode mudar; a chave não.';

create index if not exists estrutura_fixa_drive_ordem_idx
  on public.estrutura_fixa_drive (ordem) where ativo;

drop trigger if exists estrutura_fixa_drive_set_updated_at on public.estrutura_fixa_drive;
create trigger estrutura_fixa_drive_set_updated_at
  before update on public.estrutura_fixa_drive
  for each row execute function public.op_set_updated_at();


-- -----------------------------------------------------------------------------
-- 2. RLS — mesmo padrão de regras_arquivamento
-- -----------------------------------------------------------------------------

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

revoke all on function public.op_usuario_interno_ativo() from public, anon;
grant execute on function public.op_usuario_interno_ativo() to authenticated, service_role;

alter table public.estrutura_fixa_drive enable row level security;

revoke all on public.estrutura_fixa_drive from anon;
revoke all on public.estrutura_fixa_drive from authenticated;
grant select on public.estrutura_fixa_drive to authenticated;

drop policy if exists estrutura_fixa_drive_select on public.estrutura_fixa_drive;
create policy estrutura_fixa_drive_select on public.estrutura_fixa_drive
  for select to authenticated
  using (public.op_usuario_interno_ativo() and ativo);


-- -----------------------------------------------------------------------------
-- 3. A estrutura
--
-- BPO_FINANCEIRO
-- ├── 00_INTERNO
-- │   ├── 01_COMERCIAL_E_PRECIFICACAO
-- │   ├── 02_MODELOS_DE_CONTRATOS
-- │   ├── 03_ONBOARDING_E_KICKOFF
-- │   ├── 04_MODELOS_DE_RELATORIOS
-- │   ├── 05_PROCESSOS_E_TREINAMENTOS
-- │   └── 06_GESTAO_E_ANALISES_INTERNAS
-- ├── 01_CLIENTES_ATIVOS
-- └── 02_CLIENTES_INATIVOS
-- -----------------------------------------------------------------------------

insert into public.estrutura_fixa_drive (chave, caminho_modelo, descricao, ordem)
values
  ('interno_raiz', '["00_INTERNO"]',
   'Documentos da própria Effective. Não pertencem a cliente.', 10),
  ('interno_comercial_precificacao', '["00_INTERNO","01_COMERCIAL_E_PRECIFICACAO"]',
   'Comercial e precificação.', 11),
  ('interno_modelos_contratos', '["00_INTERNO","02_MODELOS_DE_CONTRATOS"]',
   'Modelos de contrato.', 12),
  ('interno_onboarding_kickoff', '["00_INTERNO","03_ONBOARDING_E_KICKOFF"]',
   'Onboarding e kickoff.', 13),
  ('interno_modelos_relatorios', '["00_INTERNO","04_MODELOS_DE_RELATORIOS"]',
   'Modelos de relatório.', 14),
  ('interno_processos_treinamentos', '["00_INTERNO","05_PROCESSOS_E_TREINAMENTOS"]',
   'Processos e treinamentos.', 15),
  ('interno_gestao_analises', '["00_INTERNO","06_GESTAO_E_ANALISES_INTERNAS"]',
   'Gestão e análises internas.', 16),

  -- Contêineres das pastas de empresa. A pasta de cada cliente nasce sob
  -- demanda DENTRO de um destes, nunca solta na raiz.
  ('clientes_ativos', '["01_CLIENTES_ATIVOS"]',
   'Contêiner das pastas de clientes ativos. Documento nenhum é arquivado direto aqui.', 20),
  ('clientes_inativos', '["02_CLIENTES_INATIVOS"]',
   'Contêiner das pastas de clientes inativos. Documento nenhum é arquivado direto aqui.', 21)
on conflict (chave) do nothing;
