-- =============================================================================
-- Agente — Persistência de conversas
--
-- conversas_agente  : uma conversa (thread) de um usuário com o agente
-- mensagens_agente  : mensagens da conversa
--
-- Verificado antes de criar: o schema atual (26 tabelas) NÃO possui nenhuma
-- entidade de conversa/mensagem — não há duplicação de estrutura existente.
--
-- Preferência por ARQUIVAMENTO em vez de exclusão física (ver `arquivada_em`).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. conversas_agente
-- -----------------------------------------------------------------------------

create table if not exists public.conversas_agente (
  id                    uuid primary key default gen_random_uuid(),
  usuario_id            uuid not null references auth.users(id) on delete cascade,
  empresa_id            uuid references public.empresas(id) on delete set null,
  titulo                text not null default 'Nova conversa',
  status                varchar(20) not null default 'ativa',
  iniciada_em           timestamptz not null default now(),
  ultima_atividade_em   timestamptz not null default now(),
  arquivada_em          timestamptz,
  metadados             jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint conversas_agente_status_check
    check (status in ('ativa', 'arquivada', 'excluida')),
  -- Conversa arquivada/excluída precisa registrar quando isso aconteceu.
  constraint conversas_agente_arquivamento_check
    check (status = 'ativa' or arquivada_em is not null)
);

comment on table public.conversas_agente is
  'Thread de conversa entre um usuário e o agente. Exclusão é lógica (status/arquivada_em).';

create index if not exists conversas_agente_usuario_idx
  on public.conversas_agente (usuario_id, ultima_atividade_em desc)
  where status = 'ativa';
create index if not exists conversas_agente_usuario_todas_idx
  on public.conversas_agente (usuario_id, ultima_atividade_em desc);
-- Busca por título no histórico da barra lateral.
create index if not exists conversas_agente_titulo_idx
  on public.conversas_agente using gin (to_tsvector('portuguese', titulo));

drop trigger if exists conversas_agente_set_updated_at on public.conversas_agente;
create trigger conversas_agente_set_updated_at
  before update on public.conversas_agente
  for each row execute function public.op_set_updated_at();


-- -----------------------------------------------------------------------------
-- 2. mensagens_agente
-- -----------------------------------------------------------------------------

create table if not exists public.mensagens_agente (
  id                uuid primary key default gen_random_uuid(),
  conversa_id       uuid not null references public.conversas_agente(id) on delete cascade,
  papel             varchar(20) not null,
  conteudo          text,
  tipo_mensagem     varchar(20) not null default 'texto',
  -- Payload estruturado: cartões de arquivo, resultado de armazenamento,
  -- chamadas de ferramenta. O que a UI precisa para renderizar cartões ricos.
  metadados         jsonb not null default '{}'::jsonb,
  documento_id      uuid references public.documentos_operacionais(id) on delete set null,
  -- Ordem estável dentro da conversa (created_at pode empatar).
  sequencia         bigint generated always as identity,
  created_at        timestamptz not null default now(),
  constraint mensagens_agente_papel_check
    check (papel in ('usuario', 'agente', 'sistema', 'ferramenta')),
  constraint mensagens_agente_tipo_check
    check (tipo_mensagem in ('texto', 'arquivo', 'resultado', 'status', 'erro', 'aprovacao')),
  -- Mensagem de texto sem conteúdo não faz sentido; os demais tipos podem
  -- carregar apenas metadados (ex.: cartão de resultado).
  constraint mensagens_agente_conteudo_check
    check (tipo_mensagem <> 'texto' or conteudo is not null)
);

comment on table public.mensagens_agente is
  'Mensagens de uma conversa. `metadados` carrega cartões de arquivo/resultado para a UI.';
comment on column public.mensagens_agente.sequencia is
  'Ordem estável dentro da conversa — created_at pode empatar em inserções rápidas.';

create index if not exists mensagens_agente_conversa_idx
  on public.mensagens_agente (conversa_id, sequencia);
create index if not exists mensagens_agente_documento_idx
  on public.mensagens_agente (documento_id) where documento_id is not null;


-- -----------------------------------------------------------------------------
-- 3. Atualiza `ultima_atividade_em` da conversa a cada nova mensagem
-- -----------------------------------------------------------------------------

create or replace function public.op_touch_conversa()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  update public.conversas_agente
     set ultima_atividade_em = now(),
         updated_at = now()
   where id = new.conversa_id;
  return new;
end;
$$;

comment on function public.op_touch_conversa() is
  'Mantém conversas_agente.ultima_atividade_em em dia para ordenar o histórico.';

drop trigger if exists mensagens_agente_touch_conversa on public.mensagens_agente;
create trigger mensagens_agente_touch_conversa
  after insert on public.mensagens_agente
  for each row execute function public.op_touch_conversa();
