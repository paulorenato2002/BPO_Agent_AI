-- Caixa de entrada recebida do Gmail por meio do n8n Cloud.
-- A credencial Google permanece no n8n; este banco guarda somente os eventos
-- necessários para o Agente BPO consultar e processar.

-- Mantém a migration aplicável também em ambientes mínimos de teste.
create or replace function public.op_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.email_eventos (
  id                    uuid primary key default gen_random_uuid(),
  provedor              varchar(20) not null default 'gmail',
  provedor_evento_id    text not null,
  provedor_thread_id    text,
  conta_email           text not null,
  remetente             text not null,
  destinatarios         text[] not null default '{}',
  cc                    text[] not null default '{}',
  assunto               text not null default '',
  resumo                text not null default '',
  corpo_texto           text,
  recebido_em           timestamptz not null,
  tem_anexos            boolean not null default false,
  anexos                jsonb not null default '[]'::jsonb,
  status                varchar(20) not null default 'recebido',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint email_eventos_provedor_check
    check (provedor in ('gmail')),
  constraint email_eventos_status_check
    check (status in ('recebido', 'processando', 'processado', 'erro', 'ignorado')),
  constraint email_eventos_conta_check
    check (conta_email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),
  constraint email_eventos_id_externo_check
    check (length(provedor_evento_id) between 1 and 255),
  constraint email_eventos_anexos_array_check
    check (jsonb_typeof(anexos) = 'array'),
  constraint email_eventos_provedor_id_uk
    unique (provedor, provedor_evento_id)
);

comment on table public.email_eventos is
  'Mensagens recebidas pelo webhook autenticado do n8n. Credenciais Google nunca ficam nesta tabela.';
comment on column public.email_eventos.anexos is
  'Somente metadados nesta etapa: nome, MIME, tamanho e identificador no provedor; nunca segredo OAuth.';

create index if not exists email_eventos_status_idx
  on public.email_eventos (status, recebido_em desc);
create index if not exists email_eventos_conta_idx
  on public.email_eventos (conta_email, recebido_em desc);

drop trigger if exists email_eventos_set_updated_at on public.email_eventos;
create trigger email_eventos_set_updated_at
  before update on public.email_eventos
  for each row execute function public.op_set_updated_at();

alter table public.email_eventos enable row level security;
revoke all on table public.email_eventos from anon, authenticated;
