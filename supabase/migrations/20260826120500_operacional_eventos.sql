-- =============================================================================
-- Camada operacional — Eventos (histórico append-only)
--
-- Histórico imutável das ações relevantes: documento recebido/classificado/
-- renomeado/armazenado, cópia realizada, execução criada/concluída, erro,
-- aprovação, alteração operacional.
--
-- IMUTABILIDADE: um trigger BEFORE UPDATE OR DELETE bloqueia qualquer alteração.
-- Isso vale inclusive para `service_role`, que ignora RLS mas NÃO ignora
-- triggers — por isso a garantia está no trigger, não apenas em política.
-- =============================================================================

create table if not exists public.eventos_operacionais (
  id                      bigint generated always as identity primary key,
  tipo_evento             varchar(60) not null,
  entidade_tipo           varchar(60),
  entidade_id             uuid,
  empresa_id              uuid references public.empresas(id) on delete set null,
  competencia_id          uuid references public.competencias_operacionais(id) on delete set null,
  usuario_id              uuid references public.perfis_usuarios(usuario_id) on delete set null,
  execucao_ferramenta_id  uuid references public.execucoes_ferramenta(id) on delete set null,
  documento_id            uuid references public.documentos_operacionais(id) on delete set null,
  severidade              varchar(20) not null default 'info',
  descricao               text not null,
  dados                   jsonb not null default '{}'::jsonb,
  origem                  varchar(30) not null default 'agente',
  created_at              timestamptz not null default now(),
  constraint eventos_op_severidade_check
    check (severidade in ('debug', 'info', 'aviso', 'erro', 'critico')),
  constraint eventos_op_origem_check
    check (origem in ('agente', 'aplicacao', 'usuario', 'sistema', 'integracao'))
);

comment on table public.eventos_operacionais is
  'Histórico append-only de ações relevantes. UPDATE e DELETE são bloqueados por trigger.';
comment on column public.eventos_operacionais.dados is
  'Payload do evento. NUNCA registrar tokens, chaves ou segredos aqui.';

create index if not exists eventos_op_tipo_idx      on public.eventos_operacionais (tipo_evento, created_at desc);
create index if not exists eventos_op_empresa_idx   on public.eventos_operacionais (empresa_id, created_at desc);
create index if not exists eventos_op_entidade_idx  on public.eventos_operacionais (entidade_tipo, entidade_id);
create index if not exists eventos_op_documento_idx on public.eventos_operacionais (documento_id)
  where documento_id is not null;
create index if not exists eventos_op_severidade_idx on public.eventos_operacionais (severidade, created_at desc)
  where severidade in ('erro', 'critico');
create index if not exists eventos_op_created_at_idx on public.eventos_operacionais (created_at desc);


-- -----------------------------------------------------------------------------
-- Garantia de imutabilidade
-- -----------------------------------------------------------------------------

create or replace function public.op_bloquear_alteracao_eventos()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'eventos_operacionais é append-only: operação % não é permitida.', tg_op
    using errcode = 'restrict_violation',
          hint = 'Registre um novo evento de correção em vez de alterar o histórico.';
end;
$$;

comment on function public.op_bloquear_alteracao_eventos() is
  'Impede UPDATE/DELETE em eventos_operacionais, preservando o histórico.';

drop trigger if exists eventos_operacionais_append_only on public.eventos_operacionais;
create trigger eventos_operacionais_append_only
  before update or delete on public.eventos_operacionais
  for each row execute function public.op_bloquear_alteracao_eventos();
