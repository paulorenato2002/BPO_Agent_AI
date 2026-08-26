-- =============================================================================
-- Camada operacional — Rotinas
--
-- modelos_rotina        : rotina genérica, versionada (ex.: revisão de DRE)
-- etapas_modelo_rotina  : etapas de uma rotina
-- rotinas_empresa       : rotina aplicada a uma empresa, com config específica
--
-- NOTA: nenhum protocolo de negócio é cadastrado aqui. Apenas a estrutura.
--       Nenhum código executável é armazenado no banco — etapas apontam para
--       ferramentas por CÓDIGO (`ferramenta_codigo`), resolvido no backend
--       pelo ToolRegistry.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. modelos_rotina
-- -----------------------------------------------------------------------------

create table if not exists public.modelos_rotina (
  id                        uuid primary key default gen_random_uuid(),
  codigo                    varchar(50) not null,
  nome                      text not null,
  categoria                 varchar(40) not null default 'operacional',
  descricao                 text,
  versao                    integer not null default 1,
  -- Encadeamento de versões: aponta para a versão anterior do mesmo código.
  modelo_anterior_id        uuid references public.modelos_rotina(id) on delete set null,
  frequencia                varchar(30) not null default 'mensal',
  duracao_estimada_minutos  integer,
  situacao                  varchar(20) not null default 'rascunho',
  instrucoes_gerais         text,
  -- Configuração variável da rotina (parâmetros, defaults). JSON é adequado
  -- aqui porque o conteúdo varia por rotina e não é alvo de relacionamento.
  configuracao              jsonb not null default '{}'::jsonb,
  observacoes               text,
  ativo                     boolean not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid,
  updated_by                uuid,
  constraint modelos_rotina_versao_check check (versao >= 1),
  constraint modelos_rotina_duracao_check
    check (duracao_estimada_minutos is null or duracao_estimada_minutos >= 0),
  constraint modelos_rotina_categoria_check
    check (categoria in ('operacional', 'financeiro', 'contabil', 'fiscal',
                         'comercial', 'juridico', 'onboarding', 'administrativo')),
  constraint modelos_rotina_frequencia_check
    check (frequencia in ('diaria', 'semanal', 'quinzenal', 'mensal',
                          'bimestral', 'trimestral', 'semestral', 'anual', 'sob_demanda')),
  constraint modelos_rotina_situacao_check
    check (situacao in ('rascunho', 'ativa', 'descontinuada')),
  constraint modelos_rotina_codigo_versao_uk unique (codigo, versao)
);

comment on table public.modelos_rotina is
  'Modelo genérico de rotina operacional, versionado por (codigo, versao).';
comment on column public.modelos_rotina.configuracao is
  'Parâmetros variáveis da rotina. Não usar para dados que exijam relacionamento.';

create index if not exists modelos_rotina_codigo_idx    on public.modelos_rotina (codigo);
create index if not exists modelos_rotina_situacao_idx  on public.modelos_rotina (situacao) where ativo;
create index if not exists modelos_rotina_categoria_idx on public.modelos_rotina (categoria);

drop trigger if exists modelos_rotina_set_updated_at on public.modelos_rotina;
create trigger modelos_rotina_set_updated_at
  before update on public.modelos_rotina
  for each row execute function public.op_set_updated_at();


-- -----------------------------------------------------------------------------
-- 2. etapas_modelo_rotina
-- -----------------------------------------------------------------------------

create table if not exists public.etapas_modelo_rotina (
  id                        uuid primary key default gen_random_uuid(),
  modelo_rotina_id          uuid not null references public.modelos_rotina(id) on delete cascade,
  codigo                    varchar(50) not null,
  nome                      text not null,
  descricao                 text,
  ordem                     smallint not null,
  tipo_etapa                varchar(30) not null default 'manual',
  -- Código da ferramenta a ser chamada nesta etapa (resolvido pelo ToolRegistry
  -- no backend). Sem FK: o registro de ferramentas vive no código, não no banco.
  ferramenta_codigo         varchar(80),
  etapa_dependencia_id      uuid references public.etapas_modelo_rotina(id) on delete set null,
  obrigatoria               boolean not null default true,
  exige_aprovacao           boolean not null default false,
  exige_evidencia           boolean not null default false,
  duracao_estimada_minutos  integer,
  instrucao_execucao        text,
  criterio_conclusao        text,
  configuracao              jsonb not null default '{}'::jsonb,
  observacoes               text,
  ativo                     boolean not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid,
  updated_by                uuid,
  constraint etapas_modelo_rotina_tipo_check
    check (tipo_etapa in ('manual', 'coleta_dados', 'coleta_documentos', 'aplicacao',
                          'conferencia', 'aprovacao', 'comunicacao', 'atualizacao_sistema')),
  constraint etapas_modelo_rotina_ordem_check check (ordem >= 0),
  constraint etapas_modelo_rotina_duracao_check
    check (duracao_estimada_minutos is null or duracao_estimada_minutos >= 0),
  -- Etapa do tipo `aplicacao` precisa saber qual ferramenta chamar.
  constraint etapas_modelo_rotina_ferramenta_check
    check (tipo_etapa <> 'aplicacao' or ferramenta_codigo is not null),
  constraint etapas_modelo_rotina_codigo_uk unique (modelo_rotina_id, codigo),
  constraint etapas_modelo_rotina_ordem_uk  unique (modelo_rotina_id, ordem)
);

comment on table public.etapas_modelo_rotina is
  'Etapas de um modelo de rotina. Etapas de aplicação referenciam ferramentas por código (ToolRegistry no backend).';
comment on column public.etapas_modelo_rotina.ferramenta_codigo is
  'Código da ferramenta no ToolRegistry. Sem FK — o registro vive no backend, não no banco.';

create index if not exists etapas_modelo_rotina_modelo_idx     on public.etapas_modelo_rotina (modelo_rotina_id, ordem);
create index if not exists etapas_modelo_rotina_ferramenta_idx on public.etapas_modelo_rotina (ferramenta_codigo)
  where ferramenta_codigo is not null;

drop trigger if exists etapas_modelo_rotina_set_updated_at on public.etapas_modelo_rotina;
create trigger etapas_modelo_rotina_set_updated_at
  before update on public.etapas_modelo_rotina
  for each row execute function public.op_set_updated_at();


-- -----------------------------------------------------------------------------
-- 3. rotinas_empresa
--    Permite que uma rotina genérica tenha configuração específica por empresa.
-- -----------------------------------------------------------------------------

create table if not exists public.rotinas_empresa (
  id                    uuid primary key default gen_random_uuid(),
  empresa_id            uuid not null references public.empresas(id) on delete cascade,
  modelo_rotina_id      uuid not null references public.modelos_rotina(id) on delete restrict,
  contrato_id           uuid references public.contratos(id) on delete set null,
  contrato_servico_id   uuid references public.contrato_servicos(id) on delete set null,
  responsavel_id        uuid references public.perfis_usuarios(usuario_id) on delete set null,
  frequencia            varchar(30),
  prazo_dias            smallint,
  prioridade            varchar(20) not null default 'normal',
  -- Regra de agendamento (ex.: {"dia_do_mes": 5, "dias_uteis": true}).
  regra_agendamento     jsonb not null default '{}'::jsonb,
  -- Particularidades do cliente para esta rotina (texto livre + estruturado).
  particularidades      text,
  configuracao          jsonb not null default '{}'::jsonb,
  vigencia_inicio       date,
  vigencia_fim          date,
  situacao              varchar(20) not null default 'ativa',
  observacoes           text,
  ativo                 boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid,
  updated_by            uuid,
  constraint rotinas_empresa_prioridade_check
    check (prioridade in ('baixa', 'normal', 'alta', 'urgente')),
  constraint rotinas_empresa_situacao_check
    check (situacao in ('ativa', 'pausada', 'encerrada')),
  constraint rotinas_empresa_frequencia_check
    check (frequencia is null or frequencia in ('diaria', 'semanal', 'quinzenal', 'mensal',
           'bimestral', 'trimestral', 'semestral', 'anual', 'sob_demanda')),
  constraint rotinas_empresa_prazo_check check (prazo_dias is null or prazo_dias >= 0),
  constraint rotinas_empresa_vigencia_check
    check (vigencia_fim is null or vigencia_inicio is null or vigencia_fim >= vigencia_inicio)
);

comment on table public.rotinas_empresa is
  'Vincula um modelo de rotina a uma empresa, com responsável, prazo e particularidades do cliente.';

-- Uma empresa não deve ter a mesma rotina ativa duplicada.
create unique index if not exists rotinas_empresa_unica_ativa_uk
  on public.rotinas_empresa (empresa_id, modelo_rotina_id)
  where ativo and situacao = 'ativa';

create index if not exists rotinas_empresa_empresa_idx     on public.rotinas_empresa (empresa_id) where ativo;
create index if not exists rotinas_empresa_modelo_idx      on public.rotinas_empresa (modelo_rotina_id);
create index if not exists rotinas_empresa_responsavel_idx on public.rotinas_empresa (responsavel_id)
  where responsavel_id is not null;

drop trigger if exists rotinas_empresa_set_updated_at on public.rotinas_empresa;
create trigger rotinas_empresa_set_updated_at
  before update on public.rotinas_empresa
  for each row execute function public.op_set_updated_at();
