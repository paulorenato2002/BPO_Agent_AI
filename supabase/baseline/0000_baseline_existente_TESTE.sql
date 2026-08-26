-- =============================================================================
-- BASELINE DO SCHEMA EXISTENTE — SOMENTE PARA TESTE LOCAL
--
-- Gerado automaticamente por scripts/gerar-baseline-teste.mjs a partir do
-- endpoint OpenAPI do PostgREST em 2026-08-26T14:53:08.317Z.
--
-- ⚠️  NUNCA APLIQUE ESTE ARQUIVO EM PRODUÇÃO.
-- Ele reconstrói apenas colunas/tipos/PK/FK/NOT NULL/defaults, o suficiente para
-- validar as migrations da camada operacional num Postgres descartável.
-- Triggers, índices, CHECKs e RLS do banco real NÃO estão aqui.
--
-- Tabelas reconstruídas: 26
-- =============================================================================

create extension if not exists pgcrypto;

-- Stub mínimo do schema auth do Supabase (as migrations referenciam auth.users
-- e auth.uid()).
create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- Papéis usados pelas políticas de RLS.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;


create table if not exists public.grupos_comunicacao (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null,
  plataforma varchar(30) default 'whatsapp' not null,
  nome text not null,
  finalidade text,
  identificador_externo text,
  link_convite text,
  principal boolean default false not null,
  recebe_comunicados boolean default true not null,
  permite_envio_arquivos boolean default true not null,
  usado_para_aprovacoes boolean default false not null,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.precificacoes (
  id uuid primary key default gen_random_uuid(),
  modelo_precificacao_id uuid not null,
  empresa_id uuid,
  contrato_id uuid,
  codigo varchar(50) not null,
  nome text not null,
  descricao text,
  data_precificacao date default CURRENT_DATE not null,
  validade_ate date,
  status varchar(30) default 'rascunho' not null,
  margem_lucro_percentual numeric default 0 not null,
  aliquota_impostos_percentual numeric default 0 not null,
  desconto_percentual numeric default 0 not null,
  multiplicador_complexidade numeric default 1 not null,
  custo_operacional_total numeric default 0 not null,
  custo_sistemas_total numeric default 0 not null,
  custo_total numeric default 0 not null,
  valor_antes_desconto numeric default 0 not null,
  valor_desconto numeric default 0 not null,
  valor_final numeric default 0 not null,
  aprovado_por_cliente boolean default false not null,
  aprovado_em timestamp with time zone,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid,
  grupo_simulacao_id uuid default gen_random_uuid(),
  nome_cenario text,
  valor_minimo_aplicado numeric default 500 not null,
  orcamento_estimado_cliente numeric,
  faixa_preco_minima numeric,
  faixa_preco_maxima numeric,
  valor_tecnico_calculado numeric default 0 not null,
  valor_comercial_proposto numeric,
  margem_efetiva_percentual numeric,
  abaixo_do_piso boolean default false not null,
  justificativa_excecao text,
  estrategia_ajuste varchar(30),
  custo_outros_componentes_total numeric default 0 not null,
  acrescimos_total numeric default 0 not null,
  descontos_fixos_total numeric default 0 not null,
  valor_comercial_manual boolean default false not null
);

create table if not exists public.enderecos_empresa (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null,
  tipo_endereco varchar(30) default 'estabelecimento' not null,
  logradouro text not null,
  numero varchar(30),
  complemento text,
  bairro text,
  cidade text not null,
  uf char(2) not null,
  cep varchar(8),
  pais varchar(60) default 'Brasil' not null,
  principal boolean default false not null,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.alertas_onboarding (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null,
  tarefa_onboarding_id uuid,
  tipo_alerta varchar(40) not null,
  severidade varchar(20) default 'atencao' not null,
  status varchar(20) default 'aberto' not null,
  titulo text not null,
  mensagem text,
  data_referencia date,
  gerado_em timestamp with time zone default now() not null,
  responsavel_usuario_id uuid,
  responsavel_empresa_pessoa_id uuid,
  origem varchar(20) default 'sistema' not null,
  visualizado_em timestamp with time zone,
  resolvido_em timestamp with time zone,
  resolvido_por uuid,
  descricao_resolucao text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.fases_onboarding (
  id uuid primary key default gen_random_uuid(),
  modelo_onboarding_id uuid not null,
  codigo varchar(40) not null,
  nome text not null,
  descricao text,
  objetivo text,
  ordem integer not null,
  duracao_prevista_dias integer,
  obrigatoria boolean default true not null,
  bloqueia_proxima_fase boolean default true not null,
  criterio_conclusao text,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.contrato_servicos (
  id uuid primary key default gen_random_uuid(),
  contrato_id uuid not null,
  servico_id uuid not null,
  situacao_escopo varchar(30) default 'incluido' not null,
  descricao_escopo text,
  frequencia varchar(30),
  quantidade_inclusa numeric,
  unidade_medida varchar(50),
  tipo_cobranca varchar(30) default 'incluso_no_mensal' not null,
  valor_adicional numeric,
  valor_unitario numeric,
  prazo_entrega_dias_uteis integer,
  responsabilidade_execucao varchar(30) default 'bpo' not null,
  data_inicio date,
  data_fim date,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.modelos_onboarding (
  id uuid primary key default gen_random_uuid(),
  codigo varchar(40) not null,
  nome text not null,
  versao varchar(20) not null,
  tipo_onboarding varchar(20) not null,
  descricao text,
  objetivo text,
  duracao_prevista_dias integer,
  vigencia_inicio date,
  vigencia_fim date,
  status varchar(20) default 'rascunho' not null,
  modelo_padrao boolean default false not null,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.historico_onboarding (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null,
  tarefa_onboarding_id uuid,
  tipo_evento varchar(40) not null,
  origem_evento varchar(20) default 'sistema' not null,
  ator_usuario_id uuid,
  ator_empresa_pessoa_id uuid,
  titulo text not null,
  descricao text,
  status_anterior varchar(30),
  status_novo varchar(30),
  fase_anterior_id uuid,
  fase_nova_id uuid,
  dados_anteriores jsonb,
  dados_novos jsonb,
  metadados jsonb not null,
  created_at timestamp with time zone default now() not null,
  created_by uuid
);

create table if not exists public.servicos (
  id uuid primary key default gen_random_uuid(),
  codigo varchar(40) not null,
  nome text not null,
  categoria varchar(30) not null,
  descricao text,
  unidade_cobranca varchar(30) default 'incluso_no_pacote' not null,
  recorrente boolean default true not null,
  permite_personalizacao boolean default true not null,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.plano_servicos (
  id uuid primary key default gen_random_uuid(),
  plano_id uuid not null,
  servico_id uuid not null,
  incluido_padrao boolean default true not null,
  quantidade_inclusa numeric,
  frequencia_padrao varchar(30),
  descricao_escopo text,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.onboardings (
  id uuid primary key default gen_random_uuid(),
  modelo_onboarding_id uuid not null,
  fase_atual_id uuid,
  empresa_id uuid,
  pessoa_id uuid,
  contrato_id uuid,
  codigo varchar(50) not null,
  nome text not null,
  tipo_onboarding varchar(20) not null,
  status varchar(30) default 'nao_iniciado' not null,
  prioridade varchar(20) default 'normal' not null,
  data_inicio date,
  data_prevista_conclusao date,
  data_conclusao date,
  progresso_percentual numeric default 0 not null,
  responsavel_geral_id uuid,
  motivo_pausa text,
  motivo_cancelamento text,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.planos_referencia (
  id uuid primary key default gen_random_uuid(),
  codigo varchar(30) not null,
  nome text not null,
  descricao text,
  publico_alvo text,
  nivel integer not null,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.tarefas_modelo_onboarding (
  id uuid primary key default gen_random_uuid(),
  fase_onboarding_id uuid not null,
  codigo varchar(50) not null,
  nome text not null,
  descricao text,
  ordem integer not null,
  tipo_tarefa varchar(30) default 'operacional' not null,
  responsavel_padrao varchar(30) default 'bpo' not null,
  prazo_dias_apos_inicio_fase integer default 0 not null,
  duracao_estimada_minutos integer,
  instrucao_execucao text,
  criterio_conclusao text,
  obrigatoria boolean default true not null,
  exige_evidencia boolean default false not null,
  tipo_evidencia varchar(30),
  tarefa_dependencia_id uuid,
  permite_execucao_paralela boolean default true not null,
  pode_ser_automatizada boolean default false not null,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.empresa_pessoas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null,
  pessoa_id uuid not null,
  tipo_vinculo varchar(30) not null,
  cargo text,
  departamento text,
  funcao_principal text,
  descricao_responsabilidades text,
  nivel_hierarquico integer,
  superior_vinculo_id uuid,
  contato_principal boolean default false not null,
  ordem_contato integer,
  pode_aprovar boolean default false not null,
  limite_aprovacao numeric,
  data_inicio date,
  data_fim date,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.tarefas_onboarding (
  id uuid primary key default gen_random_uuid(),
  onboarding_id uuid not null,
  fase_onboarding_id uuid not null,
  tarefa_modelo_id uuid,
  tarefa_dependencia_id uuid,
  codigo varchar(50) not null,
  nome text not null,
  descricao text,
  ordem integer not null,
  tipo_tarefa varchar(30) default 'operacional' not null,
  status varchar(30) default 'pendente' not null,
  prioridade varchar(20) default 'normal' not null,
  tipo_responsavel varchar(30) default 'nao_definido' not null,
  responsavel_usuario_id uuid,
  responsavel_empresa_pessoa_id uuid,
  data_prevista date,
  iniciada_em timestamp with time zone,
  concluida_em timestamp with time zone,
  duracao_estimada_minutos integer,
  duracao_real_minutos integer,
  instrucao_execucao text,
  criterio_conclusao text,
  obrigatoria boolean default true not null,
  exige_evidencia boolean default false not null,
  tipo_evidencia varchar(30),
  evidencia_texto text,
  evidencia_url text,
  origem_tarefa varchar(20) default 'modelo' not null,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.pessoas (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  cpf varchar(11),
  data_nascimento date,
  email_principal text,
  telefone_principal varchar(20),
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.modelo_recursos_equipe (
  id uuid primary key default gen_random_uuid(),
  modelo_precificacao_id uuid not null,
  codigo varchar(40) not null,
  nome text not null,
  tipo_recurso varchar(30) not null,
  cargo_funcao text,
  quantidade_pessoas integer default 1 not null,
  custo_mensal_unitario numeric default 0 not null,
  encargos_beneficios_unitario numeric default 0 not null,
  outros_custos_unitario numeric default 0 not null,
  horas_produtivas_mes_por_pessoa numeric not null,
  custo_mensal_total_unitario numeric,
  custo_total_mensal numeric,
  horas_totais_mes numeric,
  custo_hora numeric,
  custo_minuto numeric,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.regras_precificacao_servicos (
  id uuid primary key default gen_random_uuid(),
  modelo_precificacao_id uuid not null,
  servico_id uuid not null,
  recurso_equipe_id uuid,
  codigo varchar(50) not null,
  nome_atividade text not null,
  descricao text,
  metodo_calculo varchar(30) not null,
  unidade_medida varchar(50),
  tempo_minutos_por_unidade numeric,
  tempo_fixo_mensal_minutos numeric,
  valor_fixo_mensal numeric,
  quantidade_padrao numeric,
  multiplicador_complexidade numeric default 1 not null,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.canais_comunicacao (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null,
  empresa_pessoa_id uuid,
  tipo_canal varchar(30) not null,
  nome_canal text,
  valor text not null,
  finalidade text,
  principal boolean default false not null,
  recebe_comunicados boolean default false not null,
  permite_envio_arquivos boolean default true not null,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.modelos_precificacao (
  id uuid primary key default gen_random_uuid(),
  codigo varchar(40) not null,
  nome text not null,
  versao varchar(20) not null,
  descricao text,
  margem_lucro_percentual numeric default 0 not null,
  aliquota_impostos_percentual numeric default 0 not null,
  desconto_maximo_percentual numeric default 0 not null,
  horas_produtivas_mes_padrao numeric,
  vigencia_inicio date,
  vigencia_fim date,
  status varchar(20) default 'rascunho' not null,
  modelo_padrao boolean default false not null,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid,
  valor_minimo_mensal_padrao numeric default 500 not null
);

create table if not exists public.precificacao_componentes (
  id uuid primary key default gen_random_uuid(),
  precificacao_id uuid not null,
  tipo_componente varchar(30) not null,
  natureza varchar(20) default 'custo' not null,
  descricao text not null,
  fornecedor text,
  quantidade numeric default 1 not null,
  valor_unitario numeric default 0 not null,
  meses_rateio integer default 1 not null,
  periodicidade varchar(20) default 'mensal' not null,
  valor_total numeric,
  valor_mensal_equivalente numeric,
  valor_impacto numeric,
  origem_item varchar(20) default 'manual' not null,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.contratos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null,
  plano_referencia_id uuid,
  numero_contrato varchar(50),
  descricao text,
  status varchar(30) default 'rascunho' not null,
  data_inicio date not null,
  data_fim date,
  renovacao_automatica boolean default false not null,
  valor_mensal numeric default 0 not null,
  moeda char(3) default 'BRL'::bpchar not null,
  dia_vencimento integer,
  forma_pagamento varchar(30),
  indice_reajuste varchar(30),
  data_proximo_reajuste date,
  horas_inclusas numeric,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.grupo_participantes (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null,
  empresa_pessoa_id uuid not null,
  papel_no_grupo text,
  assuntos_responsavel text,
  administrador_grupo boolean default false not null,
  recebe_marcacao boolean default true not null,
  ordem_acionamento integer,
  data_entrada date,
  data_saida date,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.precificacao_itens (
  id uuid primary key default gen_random_uuid(),
  precificacao_id uuid not null,
  regra_precificacao_id uuid,
  servico_id uuid not null,
  recurso_equipe_id uuid,
  descricao_item text not null,
  metodo_calculo varchar(30) not null,
  quantidade numeric default 1 not null,
  unidade_medida varchar(50),
  tempo_unitario_minutos numeric,
  custo_minuto numeric,
  valor_fixo numeric default 0 not null,
  multiplicador_complexidade numeric default 1 not null,
  tempo_total_minutos numeric,
  custo_operacional numeric,
  custo_total_item numeric,
  origem_item varchar(20) default 'regra' not null,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.evidencias_tarefa_onboarding (
  id uuid primary key default gen_random_uuid(),
  tarefa_onboarding_id uuid not null,
  tipo_evidencia varchar(30) not null,
  titulo text,
  descricao text,
  texto_evidencia text,
  url_evidencia text,
  nome_arquivo text,
  storage_bucket text,
  storage_path text,
  mime_type text,
  tamanho_bytes bigint,
  confirmado boolean default false not null,
  validada boolean default false not null,
  validada_em timestamp with time zone,
  validada_por uuid,
  origem varchar(20) default 'usuario' not null,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);

create table if not exists public.empresas (
  id uuid primary key default gen_random_uuid(),
  codigo varchar(30) not null,
  razao_social text not null,
  nome_fantasia text,
  cnpj varchar(14) not null,
  situacao_cadastral varchar(50),
  natureza_juridica text,
  porte varchar(50),
  matriz_filial varchar(20) default 'matriz' not null,
  data_abertura date,
  segmento text,
  atividade_principal text,
  regime_tributario varchar(50),
  cliente_desde date,
  status_operacao varchar(30) default 'implantacao' not null,
  observacoes text,
  ativo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  updated_by uuid
);


-- Chaves estrangeiras
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'grupos_comunicacao_empresa_id_fkey') then
    alter table public.grupos_comunicacao add constraint grupos_comunicacao_empresa_id_fkey foreign key (empresa_id) references public.empresas(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'precificacoes_modelo_precificacao_id_fkey') then
    alter table public.precificacoes add constraint precificacoes_modelo_precificacao_id_fkey foreign key (modelo_precificacao_id) references public.modelos_precificacao(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'precificacoes_empresa_id_fkey') then
    alter table public.precificacoes add constraint precificacoes_empresa_id_fkey foreign key (empresa_id) references public.empresas(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'precificacoes_contrato_id_fkey') then
    alter table public.precificacoes add constraint precificacoes_contrato_id_fkey foreign key (contrato_id) references public.contratos(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'enderecos_empresa_empresa_id_fkey') then
    alter table public.enderecos_empresa add constraint enderecos_empresa_empresa_id_fkey foreign key (empresa_id) references public.empresas(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'alertas_onboarding_onboarding_id_fkey') then
    alter table public.alertas_onboarding add constraint alertas_onboarding_onboarding_id_fkey foreign key (onboarding_id) references public.onboardings(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'alertas_onboarding_tarefa_onboarding_id_fkey') then
    alter table public.alertas_onboarding add constraint alertas_onboarding_tarefa_onboarding_id_fkey foreign key (tarefa_onboarding_id) references public.tarefas_onboarding(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'alertas_onboarding_responsavel_empresa_pessoa_id_fkey') then
    alter table public.alertas_onboarding add constraint alertas_onboarding_responsavel_empresa_pessoa_id_fkey foreign key (responsavel_empresa_pessoa_id) references public.empresa_pessoas(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'fases_onboarding_modelo_onboarding_id_fkey') then
    alter table public.fases_onboarding add constraint fases_onboarding_modelo_onboarding_id_fkey foreign key (modelo_onboarding_id) references public.modelos_onboarding(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'contrato_servicos_contrato_id_fkey') then
    alter table public.contrato_servicos add constraint contrato_servicos_contrato_id_fkey foreign key (contrato_id) references public.contratos(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'contrato_servicos_servico_id_fkey') then
    alter table public.contrato_servicos add constraint contrato_servicos_servico_id_fkey foreign key (servico_id) references public.servicos(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'historico_onboarding_onboarding_id_fkey') then
    alter table public.historico_onboarding add constraint historico_onboarding_onboarding_id_fkey foreign key (onboarding_id) references public.onboardings(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'historico_onboarding_tarefa_onboarding_id_fkey') then
    alter table public.historico_onboarding add constraint historico_onboarding_tarefa_onboarding_id_fkey foreign key (tarefa_onboarding_id) references public.tarefas_onboarding(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'historico_onboarding_ator_empresa_pessoa_id_fkey') then
    alter table public.historico_onboarding add constraint historico_onboarding_ator_empresa_pessoa_id_fkey foreign key (ator_empresa_pessoa_id) references public.empresa_pessoas(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'historico_onboarding_fase_anterior_id_fkey') then
    alter table public.historico_onboarding add constraint historico_onboarding_fase_anterior_id_fkey foreign key (fase_anterior_id) references public.fases_onboarding(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'historico_onboarding_fase_nova_id_fkey') then
    alter table public.historico_onboarding add constraint historico_onboarding_fase_nova_id_fkey foreign key (fase_nova_id) references public.fases_onboarding(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'plano_servicos_plano_id_fkey') then
    alter table public.plano_servicos add constraint plano_servicos_plano_id_fkey foreign key (plano_id) references public.planos_referencia(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'plano_servicos_servico_id_fkey') then
    alter table public.plano_servicos add constraint plano_servicos_servico_id_fkey foreign key (servico_id) references public.servicos(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'onboardings_modelo_onboarding_id_fkey') then
    alter table public.onboardings add constraint onboardings_modelo_onboarding_id_fkey foreign key (modelo_onboarding_id) references public.modelos_onboarding(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'onboardings_fase_atual_id_fkey') then
    alter table public.onboardings add constraint onboardings_fase_atual_id_fkey foreign key (fase_atual_id) references public.fases_onboarding(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'onboardings_empresa_id_fkey') then
    alter table public.onboardings add constraint onboardings_empresa_id_fkey foreign key (empresa_id) references public.empresas(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'onboardings_pessoa_id_fkey') then
    alter table public.onboardings add constraint onboardings_pessoa_id_fkey foreign key (pessoa_id) references public.pessoas(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'onboardings_contrato_id_fkey') then
    alter table public.onboardings add constraint onboardings_contrato_id_fkey foreign key (contrato_id) references public.contratos(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tarefas_modelo_onboarding_fase_onboarding_id_fkey') then
    alter table public.tarefas_modelo_onboarding add constraint tarefas_modelo_onboarding_fase_onboarding_id_fkey foreign key (fase_onboarding_id) references public.fases_onboarding(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tarefas_modelo_onboarding_tarefa_dependencia_id_fkey') then
    alter table public.tarefas_modelo_onboarding add constraint tarefas_modelo_onboarding_tarefa_dependencia_id_fkey foreign key (tarefa_dependencia_id) references public.tarefas_modelo_onboarding(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'empresa_pessoas_empresa_id_fkey') then
    alter table public.empresa_pessoas add constraint empresa_pessoas_empresa_id_fkey foreign key (empresa_id) references public.empresas(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'empresa_pessoas_pessoa_id_fkey') then
    alter table public.empresa_pessoas add constraint empresa_pessoas_pessoa_id_fkey foreign key (pessoa_id) references public.pessoas(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'empresa_pessoas_superior_vinculo_id_fkey') then
    alter table public.empresa_pessoas add constraint empresa_pessoas_superior_vinculo_id_fkey foreign key (superior_vinculo_id) references public.empresa_pessoas(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tarefas_onboarding_onboarding_id_fkey') then
    alter table public.tarefas_onboarding add constraint tarefas_onboarding_onboarding_id_fkey foreign key (onboarding_id) references public.onboardings(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tarefas_onboarding_fase_onboarding_id_fkey') then
    alter table public.tarefas_onboarding add constraint tarefas_onboarding_fase_onboarding_id_fkey foreign key (fase_onboarding_id) references public.fases_onboarding(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tarefas_onboarding_tarefa_modelo_id_fkey') then
    alter table public.tarefas_onboarding add constraint tarefas_onboarding_tarefa_modelo_id_fkey foreign key (tarefa_modelo_id) references public.tarefas_modelo_onboarding(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tarefas_onboarding_tarefa_dependencia_id_fkey') then
    alter table public.tarefas_onboarding add constraint tarefas_onboarding_tarefa_dependencia_id_fkey foreign key (tarefa_dependencia_id) references public.tarefas_onboarding(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tarefas_onboarding_responsavel_empresa_pessoa_id_fkey') then
    alter table public.tarefas_onboarding add constraint tarefas_onboarding_responsavel_empresa_pessoa_id_fkey foreign key (responsavel_empresa_pessoa_id) references public.empresa_pessoas(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'modelo_recursos_equipe_modelo_precificacao_id_fkey') then
    alter table public.modelo_recursos_equipe add constraint modelo_recursos_equipe_modelo_precificacao_id_fkey foreign key (modelo_precificacao_id) references public.modelos_precificacao(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'regras_precificacao_servicos_modelo_precificacao_id_fkey') then
    alter table public.regras_precificacao_servicos add constraint regras_precificacao_servicos_modelo_precificacao_id_fkey foreign key (modelo_precificacao_id) references public.modelos_precificacao(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'regras_precificacao_servicos_servico_id_fkey') then
    alter table public.regras_precificacao_servicos add constraint regras_precificacao_servicos_servico_id_fkey foreign key (servico_id) references public.servicos(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'regras_precificacao_servicos_recurso_equipe_id_fkey') then
    alter table public.regras_precificacao_servicos add constraint regras_precificacao_servicos_recurso_equipe_id_fkey foreign key (recurso_equipe_id) references public.modelo_recursos_equipe(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'canais_comunicacao_empresa_id_fkey') then
    alter table public.canais_comunicacao add constraint canais_comunicacao_empresa_id_fkey foreign key (empresa_id) references public.empresas(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'canais_comunicacao_empresa_pessoa_id_fkey') then
    alter table public.canais_comunicacao add constraint canais_comunicacao_empresa_pessoa_id_fkey foreign key (empresa_pessoa_id) references public.empresa_pessoas(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'precificacao_componentes_precificacao_id_fkey') then
    alter table public.precificacao_componentes add constraint precificacao_componentes_precificacao_id_fkey foreign key (precificacao_id) references public.precificacoes(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'contratos_empresa_id_fkey') then
    alter table public.contratos add constraint contratos_empresa_id_fkey foreign key (empresa_id) references public.empresas(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'contratos_plano_referencia_id_fkey') then
    alter table public.contratos add constraint contratos_plano_referencia_id_fkey foreign key (plano_referencia_id) references public.planos_referencia(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'grupo_participantes_grupo_id_fkey') then
    alter table public.grupo_participantes add constraint grupo_participantes_grupo_id_fkey foreign key (grupo_id) references public.grupos_comunicacao(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'grupo_participantes_empresa_pessoa_id_fkey') then
    alter table public.grupo_participantes add constraint grupo_participantes_empresa_pessoa_id_fkey foreign key (empresa_pessoa_id) references public.empresa_pessoas(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'precificacao_itens_precificacao_id_fkey') then
    alter table public.precificacao_itens add constraint precificacao_itens_precificacao_id_fkey foreign key (precificacao_id) references public.precificacoes(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'precificacao_itens_regra_precificacao_id_fkey') then
    alter table public.precificacao_itens add constraint precificacao_itens_regra_precificacao_id_fkey foreign key (regra_precificacao_id) references public.regras_precificacao_servicos(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'precificacao_itens_servico_id_fkey') then
    alter table public.precificacao_itens add constraint precificacao_itens_servico_id_fkey foreign key (servico_id) references public.servicos(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'precificacao_itens_recurso_equipe_id_fkey') then
    alter table public.precificacao_itens add constraint precificacao_itens_recurso_equipe_id_fkey foreign key (recurso_equipe_id) references public.modelo_recursos_equipe(id);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'evidencias_tarefa_onboarding_tarefa_onboarding_id_fkey') then
    alter table public.evidencias_tarefa_onboarding add constraint evidencias_tarefa_onboarding_tarefa_onboarding_id_fkey foreign key (tarefa_onboarding_id) references public.tarefas_onboarding(id);
  end if;
end $$;

grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;