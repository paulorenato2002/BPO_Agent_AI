-- =============================================================================
-- Arquivador de documentos — estrutura de dados
--
-- REUTILIZAÇÃO (verificado no schema real antes de criar qualquer coisa):
--   documentos_operacionais  -> já tem empresa, competência, tipo, nomes, hash,
--                               versão, encadeamento de versões e status.
--                               ALTERADA para receber a classificação.
--   documento_localizacoes   -> já modela "onde o arquivo está" por provedor,
--                               com identificador externo e confirmação real.
--                               Serve para o Drive sem mudança de forma.
--   mensagem_documentos      -> já liga mensagem <-> documento.
--   execucoes_ferramenta     -> já registra chamadas com idempotência.
--   eventos_operacionais     -> histórico append-only.
--
-- NOVAS (não havia equivalente):
--   regras_arquivamento      -> catálogo de regras; o resolvedor trabalha por
--                               CÓDIGO, sem caminho hardcoded.
--   pastas_drive             -> mapeamento chave lógica <-> pasta no provedor.
--   propostas_arquivamento   -> proposta analisada aguardando confirmação.
--
-- Nenhum objeto é criado em auth/storage/realtime.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. regras_arquivamento
-- -----------------------------------------------------------------------------

create table if not exists public.regras_arquivamento (
  id                   uuid primary key default gen_random_uuid(),
  codigo               varchar(60) not null unique,
  nome                 text not null,
  escopo               varchar(20) not null,
  -- Segmentos do caminho, do topo da empresa até a pasta final. Placeholders
  -- {ANO}, {COMPETENCIA}, {PROJETO} são resolvidos em runtime.
  -- É configuração variável — por isso jsonb, não colunas.
  caminho_modelo       jsonb not null,
  -- Modelo do nome do arquivo, com placeholders.
  padrao_nome          text not null,
  exige_empresa        boolean not null default true,
  exige_competencia    boolean not null default false,
  exige_instituicao    boolean not null default false,
  projeto              varchar(60),
  subcategoria         varchar(60),
  descricao            text,
  ativo                boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  created_by           uuid,
  updated_by           uuid,
  constraint regras_arquivamento_escopo_check
    check (escopo in ('interno', 'fixo', 'mensal', 'projeto')),
  -- Documento interno não pertence a cliente.
  constraint regras_arquivamento_interno_check
    check (escopo <> 'interno' or exige_empresa = false),
  -- Mensal e projeto sempre têm competência.
  constraint regras_arquivamento_competencia_check
    check (escopo not in ('mensal', 'projeto') or exige_competencia = true)
);

comment on table public.regras_arquivamento is
  'Catálogo de regras de arquivamento. O resolvedor usa o CÓDIGO — nenhum caminho é hardcoded no código.';
comment on column public.regras_arquivamento.caminho_modelo is
  'Segmentos do caminho com placeholders ({ANO}, {COMPETENCIA}, {PROJETO}).';

create index if not exists regras_arquivamento_escopo_idx
  on public.regras_arquivamento (escopo) where ativo;

drop trigger if exists regras_arquivamento_set_updated_at on public.regras_arquivamento;
create trigger regras_arquivamento_set_updated_at
  before update on public.regras_arquivamento
  for each row execute function public.op_set_updated_at();


-- -----------------------------------------------------------------------------
-- 2. pastas_drive — mapeamento chave lógica <-> pasta no provedor
-- -----------------------------------------------------------------------------

create table if not exists public.pastas_drive (
  id                  uuid primary key default gen_random_uuid(),
  provedor            varchar(30) not null default 'google_drive',
  escopo              varchar(20) not null,
  empresa_id          uuid references public.empresas(id) on delete restrict,
  -- Identidade estável da pasta. Ex.:
  --   'estrutural:00_INTERNO'
  --   'empresa:<uuid>:01_DOCUMENTOS_MENSAIS:2026:2026-09:05_NOTAS_FISCAIS'
  chave_logica        text not null,
  pasta_pai_id        uuid references public.pastas_drive(id) on delete restrict,
  external_id         text not null,
  parent_external_id  text,
  nome                text not null,
  caminho_logico      text not null,
  status              varchar(20) not null default 'ativa',
  verificada_em       timestamptz,
  erro_mensagem       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid,
  updated_by          uuid,
  constraint pastas_drive_provedor_check
    check (provedor in ('google_drive')),
  constraint pastas_drive_escopo_check
    check (escopo in ('raiz', 'estrutural', 'empresa', 'periodo', 'categoria', 'projeto')),
  constraint pastas_drive_status_check
    check (status in ('ativa', 'inacessivel', 'lixeira', 'substituida')),
  -- Impede DUAS pastas para a mesma chave: é o que garante idempotência sob
  -- concorrência, junto com o advisory lock do resolvedor.
  constraint pastas_drive_chave_uk unique (provedor, chave_logica),
  -- O mesmo item do Drive não pode ser mapeado duas vezes.
  constraint pastas_drive_external_uk unique (provedor, external_id),
  -- Pasta de empresa precisa dizer de qual empresa é.
  constraint pastas_drive_empresa_check
    check (escopo not in ('empresa') or empresa_id is not null)
);

comment on table public.pastas_drive is
  'Mapeia chave lógica -> pasta no provedor. O external_id é a fonte de verdade; o nome é só visual.';
comment on column public.pastas_drive.chave_logica is
  'Identidade estável da pasta. Renomear a empresa não quebra o vínculo.';

create index if not exists pastas_drive_empresa_idx
  on public.pastas_drive (empresa_id) where empresa_id is not null;
create index if not exists pastas_drive_pai_idx on public.pastas_drive (pasta_pai_id);
create index if not exists pastas_drive_escopo_idx on public.pastas_drive (escopo, status);

drop trigger if exists pastas_drive_set_updated_at on public.pastas_drive;
create trigger pastas_drive_set_updated_at
  before update on public.pastas_drive
  for each row execute function public.op_set_updated_at();


-- -----------------------------------------------------------------------------
-- 3. propostas_arquivamento
--
-- A análise NÃO arquiva. Ela gera uma proposta que só vira arquivamento com
-- confirmação explícita do MESMO usuário, e só enquanto os arquivos não mudarem.
-- -----------------------------------------------------------------------------

create table if not exists public.propostas_arquivamento (
  id                      uuid primary key default gen_random_uuid(),
  usuario_id              uuid not null references auth.users(id) on delete cascade,
  conversa_id             uuid references public.conversas_agente(id) on delete set null,
  mensagem_id             uuid references public.mensagens_agente(id) on delete set null,
  status                  varchar(20) not null default 'aguardando',
  -- Um item por arquivo: hash, classificação sugerida e confirmada, evidências.
  itens                   jsonb not null default '[]'::jsonb,
  -- Hashes no momento da análise. Se mudarem, a proposta é inválida.
  hashes                  jsonb not null default '[]'::jsonb,
  confirmada_por          uuid references auth.users(id) on delete set null,
  confirmada_em           timestamptz,
  expira_em               timestamptz not null default (now() + interval '2 hours'),
  chave_idempotencia      text,
  erro_mensagem           text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint propostas_arquivamento_status_check
    check (status in ('aguardando', 'confirmada', 'arquivada', 'parcial',
                      'erro', 'expirada', 'cancelada', 'invalidada')),
  -- Confirmada exige quem confirmou e quando.
  constraint propostas_arquivamento_confirmacao_check
    check (status = 'aguardando'
           or status in ('expirada', 'cancelada', 'invalidada')
           or (confirmada_por is not null and confirmada_em is not null))
);

comment on table public.propostas_arquivamento is
  'Proposta de arquivamento aguardando confirmação explícita. Expira e é invalidada se o arquivo mudar.';

create unique index if not exists propostas_arquivamento_idempotencia_uk
  on public.propostas_arquivamento (chave_idempotencia)
  where chave_idempotencia is not null;

create index if not exists propostas_arquivamento_usuario_idx
  on public.propostas_arquivamento (usuario_id, created_at desc);
create index if not exists propostas_arquivamento_status_idx
  on public.propostas_arquivamento (status, expira_em);

drop trigger if exists propostas_arquivamento_set_updated_at on public.propostas_arquivamento;
create trigger propostas_arquivamento_set_updated_at
  before update on public.propostas_arquivamento
  for each row execute function public.op_set_updated_at();


-- -----------------------------------------------------------------------------
-- 4. documentos_operacionais — colunas de classificação
--
-- ALTER em vez de tabela nova: a tabela já modela o documento lógico. O que
-- faltava era a classificação do arquivador.
-- -----------------------------------------------------------------------------

alter table public.documentos_operacionais
  add column if not exists instituicao             varchar(60),
  add column if not exists projeto                 varchar(60),
  add column if not exists subcategoria            varchar(60),
  add column if not exists regra_arquivamento_id   uuid references public.regras_arquivamento(id) on delete set null,
  add column if not exists nome_final              text,
  add column if not exists caminho_logico          text,
  -- Por que o agente classificou assim. Payload variável -> jsonb.
  add column if not exists evidencias              jsonb not null default '[]'::jsonb,
  add column if not exists classificacao_sugerida  jsonb not null default '{}'::jsonb,
  add column if not exists classificacao_confirmada jsonb not null default '{}'::jsonb,
  add column if not exists confirmado_por          uuid references auth.users(id) on delete set null,
  add column if not exists confirmado_em           timestamptz,
  add column if not exists proposta_id             uuid references public.propostas_arquivamento(id) on delete set null;

comment on column public.documentos_operacionais.evidencias is
  'Por que o agente classificou assim (ex.: "CNPJ encontrado no conteúdo").';
comment on column public.documentos_operacionais.nome_final is
  'Nome efetivamente usado no destino. nome_original nunca é sobrescrito.';

create index if not exists documentos_op_regra_idx
  on public.documentos_operacionais (regra_arquivamento_id) where regra_arquivamento_id is not null;
create index if not exists documentos_op_projeto_idx
  on public.documentos_operacionais (projeto) where projeto is not null;

-- Versionamento: dois documentos não podem disputar a mesma versão do mesmo
-- nome lógico dentro da empresa.
create unique index if not exists documentos_op_versao_uk
  on public.documentos_operacionais (empresa_id, caminho_logico, versao)
  where ativo and caminho_logico is not null;


-- -----------------------------------------------------------------------------
-- 5. RLS
-- -----------------------------------------------------------------------------

alter table public.regras_arquivamento     enable row level security;
alter table public.pastas_drive            enable row level security;
alter table public.propostas_arquivamento  enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['regras_arquivamento', 'pastas_drive', 'propostas_arquivamento'] loop
    execute format('revoke all on public.%I from anon;', t);
    execute format('revoke all on public.%I from authenticated;', t);
  end loop;

  -- Regras: leitura para usuário interno ativo (o chat mostra as opções).
  execute 'grant select on public.regras_arquivamento to authenticated;';
  -- Proposta: o usuário precisa ver e confirmar a própria.
  execute 'grant select, update on public.propostas_arquivamento to authenticated;';
  -- pastas_drive é BACKEND-ONLY: nenhum grant a authenticated.
end;
$$;

drop policy if exists regras_arquivamento_select on public.regras_arquivamento;
create policy regras_arquivamento_select on public.regras_arquivamento
  for select to authenticated
  using (public.op_usuario_interno_ativo() and ativo);

-- Proposta é privada de quem a criou — nem papel superior lê a de outro.
drop policy if exists propostas_arquivamento_select on public.propostas_arquivamento;
create policy propostas_arquivamento_select on public.propostas_arquivamento
  for select to authenticated
  using (usuario_id = auth.uid() and public.op_usuario_interno_ativo());

drop policy if exists propostas_arquivamento_update on public.propostas_arquivamento;
create policy propostas_arquivamento_update on public.propostas_arquivamento
  for update to authenticated
  using (usuario_id = auth.uid() and public.op_usuario_interno_ativo())
  with check (usuario_id = auth.uid() and public.op_usuario_interno_ativo());

-- pastas_drive não recebe política: sem grant, `authenticated` não acessa.
-- O backend usa service_role, que ignora RLS por definição.


-- -----------------------------------------------------------------------------
-- 6. Regras iniciais
--
-- Apenas os códigos definidos no escopo. Nenhum cliente é citado.
-- -----------------------------------------------------------------------------

insert into public.regras_arquivamento
  (codigo, nome, escopo, caminho_modelo, padrao_nome,
   exige_empresa, exige_competencia, exige_instituicao, projeto, subcategoria)
values
  -- Internos: não pertencem a cliente.
  ('INTERNO_COMERCIAL_PRECIFICACAO', 'Comercial e precificação', 'interno',
   '["00_INTERNO","01_COMERCIAL_E_PRECIFICACAO"]',
   '{TIPO_DOCUMENTO}_{DATA_DOCUMENTO}_v{VERSAO}.{EXTENSAO}', false, false, false, null, null),
  ('INTERNO_MODELO_CONTRATO', 'Modelos de contrato', 'interno',
   '["00_INTERNO","02_MODELOS_DE_CONTRATOS"]',
   '{TIPO_DOCUMENTO}_{DATA_DOCUMENTO}_v{VERSAO}.{EXTENSAO}', false, false, false, null, null),
  ('INTERNO_ONBOARDING_KICKOFF', 'Onboarding e kickoff', 'interno',
   '["00_INTERNO","03_ONBOARDING_E_KICKOFF"]',
   '{TIPO_DOCUMENTO}_{DATA_DOCUMENTO}_v{VERSAO}.{EXTENSAO}', false, false, false, null, null),
  ('INTERNO_MODELO_RELATORIO', 'Modelos de relatório', 'interno',
   '["00_INTERNO","04_MODELOS_DE_RELATORIOS"]',
   '{TIPO_DOCUMENTO}_{DATA_DOCUMENTO}_v{VERSAO}.{EXTENSAO}', false, false, false, null, null),
  ('INTERNO_PROCESSO_TREINAMENTO', 'Processos e treinamentos', 'interno',
   '["00_INTERNO","05_PROCESSOS_E_TREINAMENTOS"]',
   '{TIPO_DOCUMENTO}_{DATA_DOCUMENTO}_v{VERSAO}.{EXTENSAO}', false, false, false, null, null),
  ('INTERNO_GESTAO_ANALISE', 'Gestão e análises internas', 'interno',
   '["00_INTERNO","06_GESTAO_E_ANALISES_INTERNAS"]',
   '{TIPO_DOCUMENTO}_{DATA_DOCUMENTO}_v{VERSAO}.{EXTENSAO}', false, false, false, null, null),

  -- Fixos do cliente: exigem empresa, não exigem competência.
  ('FIXO_CONTRATO_PROPOSTA', 'Contrato e proposta', 'fixo',
   '["00_DOCUMENTOS_FIXOS","01_CONTRATO_E_PROPOSTA"]',
   '{CODIGO}_{EMPRESA}_{TIPO_DOCUMENTO}_{DATA_DOCUMENTO}_v{VERSAO}.{EXTENSAO}',
   true, false, false, null, null),
  ('FIXO_ONBOARDING', 'Onboarding do cliente', 'fixo',
   '["00_DOCUMENTOS_FIXOS","02_ONBOARDING"]',
   '{CODIGO}_{EMPRESA}_{TIPO_DOCUMENTO}_{DATA_DOCUMENTO}_v{VERSAO}.{EXTENSAO}',
   true, false, false, null, null),
  ('FIXO_CADASTRO_AUTORIZACAO', 'Cadastros e autorizações', 'fixo',
   '["00_DOCUMENTOS_FIXOS","03_CADASTROS_E_AUTORIZACOES"]',
   '{CODIGO}_{EMPRESA}_{TIPO_DOCUMENTO}_{DATA_DOCUMENTO}_v{VERSAO}.{EXTENSAO}',
   true, false, false, null, null),

  -- Mensais: {ANO}/{COMPETENCIA} resolvidos em runtime.
  ('MENSAL_CONTAS_PAGAR', 'Contas a pagar', 'mensal',
   '["01_DOCUMENTOS_MENSAIS","{ANO}","{COMPETENCIA}","01_CONTAS_A_PAGAR"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, null, null),
  ('MENSAL_CONTAS_RECEBER', 'Contas a receber', 'mensal',
   '["01_DOCUMENTOS_MENSAIS","{ANO}","{COMPETENCIA}","02_CONTAS_A_RECEBER"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, null, null),
  ('MENSAL_EXTRATOS_INVESTIMENTOS', 'Extratos e investimentos', 'mensal',
   '["01_DOCUMENTOS_MENSAIS","{ANO}","{COMPETENCIA}","03_EXTRATOS_E_INVESTIMENTOS"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}',
   true, true, true, null, null),
  ('MENSAL_CARTOES_ADQUIRENTES', 'Cartões e adquirentes', 'mensal',
   '["01_DOCUMENTOS_MENSAIS","{ANO}","{COMPETENCIA}","04_CARTOES_E_ADQUIRENTES"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}',
   true, true, true, null, null),
  ('MENSAL_NOTAS_FISCAIS', 'Notas fiscais', 'mensal',
   '["01_DOCUMENTOS_MENSAIS","{ANO}","{COMPETENCIA}","05_NOTAS_FISCAIS"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, null, null),
  ('MENSAL_FOLHA_TRIBUTOS', 'Folha e tributos', 'mensal',
   '["01_DOCUMENTOS_MENSAIS","{ANO}","{COMPETENCIA}","06_FOLHA_E_TRIBUTOS"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, null, null),
  ('MENSAL_BASES_IMPORTACAO', 'Bases de importação', 'mensal',
   '["01_DOCUMENTOS_MENSAIS","{ANO}","{COMPETENCIA}","07_BASES_DE_IMPORTACAO"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, null, null),
  ('MENSAL_ENVIO_CONTABILIDADE', 'Envio para contabilidade', 'mensal',
   '["01_DOCUMENTOS_MENSAIS","{ANO}","{COMPETENCIA}","08_ENVIO_CONTABILIDADE"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, null, null),

  -- Projetos com insumo / base / relatório final.
  ('PROJETO_REPORTING_INSUMOS', 'Reporting mensal — insumos', 'projeto',
   '["02_RELATORIOS_E_PROJETOS","REPORTING_MENSAL","{ANO}","{COMPETENCIA}","01_INSUMOS"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{PROJETO}_{TIPO_DOCUMENTO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, 'REPORTING_MENSAL', '01_INSUMOS'),
  ('PROJETO_REPORTING_BASE', 'Reporting mensal — base de trabalho', 'projeto',
   '["02_RELATORIOS_E_PROJETOS","REPORTING_MENSAL","{ANO}","{COMPETENCIA}","02_BASE_DE_TRABALHO"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{PROJETO}_{TIPO_DOCUMENTO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, 'REPORTING_MENSAL', '02_BASE_DE_TRABALHO'),
  ('PROJETO_REPORTING_FINAL', 'Reporting mensal — relatório final', 'projeto',
   '["02_RELATORIOS_E_PROJETOS","REPORTING_MENSAL","{ANO}","{COMPETENCIA}","03_RELATORIO_FINAL"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{PROJETO}_{TIPO_DOCUMENTO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, 'REPORTING_MENSAL', '03_RELATORIO_FINAL'),

  ('PROJETO_RECEBIMENTOS_INSUMOS', 'Conferência de recebimentos — insumos', 'projeto',
   '["02_RELATORIOS_E_PROJETOS","CONFERENCIA_DE_RECEBIMENTOS","{ANO}","{COMPETENCIA}","01_INSUMOS"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{PROJETO}_{TIPO_DOCUMENTO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, 'CONFERENCIA_DE_RECEBIMENTOS', '01_INSUMOS'),
  ('PROJETO_RECEBIMENTOS_BASE', 'Conferência de recebimentos — base', 'projeto',
   '["02_RELATORIOS_E_PROJETOS","CONFERENCIA_DE_RECEBIMENTOS","{ANO}","{COMPETENCIA}","02_BASE_DE_TRABALHO"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{PROJETO}_{TIPO_DOCUMENTO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, 'CONFERENCIA_DE_RECEBIMENTOS', '02_BASE_DE_TRABALHO'),
  ('PROJETO_RECEBIMENTOS_FINAL', 'Conferência de recebimentos — final', 'projeto',
   '["02_RELATORIOS_E_PROJETOS","CONFERENCIA_DE_RECEBIMENTOS","{ANO}","{COMPETENCIA}","03_RELATORIO_FINAL"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{PROJETO}_{TIPO_DOCUMENTO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, 'CONFERENCIA_DE_RECEBIMENTOS', '03_RELATORIO_FINAL'),

  ('PROJETO_CARTOES_INSUMOS', 'Conferência de cartões — insumos', 'projeto',
   '["02_RELATORIOS_E_PROJETOS","CONFERENCIA_DE_CARTOES","{ANO}","{COMPETENCIA}","01_INSUMOS"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{PROJETO}_{TIPO_DOCUMENTO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, 'CONFERENCIA_DE_CARTOES', '01_INSUMOS'),
  ('PROJETO_CARTOES_BASE', 'Conferência de cartões — base', 'projeto',
   '["02_RELATORIOS_E_PROJETOS","CONFERENCIA_DE_CARTOES","{ANO}","{COMPETENCIA}","02_BASE_DE_TRABALHO"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{PROJETO}_{TIPO_DOCUMENTO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, 'CONFERENCIA_DE_CARTOES', '02_BASE_DE_TRABALHO'),
  ('PROJETO_CARTOES_FINAL', 'Conferência de cartões — final', 'projeto',
   '["02_RELATORIOS_E_PROJETOS","CONFERENCIA_DE_CARTOES","{ANO}","{COMPETENCIA}","03_RELATORIO_FINAL"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{PROJETO}_{TIPO_DOCUMENTO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, 'CONFERENCIA_DE_CARTOES', '03_RELATORIO_FINAL'),

  -- Revisão de DRE tem subcategorias próprias.
  ('PROJETO_DRE_RECIBOS', 'Revisão de DRE — recibos mensais', 'projeto',
   '["02_RELATORIOS_E_PROJETOS","REVISAO_DE_DRE","{ANO}","{COMPETENCIA}","01_RECIBOS_MENSAIS"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{PROJETO}_{TIPO_DOCUMENTO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, 'REVISAO_DE_DRE', '01_RECIBOS_MENSAIS'),
  ('PROJETO_DRE_RELATORIO', 'Revisão de DRE — relatório mensal', 'projeto',
   '["02_RELATORIOS_E_PROJETOS","REVISAO_DE_DRE","{ANO}","{COMPETENCIA}","02_RELATORIO_MENSAL"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{PROJETO}_{TIPO_DOCUMENTO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, 'REVISAO_DE_DRE', '02_RELATORIO_MENSAL'),
  ('PROJETO_DRE_DRE', 'Revisão de DRE — DRE', 'projeto',
   '["02_RELATORIOS_E_PROJETOS","REVISAO_DE_DRE","{ANO}","{COMPETENCIA}","03_DRE"]',
   '{CODIGO}_{EMPRESA}_{COMPETENCIA}_{PROJETO}_{TIPO_DOCUMENTO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, 'REVISAO_DE_DRE', '03_DRE')
on conflict (codigo) do nothing;
