-- =============================================================================
-- Anexos do agente
--
-- Até aqui, um anexo existia SÓ no Supabase Storage, sob uma chave `arquivoId`
-- gerada no upload. Não havia dono, conversa nem mensagem: o UUID funcionava
-- como senha portadora — quem o tivesse lia o arquivo, e a rota de upload nem
-- exigia login.
--
-- Esta tabela dá identidade e dono ao anexo. Sem ela é impossível cumprir
-- "anexo privado" e "validar propriedade dos anexos" do arquivador: não havia
-- contra o que validar.
--
-- O conteúdo continua no Storage. Aqui ficam identidade, propriedade e o hash.
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


create table if not exists public.anexos_agente (
  id                uuid primary key default gen_random_uuid(),
  -- Chave do arquivo no Storage (bucket anexos-agente).
  arquivo_id        uuid not null,
  usuario_id        uuid not null references auth.users(id) on delete cascade,
  -- Conversa e mensagem podem ainda não existir no instante do upload: o
  -- arquivo é anexado antes de a mensagem ser enviada. O DONO, não.
  conversa_id       uuid references public.conversas_agente(id) on delete set null,
  mensagem_id       uuid references public.mensagens_agente(id) on delete set null,
  nome_original     text not null,
  extensao          varchar(20) not null,
  mime_type         text,
  tamanho_bytes     bigint not null,
  -- SHA-256 do conteúdo no momento do upload. É por ele que uma proposta
  -- descobre que o arquivo mudou e se invalida.
  hash_sha256       char(64) not null,
  -- Arquivo recusado por tipo ou por conteúdo sensível. Fica registrado em vez
  -- de sumir: o usuário precisa saber que foi bloqueado e por quê.
  bloqueado         boolean not null default false,
  motivo_bloqueio   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint anexos_agente_arquivo_uk unique (arquivo_id),
  constraint anexos_agente_tamanho_check check (tamanho_bytes > 0),
  constraint anexos_agente_hash_check check (hash_sha256 ~ '^[0-9a-f]{64}$'),
  -- Bloqueio sem motivo é bloqueio que ninguém consegue explicar depois.
  constraint anexos_agente_bloqueio_check
    check (not bloqueado or motivo_bloqueio is not null)
);

comment on table public.anexos_agente is
  'Identidade e propriedade dos arquivos anexados no chat. O conteúdo fica no Storage.';
comment on column public.anexos_agente.hash_sha256 is
  'SHA-256 no upload. Uma proposta se invalida quando o hash atual diverge deste.';

create index if not exists anexos_agente_usuario_idx
  on public.anexos_agente (usuario_id, created_at desc);
create index if not exists anexos_agente_conversa_idx
  on public.anexos_agente (conversa_id) where conversa_id is not null;
-- Duplicidade é detectada por (empresa, hash); o índice serve essa busca.
create index if not exists anexos_agente_hash_idx on public.anexos_agente (hash_sha256);

drop trigger if exists anexos_agente_set_updated_at on public.anexos_agente;
create trigger anexos_agente_set_updated_at
  before update on public.anexos_agente
  for each row execute function public.op_set_updated_at();


-- -----------------------------------------------------------------------------
-- RLS — o anexo é privado do dono
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

alter table public.anexos_agente enable row level security;

revoke all on public.anexos_agente from anon;
revoke all on public.anexos_agente from authenticated;
-- Só leitura, e só do próprio: gravar é responsabilidade do backend.
grant select on public.anexos_agente to authenticated;

-- Nem papel superior lê anexo alheio. Anexo é do usuário, não do departamento.
drop policy if exists anexos_agente_select on public.anexos_agente;
create policy anexos_agente_select on public.anexos_agente
  for select to authenticated
  using (usuario_id = auth.uid() and public.op_usuario_interno_ativo());


-- -----------------------------------------------------------------------------
-- Proposta: ligação explícita com os anexos analisados
-- -----------------------------------------------------------------------------

alter table public.propostas_arquivamento
  add column if not exists anexo_ids uuid[] not null default '{}';

comment on column public.propostas_arquivamento.anexo_ids is
  'Anexos analisados. Confirmar exige que todos ainda pertençam ao mesmo usuário e tenham o mesmo hash.';
