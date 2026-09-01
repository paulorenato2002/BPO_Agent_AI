-- =============================================================================
-- Testes de asserção da camada operacional
--
-- Roda contra um Postgres descartável (ver scripts/testar-migrations.sh).
-- Qualquer falha levanta exceção e aborta com código de saída != 0.
--
-- Cobre: preservação do schema existente, presença das novas entidades, RLS,
-- privilégios de anon, imutabilidade do histórico, e as regras de negócio que
-- foram implementadas como constraint (duplicidade, cronômetro único,
-- confirmação real de armazenamento).
-- =============================================================================

\set ON_ERROR_STOP on

create or replace function pg_temp.checar(descricao text, condicao boolean)
returns void language plpgsql as $$
begin
  if condicao then
    raise notice '  OK   %', descricao;
  else
    raise exception 'FALHOU: %', descricao;
  end if;
end;
$$;

do $$ begin raise notice E'\n--- 1. Preservação do schema existente ---'; end $$;

-- As 26 tabelas originais continuam existindo, intactas.
do $$
declare
  faltando text[];
  originais text[] := array[
    'empresas','enderecos_empresa','pessoas','empresa_pessoas','canais_comunicacao',
    'grupos_comunicacao','grupo_participantes','servicos','planos_referencia',
    'plano_servicos','contratos','contrato_servicos','modelos_precificacao',
    'modelo_recursos_equipe','regras_precificacao_servicos','precificacoes',
    'precificacao_itens','precificacao_componentes','modelos_onboarding',
    'fases_onboarding','tarefas_modelo_onboarding','onboardings','tarefas_onboarding',
    'evidencias_tarefa_onboarding','alertas_onboarding','historico_onboarding'
  ];
begin
  select array_agg(t) into faltando
  from unnest(originais) t
  where not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = t
  );
  perform pg_temp.checar(
    'as 26 tabelas originais continuam existindo',
    faltando is null
  );
end $$;

do $$ begin raise notice E'\n--- 2. Novas entidades criadas ---'; end $$;

do $$
declare
  faltando text[];
  novas text[] := array[
    'perfis_usuarios','competencias_operacionais','modelos_rotina',
    'etapas_modelo_rotina','rotinas_empresa','tarefas_operacionais',
    'apontamentos_tempo','documentos_operacionais','documento_localizacoes',
    'execucoes_ferramenta','aprovacoes_operacionais','notificacoes_operacionais',
    'eventos_operacionais','conversas_agente','mensagens_agente'
  ];
begin
  select array_agg(t) into faltando
  from unnest(novas) t
  where not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = t
  );
  perform pg_temp.checar('as 15 novas tabelas foram criadas', faltando is null);
end $$;

do $$
declare
  faltando text[];
  views text[] := array[
    'vw_tarefas_hoje','vw_tarefas_atrasadas','vw_tarefas_semana',
    'vw_operacao_por_empresa','vw_cronometros_ativos','vw_horas_por_empresa',
    'vw_execucoes_pendentes','vw_execucoes_erro','vw_documentos_por_empresa_competencia'
  ];
begin
  select array_agg(v) into faltando
  from unnest(views) v
  where not exists (
    select 1 from pg_views where schemaname = 'public' and viewname = v
  );
  perform pg_temp.checar('as 9 views do Hub foram criadas', faltando is null);
end $$;

do $$ begin raise notice E'\n--- 3. Segurança: RLS e privilégios ---'; end $$;

do $$
declare
  sem_rls text[];
begin
  select array_agg(c.relname) into sem_rls
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relkind = 'r'
    and c.relname in (
      'perfis_usuarios','competencias_operacionais','modelos_rotina',
      'etapas_modelo_rotina','rotinas_empresa','tarefas_operacionais',
      'apontamentos_tempo','documentos_operacionais','documento_localizacoes',
      'execucoes_ferramenta','aprovacoes_operacionais','notificacoes_operacionais',
      'eventos_operacionais','conversas_agente','mensagens_agente'
    )
    and not c.relrowsecurity;
  perform pg_temp.checar('RLS habilitada em todas as novas tabelas', sem_rls is null);
end $$;

do $$
declare
  vazados text[];
begin
  select array_agg(distinct table_name::text) into vazados
  from information_schema.role_table_grants
  where grantee = 'anon'
    and table_schema = 'public'
    and table_name in (
      'perfis_usuarios','competencias_operacionais','documentos_operacionais',
      'documento_localizacoes','eventos_operacionais','conversas_agente',
      'mensagens_agente','execucoes_ferramenta','tarefas_operacionais'
    );
  perform pg_temp.checar('anon NÃO tem privilégio nas novas tabelas', vazados is null);
end $$;

do $$
declare
  n int;
begin
  select count(*) into n
  from information_schema.role_table_grants
  where grantee = 'authenticated'
    and table_schema = 'public'
    and table_name = 'eventos_operacionais'
    and privilege_type = 'UPDATE';
  perform pg_temp.checar('authenticated NÃO pode dar UPDATE em eventos_operacionais', n = 0);
end $$;

-- Views SECURITY DEFINER ignorariam a RLS de quem consulta.
do $$
declare
  inseguras text[];
begin
  select array_agg(c.relname) into inseguras
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relkind = 'v'
    and c.relname like 'vw_%'
    and coalesce(
      (select option_value from pg_options_to_table(c.reloptions)
        where option_name = 'security_invoker'), 'false'
    ) <> 'true';
  perform pg_temp.checar('todas as views usam security_invoker', inseguras is null);
end $$;

do $$
declare
  n int;
begin
  select count(*) into n from pg_policies where schemaname = 'public'
    and tablename in (
      'perfis_usuarios','competencias_operacionais','modelos_rotina',
      'etapas_modelo_rotina','rotinas_empresa','tarefas_operacionais',
      'apontamentos_tempo','documentos_operacionais','documento_localizacoes',
      'execucoes_ferramenta','aprovacoes_operacionais','notificacoes_operacionais',
      'eventos_operacionais','conversas_agente','mensagens_agente'
    );
  perform pg_temp.checar('políticas de RLS foram criadas (>= 30)', n >= 30);
end $$;

do $$ begin raise notice E'\n--- 4. Regras de negócio no banco ---'; end $$;

-- Massa de teste mínima.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'teste@effective.local')
on conflict do nothing;

insert into public.perfis_usuarios (usuario_id, nome, papel)
values ('11111111-1111-1111-1111-111111111111', 'Usuário de Teste', 'analista')
on conflict (usuario_id) do nothing;

-- Segundo usuário, com papel de supervisor. Criado aqui (como superusuário) e
-- não dentro dos blocos de RLS, onde a troca de papel impede escrever em auth.
insert into auth.users (id, email)
values ('33333333-3333-3333-3333-333333333333', 'supervisor@teste.local')
on conflict do nothing;

insert into public.perfis_usuarios (usuario_id, nome, papel)
values ('33333333-3333-3333-3333-333333333333', 'Supervisor de Teste', 'supervisor')
on conflict (usuario_id) do nothing;

insert into public.empresas (id, codigo, razao_social, cnpj, matriz_filial, status_operacao, ativo)
values ('22222222-2222-2222-2222-222222222222', 'TESTE01', 'Empresa Teste LTDA',
        '00000000000191', 'matriz', 'implantacao', true)
on conflict (id) do nothing;

-- 4.1 Competência duplicada (mesma empresa/ano/mês) deve falhar.
do $$
declare erro boolean := false;
begin
  insert into public.competencias_operacionais (empresa_id, ano, mes)
  values ('22222222-2222-2222-2222-222222222222', 2026, 8);
  begin
    insert into public.competencias_operacionais (empresa_id, ano, mes)
    values ('22222222-2222-2222-2222-222222222222', 2026, 8);
  exception when unique_violation then erro := true;
  end;
  perform pg_temp.checar('competência duplicada (empresa/ano/mês) é bloqueada', erro);
end $$;

-- 4.2 Coluna gerada `referencia`.
do $$
declare r date;
begin
  select referencia into r from public.competencias_operacionais
   where empresa_id = '22222222-2222-2222-2222-222222222222' and ano = 2026 and mes = 8;
  perform pg_temp.checar('coluna gerada referencia = 2026-08-01', r = date '2026-08-01');
end $$;

-- 4.3 Documento com hash duplicado na MESMA empresa deve falhar.
do $$
declare erro boolean := false;
begin
  insert into public.documentos_operacionais
    (empresa_id, nome_original, hash_sha256)
  values ('22222222-2222-2222-2222-222222222222', 'relatorio.xlsx', repeat('a', 64));
  begin
    insert into public.documentos_operacionais
      (empresa_id, nome_original, hash_sha256)
    values ('22222222-2222-2222-2222-222222222222', 'copia-do-relatorio.xlsx', repeat('a', 64));
  exception when unique_violation then erro := true;
  end;
  perform pg_temp.checar('documento com mesmo hash na mesma empresa é bloqueado', erro);
end $$;

-- 4.4 Hash em formato inválido deve falhar.
do $$
declare erro boolean := false;
begin
  begin
    insert into public.documentos_operacionais (empresa_id, nome_original, hash_sha256)
    values ('22222222-2222-2222-2222-222222222222', 'x.txt', repeat('Z', 64));
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('hash fora do formato sha256 hex é rejeitado', erro);
end $$;

-- 4.5 Localização não pode ser 'armazenado' sem confirmação real (armazenado_em).
do $$
declare
  erro boolean := false;
  doc uuid;
begin
  select id into doc from public.documentos_operacionais
   where empresa_id = '22222222-2222-2222-2222-222222222222' limit 1;
  begin
    insert into public.documento_localizacoes (documento_id, provedor, status)
    values (doc, 'supabase_storage', 'armazenado');
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('status "armazenado" exige armazenado_em (sem fingir sucesso)', erro);
end $$;

-- 4.6 Um documento não pode ter duas localizações no mesmo provedor.
do $$
declare
  erro boolean := false;
  doc uuid;
begin
  select id into doc from public.documentos_operacionais
   where empresa_id = '22222222-2222-2222-2222-222222222222' limit 1;
  insert into public.documento_localizacoes (documento_id, provedor, status, armazenado_em)
  values (doc, 'supabase_storage', 'armazenado', now());
  begin
    insert into public.documento_localizacoes (documento_id, provedor, status)
    values (doc, 'supabase_storage', 'pendente');
  exception when unique_violation then erro := true;
  end;
  perform pg_temp.checar('documento tem no máximo uma localização por provedor', erro);
end $$;

-- 4.7 Apenas um cronômetro ativo por usuário.
do $$
declare erro boolean := false;
begin
  insert into public.apontamentos_tempo (usuario_id, status)
  values ('11111111-1111-1111-1111-111111111111', 'em_andamento');
  begin
    insert into public.apontamentos_tempo (usuario_id, status)
    values ('11111111-1111-1111-1111-111111111111', 'em_andamento');
  exception when unique_violation then erro := true;
  end;
  perform pg_temp.checar('segundo cronômetro ativo do mesmo usuário é bloqueado', erro);
end $$;

-- 4.8 Duração calculada automaticamente ao fechar a sessão.
do $$
declare d int;
begin
  update public.apontamentos_tempo
     set fim = inicio + interval '90 minutes', status = 'concluido'
   where usuario_id = '11111111-1111-1111-1111-111111111111'
     and status = 'em_andamento';
  select duracao_minutos into d from public.apontamentos_tempo
   where usuario_id = '11111111-1111-1111-1111-111111111111' limit 1;
  perform pg_temp.checar('duracao_minutos calculada = 90', d = 90);
end $$;

-- 4.9 Tarefa bloqueada exige motivo.
do $$
declare erro boolean := false;
begin
  begin
    insert into public.tarefas_operacionais (empresa_id, titulo, bloqueada)
    values ('22222222-2222-2222-2222-222222222222', 'Tarefa sem motivo', true);
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('tarefa bloqueada sem motivo é rejeitada', erro);
end $$;

-- 4.10 Idempotência de tarefa operacional.
do $$
declare erro boolean := false;
begin
  insert into public.tarefas_operacionais (empresa_id, titulo, chave_idempotencia)
  values ('22222222-2222-2222-2222-222222222222', 'Fechamento 2026-08', 'fech-2026-08-teste');
  begin
    insert into public.tarefas_operacionais (empresa_id, titulo, chave_idempotencia)
    values ('22222222-2222-2222-2222-222222222222', 'Fechamento 2026-08 (repetido)', 'fech-2026-08-teste');
  exception when unique_violation then erro := true;
  end;
  perform pg_temp.checar('chave de idempotência impede tarefa duplicada', erro);
end $$;

-- 4.11 Etapa do tipo aplicação exige código de ferramenta.
do $$
declare
  erro boolean := false;
  modelo uuid;
begin
  insert into public.modelos_rotina (codigo, nome)
  values ('TESTE_ROTINA', 'Rotina de Teste') returning id into modelo;
  begin
    insert into public.etapas_modelo_rotina (modelo_rotina_id, codigo, nome, ordem, tipo_etapa)
    values (modelo, 'E1', 'Etapa aplicação sem ferramenta', 1, 'aplicacao');
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('etapa "aplicacao" exige ferramenta_codigo', erro);
end $$;

do $$ begin raise notice E'\n--- 5. Histórico append-only ---'; end $$;

do $$
declare
  erro_update boolean := false;
  erro_delete boolean := false;
begin
  insert into public.eventos_operacionais (tipo_evento, descricao)
  values ('documento_recebido', 'Evento de teste');

  begin
    update public.eventos_operacionais set descricao = 'adulterado'
     where tipo_evento = 'documento_recebido';
  exception when others then erro_update := true;
  end;
  perform pg_temp.checar('UPDATE em eventos_operacionais é bloqueado', erro_update);

  begin
    delete from public.eventos_operacionais where tipo_evento = 'documento_recebido';
  exception when others then erro_delete := true;
  end;
  perform pg_temp.checar('DELETE em eventos_operacionais é bloqueado', erro_delete);
end $$;

do $$ begin raise notice E'\n--- 6. Conversas do agente ---'; end $$;

-- NOTA: now() é congelado dentro da transação, então comparar "antes vs depois"
-- no mesmo bloco não prova nada. Forçamos um valor antigo e verificamos que o
-- trigger o substituiu.
do $$
declare
  conv uuid;
  atividade_depois timestamptz;
begin
  insert into public.conversas_agente (usuario_id, titulo)
  values ('11111111-1111-1111-1111-111111111111', 'Conversa de teste')
  returning id into conv;

  update public.conversas_agente
     set ultima_atividade_em = timestamptz '2020-01-01 00:00:00+00'
   where id = conv;

  insert into public.mensagens_agente (conversa_id, papel, conteudo)
  values (conv, 'usuario', 'Salva esse relatório da TL');

  select ultima_atividade_em into atividade_depois
    from public.conversas_agente where id = conv;

  perform pg_temp.checar(
    'nova mensagem atualiza ultima_atividade_em da conversa',
    atividade_depois > timestamptz '2020-01-02 00:00:00+00'
  );
end $$;

-- A sequência garante ordem estável mesmo com created_at empatado.
do $$
declare
  conv uuid;
  ordenadas text[];
begin
  insert into public.conversas_agente (usuario_id, titulo)
  values ('11111111-1111-1111-1111-111111111111', 'Ordem das mensagens')
  returning id into conv;

  insert into public.mensagens_agente (conversa_id, papel, conteudo) values
    (conv, 'usuario', 'primeira'),
    (conv, 'agente',  'segunda'),
    (conv, 'usuario', 'terceira');

  select array_agg(conteudo order by sequencia) into ordenadas
    from public.mensagens_agente where conversa_id = conv;

  perform pg_temp.checar(
    'sequencia mantém a ordem das mensagens',
    ordenadas = array['primeira', 'segunda', 'terceira']
  );
end $$;

do $$
declare erro boolean := false;
begin
  begin
    insert into public.conversas_agente (usuario_id, titulo, status)
    values ('11111111-1111-1111-1111-111111111111', 'Sem data de arquivo', 'arquivada');
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('conversa arquivada exige arquivada_em', erro);
end $$;

do $$ begin raise notice E'\n--- 7. Limite de 10 conversas ativas ---'; end $$;

do $$
declare
  erro boolean := false;
  ativas int;
  primeira uuid;
begin
  -- Limpa o terreno para a contagem ser previsível.
  delete from public.conversas_agente
   where usuario_id = '11111111-1111-1111-1111-111111111111';

  for i in 1..10 loop
    insert into public.conversas_agente (usuario_id, titulo)
    values ('11111111-1111-1111-1111-111111111111', 'Conversa ' || i)
    returning id into primeira;
  end loop;

  select count(*) into ativas from public.conversas_agente
   where usuario_id = '11111111-1111-1111-1111-111111111111' and status = 'ativa';
  perform pg_temp.checar('10 conversas ativas foram criadas', ativas = 10);

  begin
    insert into public.conversas_agente (usuario_id, titulo)
    values ('11111111-1111-1111-1111-111111111111', 'Décima primeira');
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('a 11ª conversa é bloqueada pelo banco', erro);

  -- Nada foi apagado nem sobrescrito.
  select count(*) into ativas from public.conversas_agente
   where usuario_id = '11111111-1111-1111-1111-111111111111' and status = 'ativa';
  perform pg_temp.checar('nenhuma conversa foi removida silenciosamente', ativas = 10);
end $$;

-- Arquivar libera espaço; restaurar valida o limite de novo.
do $$
declare
  alvo uuid;
  ativas int;
  erro boolean := false;
begin
  select id into alvo from public.conversas_agente
   where usuario_id = '11111111-1111-1111-1111-111111111111' and status = 'ativa' limit 1;

  update public.conversas_agente
     set status = 'arquivada', arquivada_em = now()
   where id = alvo;

  select count(*) into ativas from public.conversas_agente
   where usuario_id = '11111111-1111-1111-1111-111111111111' and status = 'ativa';
  perform pg_temp.checar('arquivar reduz a contagem de ativas para 9', ativas = 9);

  -- Agora cabe mais uma.
  insert into public.conversas_agente (usuario_id, titulo)
  values ('11111111-1111-1111-1111-111111111111', 'Nova depois do arquivamento');
  perform pg_temp.checar('com espaço livre, nova conversa é criada', true);

  -- E restaurar a arquivada deve falhar (voltaria a 11).
  begin
    update public.conversas_agente set status = 'ativa', arquivada_em = null where id = alvo;
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('restaurar acima do limite é bloqueado', erro);

  -- A arquivada continua existindo.
  perform pg_temp.checar(
    'conversa arquivada foi preservada',
    exists (select 1 from public.conversas_agente where id = alvo)
  );
end $$;

do $$ begin raise notice E'\n--- 8. Memória do agente ---'; end $$;

do $$
declare n int;
begin
  select count(*) into n from pg_tables where schemaname = 'public'
    and tablename in ('memorias_agente','memoria_utilizacoes','feedback_agente','mensagem_documentos');
  perform pg_temp.checar('as 4 tabelas de memória foram criadas', n = 4);
end $$;

-- Segredo não vira memória.
do $$
declare erro boolean := false;
begin
  begin
    insert into public.memorias_agente (tipo_memoria, escopo, usuario_id, titulo, conteudo, criada_por)
    values ('preferencia', 'pessoal', '11111111-1111-1111-1111-111111111111',
            'Acesso ao portal', 'senha: hunter2', '11111111-1111-1111-1111-111111111111');
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('memória com "senha:" é bloqueada', erro);
end $$;

do $$
declare erro boolean := false;
begin
  begin
    insert into public.memorias_agente (tipo_memoria, escopo, usuario_id, titulo, conteudo, criada_por)
    values ('contexto', 'pessoal', '11111111-1111-1111-1111-111111111111',
            'Integração', 'usar api_key = sk-abcdefghijklmnop123456',
            '11111111-1111-1111-1111-111111111111');
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('memória com chave de API é bloqueada', erro);
end $$;

-- Coerência entre escopo e alvo.
do $$
declare erro boolean := false;
begin
  begin
    insert into public.memorias_agente (tipo_memoria, escopo, titulo, conteudo, criada_por)
    values ('regra', 'pessoal', 'Sem dono', 'conteúdo qualquer',
            '11111111-1111-1111-1111-111111111111');
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('memória pessoal sem usuario_id é rejeitada', erro);
end $$;

-- Memória não nasce ativa sem aprovador.
do $$
declare erro boolean := false;
begin
  begin
    insert into public.memorias_agente (tipo_memoria, escopo, empresa_id, titulo, conteudo, status, criada_por)
    values ('regra', 'empresa', '22222222-2222-2222-2222-222222222222',
            'Regra sem aprovação', 'conteúdo', 'ativa',
            '11111111-1111-1111-1111-111111111111');
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('memória ativa sem aprovador é rejeitada', erro);
end $$;

-- Só papel autorizado ativa memória de empresa.
do $$
declare
  mem uuid;
  erro boolean := false;
begin
  insert into public.memorias_agente (tipo_memoria, escopo, empresa_id, titulo, conteudo, criada_por)
  values ('regra', 'empresa', '22222222-2222-2222-2222-222222222222',
          'Fechamento até o dia 5', 'A DRE fecha até o quinto dia útil.',
          '11111111-1111-1111-1111-111111111111')
  returning id into mem;

  -- O usuário de teste é 'analista' — não pode aprovar memória de empresa.
  begin
    update public.memorias_agente
       set status = 'ativa',
           aprovada_por = '11111111-1111-1111-1111-111111111111',
           aprovada_em = now()
     where id = mem;
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('analista NÃO ativa memória de empresa', erro);

  -- Promovido a supervisor, consegue.
  update public.perfis_usuarios set papel = 'supervisor'
   where usuario_id = '11111111-1111-1111-1111-111111111111';

  update public.memorias_agente
     set status = 'ativa',
         aprovada_por = '11111111-1111-1111-1111-111111111111',
         aprovada_em = now()
   where id = mem;

  perform pg_temp.checar(
    'supervisor ativa memória de empresa',
    (select status from public.memorias_agente where id = mem) = 'ativa'
  );
end $$;

-- Revogação preserva o registro.
do $$
declare mem uuid;
begin
  select id into mem from public.memorias_agente where escopo = 'empresa' limit 1;
  update public.memorias_agente
     set status = 'revogada', revogada_por = '11111111-1111-1111-1111-111111111111',
         revogada_em = now(), motivo_revogacao = 'regra mudou'
   where id = mem;
  perform pg_temp.checar(
    'memória revogada continua existindo, só muda de status',
    exists (select 1 from public.memorias_agente where id = mem and status = 'revogada')
  );
end $$;

-- Feedback não vira memória sozinho.
do $$
declare fb uuid;
begin
  insert into public.feedback_agente (usuario_id, tipo_feedback, comentario)
  values ('11111111-1111-1111-1111-111111111111', 'correcao', 'A data estava errada.')
  returning id into fb;

  perform pg_temp.checar(
    'feedback nasce sem memória associada',
    (select gerou_memoria_id from public.feedback_agente where id = fb) is null
  );
end $$;

do $$ begin raise notice E'\n--- 9. Revogação do acesso anônimo (legado) ---'; end $$;

-- Depois da última migration, `anon` não pode ter privilégio em NENHUMA tabela
-- do schema public — nem nas 26 antigas, nem nas novas.
do $$
declare
  vazando text[];
begin
  select array_agg(distinct table_name::text) into vazando
  from information_schema.role_table_grants
  where grantee = 'anon' and table_schema = 'public';

  perform pg_temp.checar(
    'anon não tem privilégio em NENHUMA tabela do public',
    vazando is null
  );
end $$;

-- Teste COMPORTAMENTAL: assume o papel anon e tenta ler de verdade.
-- Vale mais que inspecionar tabela de privilégios — é o que um invasor faria.
do $$
declare
  bloqueou boolean := false;
begin
  set local role anon;
  begin
    perform 1 from public.empresas limit 1;
  exception when insufficient_privilege then bloqueou := true;
  end;
  reset role;
  perform pg_temp.checar('anon NÃO consegue ler public.empresas', bloqueou);
end $$;

do $$
declare
  bloqueou boolean := false;
begin
  set local role anon;
  begin
    perform 1 from public.contratos limit 1;
  exception when insufficient_privilege then bloqueou := true;
  end;
  reset role;
  perform pg_temp.checar('anon NÃO consegue ler public.contratos', bloqueou);
end $$;

do $$
declare
  bloqueou boolean := false;
begin
  set local role anon;
  begin
    perform 1 from public.conversas_agente limit 1;
  exception when insufficient_privilege then bloqueou := true;
  end;
  reset role;
  perform pg_temp.checar('anon NÃO consegue ler conversas do agente', bloqueou);
end $$;

-- E o padrão para tabelas futuras também precisa estar fechado.
do $$
declare
  n int;
begin
  select count(*) into n
  from pg_default_acl d
  where d.defaclnamespace = 'public'::regnamespace
    and array_to_string(d.defaclacl, ',') like '%anon=%';
  perform pg_temp.checar('default privileges não concedem nada a anon', n = 0);
end $$;

do $$ begin raise notice E'\n--- 10. RLS simulada: isolamento de memória pessoal ---'; end $$;

-- Simula dois usuários autenticados de verdade (assume o papel `authenticated`
-- e define o claim que auth.uid() lê). Sem isso os testes rodam como superusuário
-- e a RLS nem é avaliada — foi assim que um vazamento passou despercebido.
do $$
declare
  dono   constant uuid := '11111111-1111-1111-1111-111111111111';
  outro  constant uuid := '33333333-3333-3333-3333-333333333333';
  mem    uuid;
  viu    int;
begin
  -- O supervisor de teste já existe (criado com a massa de teste no início).
  -- O caso que vazava: memória pessoal nasce 'candidata', e a cláusula que
  -- deixava aprovadores verem a fila não excluía o escopo pessoal.
  insert into public.memorias_agente
    (tipo_memoria, escopo, usuario_id, titulo, conteudo, criada_por)
  values ('preferencia', 'pessoal', dono, 'Prefiro respostas curtas',
          'Responder de forma objetiva.', dono)
  returning id into mem;

  -- O dono enxerga a própria.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', dono::text, true);
  select count(*) into viu from public.memorias_agente where id = mem;
  reset role;
  perform pg_temp.checar('o dono vê a própria memória pessoal', viu = 1);

  -- O supervisor NÃO enxerga.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', outro::text, true);
  select count(*) into viu from public.memorias_agente where id = mem;
  reset role;
  perform pg_temp.checar(
    'supervisor NÃO vê memória pessoal de outro usuário',
    viu = 0
  );
end $$;

-- Conversa privada também não vaza por papel.
do $$
declare
  dono   constant uuid := '11111111-1111-1111-1111-111111111111';
  outro  constant uuid := '33333333-3333-3333-3333-333333333333';
  conv   uuid;
  viu    int;
begin
  -- O teste de limite deixou o usuário com 10 conversas ativas; libera espaço
  -- para esta, senão o trigger (corretamente) recusa a inserção.
  delete from public.conversas_agente where usuario_id = dono;

  insert into public.conversas_agente (usuario_id, titulo)
  values (dono, 'Conversa privada') returning id into conv;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', outro::text, true);
  select count(*) into viu from public.conversas_agente where id = conv;
  reset role;
  perform pg_temp.checar('supervisor NÃO vê conversa de outro usuário', viu = 0);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', outro::text, true);
  select count(*) into viu from public.mensagens_agente where conversa_id = conv;
  reset role;
  perform pg_temp.checar('supervisor NÃO vê mensagens de conversa alheia', viu = 0);
end $$;

do $$ begin raise notice E'\n--- 11. Arquivador de documentos ---'; end $$;

do $$
declare n int;
begin
  select count(*) into n from pg_tables where schemaname = 'public'
    and tablename in ('regras_arquivamento', 'pastas_drive', 'propostas_arquivamento');
  perform pg_temp.checar('as 3 tabelas do arquivador foram criadas', n = 3);
end $$;

-- Contagem exata por escopo: 6 internos + 3 fixos + 8 mensais + 12 de projeto.
do $$
declare
  internos int; fixos int; mensais int; projetos int;
begin
  select count(*) into internos  from public.regras_arquivamento where escopo = 'interno'  and ativo;
  select count(*) into fixos     from public.regras_arquivamento where escopo = 'fixo'     and ativo;
  select count(*) into mensais   from public.regras_arquivamento where escopo = 'mensal'   and ativo;
  select count(*) into projetos  from public.regras_arquivamento where escopo = 'projeto'  and ativo;

  perform pg_temp.checar('6 regras internas', internos = 6);
  perform pg_temp.checar('3 regras de documento fixo', fixos = 3);
  perform pg_temp.checar('8 categorias mensais', mensais = 8);
  perform pg_temp.checar('12 regras de projeto (4 projetos x 3 subcategorias)', projetos = 12);
end $$;

-- Os 4 projetos previstos estão cadastrados.
do $$
declare faltando text[];
begin
  select array_agg(p) into faltando
  from unnest(array['REPORTING_MENSAL','CONFERENCIA_DE_RECEBIMENTOS',
                    'CONFERENCIA_DE_CARTOES','REVISAO_DE_DRE']) p
  where not exists (select 1 from public.regras_arquivamento where projeto = p and ativo);
  perform pg_temp.checar('os 4 projetos previstos têm regra', faltando is null);
end $$;

-- Competência só no formato YYYY-MM: o modelo de caminho usa o placeholder.
do $$
declare n int;
begin
  select count(*) into n from public.regras_arquivamento
   where escopo in ('mensal','projeto')
     and not (caminho_modelo::text like '%{COMPETENCIA}%');
  perform pg_temp.checar('toda regra mensal/projeto usa {COMPETENCIA} no caminho', n = 0);
end $$;

-- Cada escopo previsto tem regra.
do $$
declare faltando text[];
begin
  select array_agg(e) into faltando
  from unnest(array['interno','fixo','mensal','projeto']) e
  where not exists (select 1 from public.regras_arquivamento where escopo = e and ativo);
  perform pg_temp.checar('há regra para os 4 escopos', faltando is null);
end $$;

-- Coerência: interno não exige empresa; mensal/projeto exigem competência.
do $$
declare erro boolean := false;
begin
  begin
    insert into public.regras_arquivamento
      (codigo, nome, escopo, caminho_modelo, padrao_nome, exige_empresa)
    values ('X_INTERNO_RUIM', 'Interno exigindo empresa', 'interno',
            '["00_INTERNO"]', '{TIPO_DOCUMENTO}.{EXTENSAO}', true);
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('regra interna NÃO pode exigir empresa', erro);
end $$;

do $$
declare erro boolean := false;
begin
  begin
    insert into public.regras_arquivamento
      (codigo, nome, escopo, caminho_modelo, padrao_nome, exige_competencia)
    values ('X_MENSAL_RUIM', 'Mensal sem competência', 'mensal',
            '["01_DOCUMENTOS_MENSAIS"]', '{TIPO_DOCUMENTO}.{EXTENSAO}', false);
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('regra mensal DEVE exigir competência', erro);
end $$;

-- Idempotência das pastas: a mesma chave lógica não pode ter duas pastas.
do $$
declare erro boolean := false;
begin
  insert into public.pastas_drive
    (escopo, chave_logica, external_id, nome, caminho_logico)
  values ('estrutural', 'estrutural:00_INTERNO', 'drive-id-1', '00_INTERNO', '/00_INTERNO');

  begin
    insert into public.pastas_drive
      (escopo, chave_logica, external_id, nome, caminho_logico)
    values ('estrutural', 'estrutural:00_INTERNO', 'drive-id-2', '00_INTERNO', '/00_INTERNO');
  exception when unique_violation then erro := true;
  end;
  perform pg_temp.checar('duas pastas para a mesma chave lógica é bloqueado', erro);
end $$;

do $$
declare erro boolean := false;
begin
  begin
    insert into public.pastas_drive
      (escopo, chave_logica, external_id, nome, caminho_logico)
    values ('estrutural', 'estrutural:OUTRA', 'drive-id-1', 'OUTRA', '/OUTRA');
  exception when unique_violation then erro := true;
  end;
  perform pg_temp.checar('o mesmo item do Drive não é mapeado duas vezes', erro);
end $$;

-- Pasta de empresa exige a empresa.
do $$
declare erro boolean := false;
begin
  begin
    insert into public.pastas_drive
      (escopo, chave_logica, external_id, nome, caminho_logico)
    values ('empresa', 'empresa:sem-dono', 'drive-id-3', 'X', '/X');
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('pasta de empresa exige empresa_id', erro);
end $$;

-- Versionamento: mesma empresa + mesmo caminho lógico + mesma versão é bloqueado.
do $$
declare erro boolean := false;
begin
  insert into public.documentos_operacionais
    (empresa_id, nome_original, hash_sha256, caminho_logico, versao)
  values ('22222222-2222-2222-2222-222222222222', 'relatorio.pdf',
          repeat('b', 64), '/EMPRESA/2026/2026-09/RELATORIO', 1);

  begin
    insert into public.documentos_operacionais
      (empresa_id, nome_original, hash_sha256, caminho_logico, versao)
    values ('22222222-2222-2222-2222-222222222222', 'outro.pdf',
            repeat('c', 64), '/EMPRESA/2026/2026-09/RELATORIO', 1);
  exception when unique_violation then erro := true;
  end;
  perform pg_temp.checar('duas versões v1 do mesmo caminho lógico é bloqueado', erro);

  -- v2 do mesmo caminho é permitido.
  insert into public.documentos_operacionais
    (empresa_id, nome_original, hash_sha256, caminho_logico, versao)
  values ('22222222-2222-2222-2222-222222222222', 'relatorio.pdf',
          repeat('d', 64), '/EMPRESA/2026/2026-09/RELATORIO', 2);
  perform pg_temp.checar('nova versão do mesmo caminho é permitida', true);
end $$;

-- Proposta confirmada exige quem confirmou.
do $$
declare erro boolean := false;
begin
  begin
    insert into public.propostas_arquivamento (usuario_id, status)
    values ('11111111-1111-1111-1111-111111111111', 'confirmada');
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('proposta confirmada exige confirmada_por e data', erro);
end $$;

-- pastas_drive é backend-only.
do $$
declare n int;
begin
  select count(*) into n
  from information_schema.role_table_grants
  where grantee = 'authenticated' and table_schema = 'public' and table_name = 'pastas_drive';
  perform pg_temp.checar('authenticated NÃO acessa pastas_drive (backend-only)', n = 0);
end $$;

-- Proposta é privada: nem supervisor lê a de outro.
do $$
declare
  dono   constant uuid := '11111111-1111-1111-1111-111111111111';
  outro  constant uuid := '33333333-3333-3333-3333-333333333333';
  prop   uuid;
  viu    int;
begin
  insert into public.propostas_arquivamento (usuario_id) values (dono) returning id into prop;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', outro::text, true);
  select count(*) into viu from public.propostas_arquivamento where id = prop;
  reset role;
  perform pg_temp.checar('supervisor NÃO vê proposta de arquivamento de outro', viu = 0);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', dono::text, true);
  select count(*) into viu from public.propostas_arquivamento where id = prop;
  reset role;
  perform pg_temp.checar('o dono vê a própria proposta', viu = 1);
end $$;

-- ---------------------------------------------------------------------------
-- Estrutura fixa do Drive
-- ---------------------------------------------------------------------------

do $$
declare n int;
begin
  select count(*) into n from public.estrutura_fixa_drive where ativo;
  perform pg_temp.checar('9 pastas fixas cadastradas', n = 9);

  select count(*) into n
  from public.estrutura_fixa_drive
  where chave in ('clientes_ativos', 'clientes_inativos');
  perform pg_temp.checar('os dois contêineres de cliente existem', n = 2);

  select count(*) into n
  from public.estrutura_fixa_drive
  where caminho_modelo->>0 = '00_INTERNO';
  perform pg_temp.checar('7 pastas sob 00_INTERNO (raiz + 6 subpastas)', n = 7);
end $$;

-- A estrutura fixa é criada ANTES de existir qualquer documento; se um
-- placeholder passasse, o bootstrap criaria uma pasta chamada "{ANO}".
do $$
declare erro boolean := false;
begin
  begin
    insert into public.estrutura_fixa_drive (chave, caminho_modelo)
    values ('teste_placeholder', '["01_CLIENTES_ATIVOS","{ANO}"]');
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('caminho com placeholder é bloqueado na estrutura fixa', erro);
end $$;

do $$
declare erro boolean := false;
begin
  begin
    insert into public.estrutura_fixa_drive (chave, caminho_modelo)
    values ('teste_vazio', '[]');
  exception when check_violation then erro := true;
  end;
  perform pg_temp.checar('caminho vazio é bloqueado na estrutura fixa', erro);
end $$;

do $$
declare erro boolean := false;
begin
  begin
    insert into public.estrutura_fixa_drive (chave, caminho_modelo)
    values ('clientes_ativos', '["99_OUTRA"]');
  exception when unique_violation then erro := true;
  end;
  perform pg_temp.checar('chave duplicada na estrutura fixa é bloqueada', erro);
end $$;

-- Toda regra interna precisa ter a pasta correspondente na estrutura fixa —
-- senão o bootstrap não a cria e o erro só aparece no primeiro arquivamento.
do $$
declare descobertas int;
begin
  select count(*) into descobertas
  from public.regras_arquivamento r
  where r.escopo = 'interno'
    and r.ativo
    and not exists (
      select 1 from public.estrutura_fixa_drive e
      where e.ativo and e.caminho_modelo = r.caminho_modelo
    );
  perform pg_temp.checar('toda regra interna tem pasta na estrutura fixa', descobertas = 0);
end $$;

do $$
declare n int;
begin
  select count(*) into n
  from information_schema.role_table_grants
  where grantee = 'anon' and table_schema = 'public' and table_name = 'estrutura_fixa_drive';
  perform pg_temp.checar('anon NÃO acessa estrutura_fixa_drive', n = 0);
end $$;

do $$ begin raise notice E'\n=== TODOS OS TESTES PASSARAM ==='; end $$;
