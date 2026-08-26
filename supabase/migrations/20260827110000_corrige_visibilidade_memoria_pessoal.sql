-- =============================================================================
-- CORREÇÃO DE SEGURANÇA — vazamento de memória pessoal
--
-- BUG: `op_memoria_visivel` tinha uma cláusula para que aprovadores enxergassem
-- a fila de memórias pendentes:
--
--     or (p_status in ('candidata','aguardando_aprovacao')
--         and op_usuario_tem_papel('administrador','socio','supervisor'))
--
-- Ela não excluía o escopo `pessoal`. E memória pessoal nasce como `candidata`.
-- Resultado: qualquer supervisor, sócio ou administrador lia as preferências
-- pessoais de todo mundo.
--
-- Encontrado por `scripts/testar-isolamento-usuarios.mjs`, que autentica dois
-- usuários reais e verifica o que cada um enxerga:
--     FALHA  B NÃO vê a memória pessoal de A
--
-- CORREÇÃO: separar os casos explicitamente. Memória pessoal é do dono e de
-- mais ninguém — papel superior não abre exceção, igual às conversas.
-- =============================================================================

-- Nova assinatura: agora considera também quem propôs (`criada_por`).
create or replace function public.op_memoria_visivel(
  p_escopo text,
  p_usuario_id uuid,
  p_status text,
  p_criada_por uuid
)
returns boolean
language sql
stable
as $$
  select
    public.op_usuario_interno_ativo()
    and case
      -- Pessoal: SOMENTE o dono, em qualquer status. Sem exceção por papel.
      when p_escopo = 'pessoal' then
        p_usuario_id = auth.uid()

      -- Demais escopos:
      --   - ativas: visíveis a qualquer interno ativo (é conhecimento da equipe);
      --   - pendentes: só quem propôs e quem tem papel para aprovar.
      else
        p_status = 'ativa'
        or p_criada_por = auth.uid()
        or (
          p_status in ('candidata', 'aguardando_aprovacao')
          and public.op_usuario_tem_papel('administrador', 'socio', 'supervisor')
        )
    end;
$$;

comment on function public.op_memoria_visivel(text, uuid, text, uuid) is
  'RLS: memória pessoal só do dono (nem supervisor vê); demais escopos visíveis quando ativas.';

revoke all on function public.op_memoria_visivel(text, uuid, text, uuid) from public, anon;
grant execute on function public.op_memoria_visivel(text, uuid, text, uuid)
  to authenticated, service_role;

-- Aponta a política para a nova assinatura.
drop policy if exists memorias_agente_select on public.memorias_agente;
create policy memorias_agente_select on public.memorias_agente
  for select to authenticated
  using (public.op_memoria_visivel(escopo, usuario_id, status, criada_por));

-- A versão antiga não pode continuar existindo: qualquer política que a
-- referencie por engano voltaria a vazar.
drop function if exists public.op_memoria_visivel(text, uuid, text);
