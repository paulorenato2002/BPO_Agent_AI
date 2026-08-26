-- =============================================================================
-- Camada operacional — Execução
--
-- tarefas_operacionais : execução real de uma rotina para uma empresa/competência
-- apontamentos_tempo   : sessões de trabalho (cronômetro)
--
-- ESCOPO: a estrutura existe no banco, mas NÃO é conectada ao agente nesta fase.
-- Nome `tarefas_operacionais` é distinto de `tarefas_onboarding` (já existente),
-- que continua intacta e com finalidade diferente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. tarefas_operacionais
-- -----------------------------------------------------------------------------

create table if not exists public.tarefas_operacionais (
  id                        uuid primary key default gen_random_uuid(),
  empresa_id                uuid not null references public.empresas(id) on delete restrict,
  competencia_id            uuid references public.competencias_operacionais(id) on delete set null,
  rotina_empresa_id         uuid references public.rotinas_empresa(id) on delete set null,
  modelo_rotina_id          uuid references public.modelos_rotina(id) on delete set null,
  etapa_atual_id            uuid references public.etapas_modelo_rotina(id) on delete set null,
  responsavel_id            uuid references public.perfis_usuarios(usuario_id) on delete set null,
  titulo                    text not null,
  descricao                 text,
  prioridade                varchar(20) not null default 'normal',
  status                    varchar(30) not null default 'pendente',
  prazo                     date,
  iniciada_em               timestamptz,
  concluida_em              timestamptz,
  duracao_estimada_minutos  integer,
  duracao_real_minutos      integer,
  origem                    varchar(30) not null default 'manual',
  bloqueada                 boolean not null default false,
  bloqueio_motivo           text,
  observacoes               text,
  -- Idempotência: impede que a mesma execução lógica seja criada duas vezes
  -- (ex.: agendador reprocessando o mesmo mês).
  chave_idempotencia        text,
  metadados                 jsonb not null default '{}'::jsonb,
  ativo                     boolean not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  created_by                uuid,
  updated_by                uuid,
  constraint tarefas_operacionais_status_check
    check (status in ('pendente', 'pronta', 'em_execucao', 'aguardando_documento',
                      'aguardando_usuario', 'aguardando_aplicacao', 'aguardando_aprovacao',
                      'bloqueada', 'concluida', 'erro', 'cancelada')),
  constraint tarefas_operacionais_prioridade_check
    check (prioridade in ('baixa', 'normal', 'alta', 'urgente')),
  constraint tarefas_operacionais_origem_check
    check (origem in ('manual', 'agendador', 'agente', 'aplicacao', 'importacao')),
  constraint tarefas_operacionais_duracao_estimada_check
    check (duracao_estimada_minutos is null or duracao_estimada_minutos >= 0),
  constraint tarefas_operacionais_duracao_real_check
    check (duracao_real_minutos is null or duracao_real_minutos >= 0),
  constraint tarefas_operacionais_conclusao_check
    check (concluida_em is null or iniciada_em is null or concluida_em >= iniciada_em),
  -- Se está bloqueada, precisa dizer o porquê.
  constraint tarefas_operacionais_bloqueio_check
    check (not bloqueada or bloqueio_motivo is not null)
);

comment on table public.tarefas_operacionais is
  'Execução real de uma rotina para uma empresa/competência. Distinta de tarefas_onboarding.';
comment on column public.tarefas_operacionais.chave_idempotencia is
  'Chave lógica única para evitar criação duplicada da mesma execução.';

create unique index if not exists tarefas_operacionais_idempotencia_uk
  on public.tarefas_operacionais (chave_idempotencia)
  where chave_idempotencia is not null;

create index if not exists tarefas_op_empresa_idx      on public.tarefas_operacionais (empresa_id) where ativo;
create index if not exists tarefas_op_competencia_idx  on public.tarefas_operacionais (competencia_id);
create index if not exists tarefas_op_responsavel_idx  on public.tarefas_operacionais (responsavel_id, status) where ativo;
create index if not exists tarefas_op_status_idx       on public.tarefas_operacionais (status) where ativo;
-- Suporta as views "tarefas de hoje / atrasadas / da semana".
create index if not exists tarefas_op_prazo_idx        on public.tarefas_operacionais (prazo)
  where ativo and status not in ('concluida', 'cancelada');

drop trigger if exists tarefas_operacionais_set_updated_at on public.tarefas_operacionais;
create trigger tarefas_operacionais_set_updated_at
  before update on public.tarefas_operacionais
  for each row execute function public.op_set_updated_at();


-- -----------------------------------------------------------------------------
-- 2. apontamentos_tempo
-- -----------------------------------------------------------------------------

create table if not exists public.apontamentos_tempo (
  id                      uuid primary key default gen_random_uuid(),
  usuario_id              uuid not null references public.perfis_usuarios(usuario_id) on delete cascade,
  empresa_id              uuid references public.empresas(id) on delete set null,
  tarefa_operacional_id   uuid references public.tarefas_operacionais(id) on delete set null,
  inicio                  timestamptz not null default now(),
  fim                     timestamptz,
  -- Coluna derivada: duração em minutos, calculada quando a sessão é fechada.
  duracao_minutos         integer generated always as (
                            case
                              when fim is null then null
                              else greatest(0, (extract(epoch from (fim - inicio)) / 60)::int)
                            end
                          ) stored,
  status                  varchar(20) not null default 'em_andamento',
  observacoes             text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid,
  updated_by              uuid,
  constraint apontamentos_tempo_status_check
    check (status in ('em_andamento', 'pausado', 'concluido', 'cancelado')),
  constraint apontamentos_tempo_periodo_check
    check (fim is null or fim >= inicio),
  -- Uma sessão concluída obrigatoriamente tem fim.
  constraint apontamentos_tempo_conclusao_check
    check (status <> 'concluido' or fim is not null)
);

comment on table public.apontamentos_tempo is
  'Sessões de trabalho (cronômetro). Estrutura pronta; o agente não usa cronômetro nesta fase.';

-- REGRA DE NEGÓCIO: no máximo um cronômetro ativo por usuário.
-- Índice único parcial é a forma correta de garantir isso no próprio banco.
create unique index if not exists apontamentos_tempo_um_ativo_por_usuario_uk
  on public.apontamentos_tempo (usuario_id)
  where status = 'em_andamento';

create index if not exists apontamentos_tempo_usuario_idx on public.apontamentos_tempo (usuario_id, inicio desc);
create index if not exists apontamentos_tempo_empresa_idx on public.apontamentos_tempo (empresa_id, inicio desc)
  where empresa_id is not null;
create index if not exists apontamentos_tempo_tarefa_idx  on public.apontamentos_tempo (tarefa_operacional_id)
  where tarefa_operacional_id is not null;

drop trigger if exists apontamentos_tempo_set_updated_at on public.apontamentos_tempo;
create trigger apontamentos_tempo_set_updated_at
  before update on public.apontamentos_tempo
  for each row execute function public.op_set_updated_at();
