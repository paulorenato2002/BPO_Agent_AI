-- =============================================================================
-- RLS da memória, feedback e anexos de mensagem
--
-- CLASSIFICAÇÃO DE ACESSO (ver docs/classificacao_acesso.md):
--   privada do usuário  : conversas_agente, mensagens_agente, mensagem_documentos,
--                         feedback_agente, memórias de escopo `pessoal`
--   compartilhada       : memórias de escopo `empresa` / `organizacional` ATIVAS
--   restrita por papel  : aprovar/rejeitar/revogar memória
--   exclusiva do backend: memoria_utilizacoes (telemetria)
--
-- REGRA QUE NÃO SE NEGOCIA: papel superior NÃO dá acesso a conversa privada de
-- outro usuário. Supervisor/sócio/administrador aprovam memórias, mas não leem
-- as conversas alheias.
-- =============================================================================

alter table public.memorias_agente      enable row level security;
alter table public.memoria_utilizacoes  enable row level security;
alter table public.feedback_agente      enable row level security;
alter table public.mensagem_documentos  enable row level security;

-- -----------------------------------------------------------------------------
-- Privilégios: anon nunca; authenticated só o necessário.
-- -----------------------------------------------------------------------------

do $$
declare
  t text;
  tabelas text[] := array[
    'memorias_agente', 'memoria_utilizacoes', 'feedback_agente', 'mensagem_documentos'
  ];
begin
  foreach t in array tabelas loop
    execute format('revoke all on public.%I from anon;', t);
    execute format('revoke all on public.%I from authenticated;', t);
    execute format('grant select, insert on public.%I to authenticated;', t);
  end loop;

  -- Só memórias são atualizadas pelo cliente (aprovar/revogar via política).
  execute 'grant update on public.memorias_agente to authenticated;';
  -- Telemetria de uso é escrita pelo backend; o cliente não insere nem lê.
  execute 'revoke all on public.memoria_utilizacoes from authenticated;';
end;
$$;


-- -----------------------------------------------------------------------------
-- Funções auxiliares de visibilidade
-- -----------------------------------------------------------------------------

-- Uma memória é visível para o usuário atual?
create or replace function public.op_memoria_visivel(
  p_escopo text,
  p_usuario_id uuid,
  p_status text
)
returns boolean
language sql
stable
as $$
  select
    public.op_usuario_interno_ativo()
    and (
      -- Memória pessoal: só do dono, em qualquer status.
      (p_escopo = 'pessoal' and p_usuario_id = auth.uid())
      -- Demais escopos: ATIVAS são visíveis a qualquer usuário interno ativo.
      or (p_escopo <> 'pessoal' and p_status = 'ativa')
      -- Quem propôs enxerga a própria proposta antes de ser aprovada.
      or (p_usuario_id = auth.uid())
      -- Quem aprova precisa ver o que está na fila.
      or (p_status in ('candidata', 'aguardando_aprovacao')
          and public.op_usuario_tem_papel('administrador', 'socio', 'supervisor'))
    );
$$;

comment on function public.op_memoria_visivel(text, uuid, text) is
  'RLS: memória pessoal só do dono; demais escopos visíveis quando ativas.';

revoke all on function public.op_memoria_visivel(text, uuid, text) from public, anon;
grant execute on function public.op_memoria_visivel(text, uuid, text) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- memorias_agente
-- -----------------------------------------------------------------------------

drop policy if exists memorias_agente_select on public.memorias_agente;
create policy memorias_agente_select on public.memorias_agente
  for select to authenticated
  using (public.op_memoria_visivel(escopo, usuario_id, status));

-- Qualquer usuário interno ativo pode PROPOR. A política impede nascer ativa:
-- ativação passa pelo fluxo de aprovação (política de update + trigger).
drop policy if exists memorias_agente_insert on public.memorias_agente;
create policy memorias_agente_insert on public.memorias_agente
  for insert to authenticated
  with check (
    public.op_usuario_interno_ativo()
    and criada_por = auth.uid()
    and (
      -- Memória pessoal pode nascer ativa: o dono já é a autoridade.
      (escopo = 'pessoal' and usuario_id = auth.uid())
      -- Nos demais escopos, nasce como proposta.
      or status in ('candidata', 'aguardando_aprovacao')
    )
  );

drop policy if exists memorias_agente_update on public.memorias_agente;
create policy memorias_agente_update on public.memorias_agente
  for update to authenticated
  using (
    -- O dono mexe na própria memória pessoal.
    (escopo = 'pessoal' and usuario_id = auth.uid())
    -- Aprovadores mexem nas demais.
    or public.op_usuario_tem_papel('administrador', 'socio', 'supervisor')
  )
  with check (
    (escopo = 'pessoal' and usuario_id = auth.uid())
    or public.op_usuario_tem_papel('administrador', 'socio', 'supervisor')
  );


-- -----------------------------------------------------------------------------
-- Quem pode APROVAR o quê
--
-- Em trigger, e não só em política, porque a regra depende do escopo e do papel
-- ao mesmo tempo — e precisa valer também para chamadas vindas do backend.
-- -----------------------------------------------------------------------------

create or replace function public.op_validar_aprovacao_memoria()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  papel text;
begin
  -- Só interessa a transição para 'ativa'.
  if new.status <> 'ativa' or old.status = 'ativa' then
    return new;
  end if;

  -- Memória pessoal: o próprio dono confirma.
  if new.escopo = 'pessoal' then
    if new.usuario_id is distinct from new.aprovada_por then
      raise exception 'Memória pessoal só pode ser confirmada pelo próprio usuário.'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- Demais escopos exigem papel de aprovação.
  select p.papel into papel
  from public.perfis_usuarios p
  where p.usuario_id = new.aprovada_por and p.ativo;

  if papel is null or papel not in ('administrador', 'socio', 'supervisor') then
    raise exception
      'Memória de escopo % exige aprovação de supervisor, sócio ou administrador.', new.escopo
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.op_validar_aprovacao_memoria() is
  'Garante que só quem tem papel adequado ativa memória de empresa/organizacional.';

drop trigger if exists memorias_agente_valida_aprovacao on public.memorias_agente;
create trigger memorias_agente_valida_aprovacao
  before update on public.memorias_agente
  for each row execute function public.op_validar_aprovacao_memoria();


-- -----------------------------------------------------------------------------
-- feedback_agente — privado do autor
-- -----------------------------------------------------------------------------

drop policy if exists feedback_agente_select on public.feedback_agente;
create policy feedback_agente_select on public.feedback_agente
  for select to authenticated
  using (usuario_id = auth.uid());

drop policy if exists feedback_agente_insert on public.feedback_agente;
create policy feedback_agente_insert on public.feedback_agente
  for insert to authenticated
  with check (usuario_id = auth.uid() and public.op_usuario_interno_ativo());


-- -----------------------------------------------------------------------------
-- mensagem_documentos — segue a propriedade da CONVERSA
--
-- Não basta checar o documento: o vínculo só é visível se a mensagem pertencer
-- a uma conversa do próprio usuário. Assim ninguém acessa arquivo anexado na
-- conversa de outro.
-- -----------------------------------------------------------------------------

drop policy if exists mensagem_documentos_select on public.mensagem_documentos;
create policy mensagem_documentos_select on public.mensagem_documentos
  for select to authenticated
  using (
    exists (
      select 1
      from public.mensagens_agente m
      join public.conversas_agente c on c.id = m.conversa_id
      where m.id = mensagem_documentos.mensagem_id
        and c.usuario_id = auth.uid()
    )
  );

drop policy if exists mensagem_documentos_insert on public.mensagem_documentos;
create policy mensagem_documentos_insert on public.mensagem_documentos
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.mensagens_agente m
      join public.conversas_agente c on c.id = m.conversa_id
      where m.id = mensagem_documentos.mensagem_id
        and c.usuario_id = auth.uid()
    )
  );
