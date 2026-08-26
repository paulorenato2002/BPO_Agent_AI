-- =============================================================================
-- Camada operacional — RLS e privilégios das NOVAS tabelas
--
-- IMPORTANTE: esta migration toca APENAS as tabelas criadas nesta camada.
-- Nenhuma política, grant ou RLS das 26 tabelas já existentes é alterada aqui.
-- A revisão dos privilégios legados está em `..._seguranca_revogacoes.sql`,
-- que é separada de propósito e exige aprovação explícita.
--
-- MODELO DE ACESSO:
--   anon           -> nenhum acesso às tabelas operacionais.
--   authenticated  -> somente usuários INTERNOS ATIVOS (perfis_usuarios.ativo),
--                     com escrita conforme papel.
--   service_role   -> ignora RLS por definição; é o backend. A chave nunca sai
--                     do servidor.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Habilita RLS em todas as novas tabelas
-- -----------------------------------------------------------------------------

alter table public.perfis_usuarios             enable row level security;
alter table public.competencias_operacionais   enable row level security;
alter table public.modelos_rotina              enable row level security;
alter table public.etapas_modelo_rotina        enable row level security;
alter table public.rotinas_empresa             enable row level security;
alter table public.tarefas_operacionais        enable row level security;
alter table public.apontamentos_tempo          enable row level security;
alter table public.documentos_operacionais     enable row level security;
alter table public.documento_localizacoes      enable row level security;
alter table public.execucoes_ferramenta        enable row level security;
alter table public.aprovacoes_operacionais     enable row level security;
alter table public.notificacoes_operacionais   enable row level security;
alter table public.eventos_operacionais        enable row level security;
alter table public.conversas_agente            enable row level security;
alter table public.mensagens_agente            enable row level security;


-- -----------------------------------------------------------------------------
-- 2. Privilégios de tabela
--    O Supabase concede ALL a anon/authenticated por default privileges.
--    Revogamos de `anon` explicitamente — dados operacionais nunca são públicos.
--    TRUNCATE e TRIGGER jamais são concedidos a usuários comuns.
-- -----------------------------------------------------------------------------

do $$
declare
  t text;
  tabelas text[] := array[
    'perfis_usuarios', 'competencias_operacionais', 'modelos_rotina',
    'etapas_modelo_rotina', 'rotinas_empresa', 'tarefas_operacionais',
    'apontamentos_tempo', 'documentos_operacionais', 'documento_localizacoes',
    'execucoes_ferramenta', 'aprovacoes_operacionais', 'notificacoes_operacionais',
    'eventos_operacionais', 'conversas_agente', 'mensagens_agente'
  ];
begin
  foreach t in array tabelas loop
    execute format('revoke all on public.%I from anon;', t);
    execute format('revoke all on public.%I from authenticated;', t);
    execute format('grant select, insert, update on public.%I to authenticated;', t);
  end loop;

  -- eventos_operacionais: append-only, nem UPDATE é concedido.
  execute 'revoke update on public.eventos_operacionais from authenticated;';

  -- Exclusão de conversa é lógica (arquivamento); DELETE físico só via backend.
  -- mensagens_agente nunca é editada pelo cliente.
  execute 'revoke update on public.mensagens_agente from authenticated;';
end;
$$;


-- -----------------------------------------------------------------------------
-- 3. Políticas — dados operacionais internos
--    Leitura para qualquer usuário interno ativo; escrita conforme papel.
-- -----------------------------------------------------------------------------

-- perfis_usuarios --------------------------------------------------------------
drop policy if exists perfis_usuarios_select on public.perfis_usuarios;
create policy perfis_usuarios_select on public.perfis_usuarios
  for select to authenticated
  using (public.op_usuario_interno_ativo());

-- Cada um edita o próprio perfil; administrador/sócio editam qualquer um.
drop policy if exists perfis_usuarios_update on public.perfis_usuarios;
create policy perfis_usuarios_update on public.perfis_usuarios
  for update to authenticated
  using (usuario_id = auth.uid() or public.op_usuario_tem_papel('administrador', 'socio'))
  with check (usuario_id = auth.uid() or public.op_usuario_tem_papel('administrador', 'socio'));

-- Criação de perfis é operação administrativa (backend/service_role).
drop policy if exists perfis_usuarios_insert on public.perfis_usuarios;
create policy perfis_usuarios_insert on public.perfis_usuarios
  for insert to authenticated
  with check (public.op_usuario_tem_papel('administrador', 'socio'));


-- Tabelas operacionais de leitura ampla / escrita interna ----------------------
do $$
declare
  t text;
  tabelas text[] := array[
    'competencias_operacionais', 'modelos_rotina', 'etapas_modelo_rotina',
    'rotinas_empresa', 'tarefas_operacionais', 'documentos_operacionais',
    'documento_localizacoes', 'execucoes_ferramenta', 'aprovacoes_operacionais'
  ];
begin
  foreach t in array tabelas loop
    execute format('drop policy if exists %I on public.%I;', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.op_usuario_interno_ativo());',
      t || '_select', t);

    execute format('drop policy if exists %I on public.%I;', t || '_insert', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.op_usuario_interno_ativo());',
      t || '_insert', t);

    execute format('drop policy if exists %I on public.%I;', t || '_update', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.op_usuario_interno_ativo()) with check (public.op_usuario_interno_ativo());',
      t || '_update', t);
  end loop;
end;
$$;


-- apontamentos_tempo: cada usuário mexe no próprio apontamento ------------------
drop policy if exists apontamentos_tempo_select on public.apontamentos_tempo;
create policy apontamentos_tempo_select on public.apontamentos_tempo
  for select to authenticated
  using (
    usuario_id = auth.uid()
    or public.op_usuario_tem_papel('administrador', 'socio', 'supervisor')
  );

drop policy if exists apontamentos_tempo_insert on public.apontamentos_tempo;
create policy apontamentos_tempo_insert on public.apontamentos_tempo
  for insert to authenticated
  with check (usuario_id = auth.uid() and public.op_usuario_interno_ativo());

drop policy if exists apontamentos_tempo_update on public.apontamentos_tempo;
create policy apontamentos_tempo_update on public.apontamentos_tempo
  for update to authenticated
  using (usuario_id = auth.uid() or public.op_usuario_tem_papel('administrador', 'socio'))
  with check (usuario_id = auth.uid() or public.op_usuario_tem_papel('administrador', 'socio'));


-- notificacoes_operacionais: cada usuário vê as suas --------------------------
drop policy if exists notificacoes_op_select on public.notificacoes_operacionais;
create policy notificacoes_op_select on public.notificacoes_operacionais
  for select to authenticated
  using (
    usuario_id = auth.uid()
    or public.op_usuario_tem_papel('administrador', 'socio')
  );

-- Marcar como lida.
drop policy if exists notificacoes_op_update on public.notificacoes_operacionais;
create policy notificacoes_op_update on public.notificacoes_operacionais
  for update to authenticated
  using (usuario_id = auth.uid())
  with check (usuario_id = auth.uid());


-- eventos_operacionais: leitura interna, inserção interna, sem update/delete ---
drop policy if exists eventos_op_select on public.eventos_operacionais;
create policy eventos_op_select on public.eventos_operacionais
  for select to authenticated
  using (public.op_usuario_interno_ativo());

drop policy if exists eventos_op_insert on public.eventos_operacionais;
create policy eventos_op_insert on public.eventos_operacionais
  for insert to authenticated
  with check (public.op_usuario_interno_ativo());


-- -----------------------------------------------------------------------------
-- 4. Políticas — conversas do agente
--    Isolamento por usuário: ninguém lê a conversa de outro.
-- -----------------------------------------------------------------------------

drop policy if exists conversas_agente_select on public.conversas_agente;
create policy conversas_agente_select on public.conversas_agente
  for select to authenticated
  using (usuario_id = auth.uid());

drop policy if exists conversas_agente_insert on public.conversas_agente;
create policy conversas_agente_insert on public.conversas_agente
  for insert to authenticated
  with check (usuario_id = auth.uid() and public.op_usuario_interno_ativo());

drop policy if exists conversas_agente_update on public.conversas_agente;
create policy conversas_agente_update on public.conversas_agente
  for update to authenticated
  using (usuario_id = auth.uid())
  with check (usuario_id = auth.uid());


-- mensagens_agente: acessível apenas através da conversa do próprio usuário ----
drop policy if exists mensagens_agente_select on public.mensagens_agente;
create policy mensagens_agente_select on public.mensagens_agente
  for select to authenticated
  using (
    exists (
      select 1 from public.conversas_agente c
      where c.id = mensagens_agente.conversa_id
        and c.usuario_id = auth.uid()
    )
  );

drop policy if exists mensagens_agente_insert on public.mensagens_agente;
create policy mensagens_agente_insert on public.mensagens_agente
  for insert to authenticated
  with check (
    exists (
      select 1 from public.conversas_agente c
      where c.id = mensagens_agente.conversa_id
        and c.usuario_id = auth.uid()
    )
  );


-- -----------------------------------------------------------------------------
-- 5. Privilégios das funções auxiliares
-- -----------------------------------------------------------------------------

revoke all on function public.op_usuario_interno_ativo()      from public, anon;
revoke all on function public.op_papel_usuario()              from public, anon;
revoke all on function public.op_usuario_tem_papel(text[])    from public, anon;

grant execute on function public.op_usuario_interno_ativo()   to authenticated, service_role;
grant execute on function public.op_papel_usuario()           to authenticated, service_role;
grant execute on function public.op_usuario_tem_papel(text[]) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 6. Views: sem acesso anônimo
-- -----------------------------------------------------------------------------

do $$
declare
  v text;
  views text[] := array[
    'vw_tarefas_hoje', 'vw_tarefas_atrasadas', 'vw_tarefas_semana',
    'vw_operacao_por_empresa', 'vw_cronometros_ativos', 'vw_horas_por_empresa',
    'vw_execucoes_pendentes', 'vw_execucoes_erro',
    'vw_documentos_por_empresa_competencia'
  ];
begin
  foreach v in array views loop
    execute format('revoke all on public.%I from anon;', v);
    execute format('grant select on public.%I to authenticated;', v);
  end loop;
end;
$$;
