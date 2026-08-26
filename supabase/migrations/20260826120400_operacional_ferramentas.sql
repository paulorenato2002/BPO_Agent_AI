-- =============================================================================
-- Camada operacional — Ferramentas, aprovações e notificações
--
-- execucoes_ferramenta      : registro de TODA chamada de ferramenta
-- aprovacoes_operacionais   : aprovação humana para ações sensíveis
-- notificacoes_operacionais : fila de notificações (envio real NÃO implementado)
--
-- NENHUMA ferramenta específica de negócio é registrada como ativa nesta fase.
-- O catálogo de ferramentas vive no backend (ToolRegistry), não no banco.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. execucoes_ferramenta
-- -----------------------------------------------------------------------------

create table if not exists public.execucoes_ferramenta (
  id                    uuid primary key default gen_random_uuid(),
  ferramenta_codigo     varchar(80) not null,
  ferramenta_versao     varchar(20) not null default '1',
  usuario_id            uuid references public.perfis_usuarios(usuario_id) on delete set null,
  empresa_id            uuid references public.empresas(id) on delete set null,
  competencia_id        uuid references public.competencias_operacionais(id) on delete set null,
  tarefa_operacional_id uuid references public.tarefas_operacionais(id) on delete set null,
  entrada               jsonb not null default '{}'::jsonb,
  saida                 jsonb,
  status                varchar(30) not null default 'criada',
  tentativas            smallint not null default 0,
  criada_em             timestamptz not null default now(),
  iniciada_em           timestamptz,
  concluida_em          timestamptz,
  duracao_ms            integer,
  erro_codigo           varchar(60),
  erro_mensagem         text,
  chave_idempotencia    text,
  metadados             jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid,
  updated_by            uuid,
  constraint execucoes_ferramenta_status_check
    check (status in ('criada', 'validando', 'na_fila', 'executando',
                      'aguardando_aprovacao', 'concluida', 'erro', 'cancelada')),
  constraint execucoes_ferramenta_tentativas_check check (tentativas >= 0),
  constraint execucoes_ferramenta_duracao_check    check (duracao_ms is null or duracao_ms >= 0),
  constraint execucoes_ferramenta_periodo_check
    check (concluida_em is null or iniciada_em is null or concluida_em >= iniciada_em),
  -- Erro precisa registrar a mensagem.
  constraint execucoes_ferramenta_erro_check
    check (status <> 'erro' or erro_mensagem is not null)
);

comment on table public.execucoes_ferramenta is
  'Registro de toda chamada de ferramenta feita pelo agente ou por aplicações. Catálogo vive no ToolRegistry (backend).';
comment on column public.execucoes_ferramenta.chave_idempotencia is
  'Impede reexecução duplicada da mesma chamada lógica.';

create unique index if not exists execucoes_ferramenta_idempotencia_uk
  on public.execucoes_ferramenta (chave_idempotencia)
  where chave_idempotencia is not null;

create index if not exists execucoes_ferramenta_codigo_idx  on public.execucoes_ferramenta (ferramenta_codigo, status);
create index if not exists execucoes_ferramenta_empresa_idx on public.execucoes_ferramenta (empresa_id, criada_em desc);
create index if not exists execucoes_ferramenta_usuario_idx on public.execucoes_ferramenta (usuario_id, criada_em desc);
-- Suporta as views "execuções pendentes" e "execuções com erro".
create index if not exists execucoes_ferramenta_status_idx  on public.execucoes_ferramenta (status, criada_em desc);

drop trigger if exists execucoes_ferramenta_set_updated_at on public.execucoes_ferramenta;
create trigger execucoes_ferramenta_set_updated_at
  before update on public.execucoes_ferramenta
  for each row execute function public.op_set_updated_at();


-- -----------------------------------------------------------------------------
-- 2. aprovacoes_operacionais
-- -----------------------------------------------------------------------------

create table if not exists public.aprovacoes_operacionais (
  id                      uuid primary key default gen_random_uuid(),
  execucao_ferramenta_id  uuid references public.execucoes_ferramenta(id) on delete cascade,
  tarefa_operacional_id   uuid references public.tarefas_operacionais(id) on delete set null,
  empresa_id              uuid references public.empresas(id) on delete set null,
  acao                    varchar(80) not null,
  nivel_risco             varchar(20) not null default 'medio',
  descricao               text not null,
  payload                 jsonb not null default '{}'::jsonb,
  solicitante_id          uuid references public.perfis_usuarios(usuario_id) on delete set null,
  aprovador_id            uuid references public.perfis_usuarios(usuario_id) on delete set null,
  decisao                 varchar(20) not null default 'pendente',
  solicitada_em           timestamptz not null default now(),
  decidida_em             timestamptz,
  expira_em               timestamptz,
  observacoes             text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid,
  updated_by              uuid,
  constraint aprovacoes_op_nivel_risco_check
    check (nivel_risco in ('baixo', 'medio', 'alto', 'critico')),
  constraint aprovacoes_op_decisao_check
    check (decisao in ('pendente', 'aprovada', 'rejeitada', 'expirada', 'cancelada')),
  -- Decisão tomada precisa de data e de quem decidiu.
  constraint aprovacoes_op_decisao_completa_check
    check (decisao = 'pendente'
           or decisao in ('expirada', 'cancelada')
           or (decidida_em is not null and aprovador_id is not null))
);

comment on table public.aprovacoes_operacionais is
  'Aprovação humana obrigatória para ações sensíveis (exclusões, ações externas, alto risco).';

create index if not exists aprovacoes_op_decisao_idx   on public.aprovacoes_operacionais (decisao, solicitada_em desc);
create index if not exists aprovacoes_op_execucao_idx  on public.aprovacoes_operacionais (execucao_ferramenta_id);
create index if not exists aprovacoes_op_aprovador_idx on public.aprovacoes_operacionais (aprovador_id)
  where aprovador_id is not null;

drop trigger if exists aprovacoes_operacionais_set_updated_at on public.aprovacoes_operacionais;
create trigger aprovacoes_operacionais_set_updated_at
  before update on public.aprovacoes_operacionais
  for each row execute function public.op_set_updated_at();


-- -----------------------------------------------------------------------------
-- 3. notificacoes_operacionais
--    Estrutura preparada. NÃO há envio real nesta fase.
-- -----------------------------------------------------------------------------

create table if not exists public.notificacoes_operacionais (
  id                    uuid primary key default gen_random_uuid(),
  usuario_id            uuid references public.perfis_usuarios(usuario_id) on delete cascade,
  empresa_id            uuid references public.empresas(id) on delete set null,
  tipo                  varchar(60) not null,
  canal                 varchar(30) not null default 'interno',
  titulo                text,
  mensagem              text not null,
  status                varchar(20) not null default 'pendente',
  agendada_para         timestamptz,
  enviada_em            timestamptz,
  lida_em               timestamptz,
  erro_mensagem         text,
  -- Deduplicação: evita disparar a mesma notificação repetidas vezes.
  chave_deduplicacao    text,
  metadados             jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid,
  updated_by            uuid,
  constraint notificacoes_op_canal_check
    check (canal in ('interno', 'email', 'whatsapp', 'push', 'webhook')),
  constraint notificacoes_op_status_check
    check (status in ('pendente', 'agendada', 'enviada', 'lida', 'erro', 'cancelada')),
  constraint notificacoes_op_envio_check
    check (status <> 'enviada' or enviada_em is not null),
  constraint notificacoes_op_erro_check
    check (status <> 'erro' or erro_mensagem is not null)
);

comment on table public.notificacoes_operacionais is
  'Fila de notificações. Estrutura preparada — o envio real NÃO está implementado nesta fase.';

create unique index if not exists notificacoes_op_deduplicacao_uk
  on public.notificacoes_operacionais (chave_deduplicacao)
  where chave_deduplicacao is not null;

create index if not exists notificacoes_op_usuario_idx on public.notificacoes_operacionais (usuario_id, created_at desc);
create index if not exists notificacoes_op_status_idx  on public.notificacoes_operacionais (status, agendada_para);

drop trigger if exists notificacoes_operacionais_set_updated_at on public.notificacoes_operacionais;
create trigger notificacoes_operacionais_set_updated_at
  before update on public.notificacoes_operacionais
  for each row execute function public.op_set_updated_at();
