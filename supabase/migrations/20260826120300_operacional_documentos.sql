-- =============================================================================
-- Camada operacional — Documentos
--
-- documentos_operacionais : o documento LÓGICO (identidade, versão, hash)
-- documento_localizacoes  : ONDE cada documento está fisicamente armazenado
--
-- Um mesmo documento pode existir no Supabase Storage, no Google Drive, nos dois
-- ou em armazenamento local de teste. A separação em duas tabelas é proposital:
-- a identidade do documento não depende de onde ele foi parar.
--
-- REGRAS:
--   - O nome original NUNCA é perdido.
--   - O hash SHA-256 identifica duplicidade.
--   - Nada é marcado como armazenado antes da confirmação real do provedor.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. documentos_operacionais
-- -----------------------------------------------------------------------------

create table if not exists public.documentos_operacionais (
  id                  uuid primary key default gen_random_uuid(),
  empresa_id          uuid not null references public.empresas(id) on delete restrict,
  competencia_id      uuid references public.competencias_operacionais(id) on delete set null,
  tipo_documento      varchar(60) not null default 'nao_classificado',
  -- Preservação obrigatória: o nome como o usuário enviou.
  nome_original       text not null,
  -- Nome gerado pela regra de nomenclatura configurável.
  nome_padronizado    text,
  extensao            varchar(20),
  mime_type           varchar(150),
  tamanho_bytes       bigint,
  hash_sha256         char(64) not null,
  data_documento      date,
  versao              integer not null default 1,
  documento_anterior_id uuid references public.documentos_operacionais(id) on delete set null,
  status              varchar(30) not null default 'recebido',
  origem              varchar(30) not null default 'agente',
  metadados           jsonb not null default '{}'::jsonb,
  observacoes         text,
  ativo               boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid,
  updated_by          uuid,
  constraint documentos_op_status_check
    check (status in ('recebido', 'classificado', 'armazenado', 'armazenado_parcial',
                      'erro', 'duplicado', 'arquivado')),
  constraint documentos_op_origem_check
    check (origem in ('agente', 'upload_manual', 'aplicacao', 'integracao', 'importacao')),
  constraint documentos_op_versao_check   check (versao >= 1),
  constraint documentos_op_tamanho_check  check (tamanho_bytes is null or tamanho_bytes >= 0),
  -- Hash SHA-256 em hexadecimal minúsculo, 64 caracteres.
  constraint documentos_op_hash_check     check (hash_sha256 ~ '^[0-9a-f]{64}$')
);

comment on table public.documentos_operacionais is
  'Documento lógico. O nome original nunca é sobrescrito; o hash identifica duplicidade.';
comment on column public.documentos_operacionais.hash_sha256 is
  'SHA-256 do conteúdo, hex minúsculo. Base da detecção de duplicidade.';
comment on column public.documentos_operacionais.nome_padronizado is
  'Nome gerado pela regra de nomenclatura configurável (ver lib/documentos/nomenclatura.ts).';

-- DUPLICIDADE: o mesmo conteúdo (hash) não se repete para a mesma empresa.
-- Empresas diferentes podem legitimamente ter o mesmo arquivo.
create unique index if not exists documentos_op_empresa_hash_uk
  on public.documentos_operacionais (empresa_id, hash_sha256)
  where ativo;

create index if not exists documentos_op_empresa_idx      on public.documentos_operacionais (empresa_id) where ativo;
create index if not exists documentos_op_competencia_idx  on public.documentos_operacionais (competencia_id);
create index if not exists documentos_op_tipo_idx         on public.documentos_operacionais (tipo_documento);
create index if not exists documentos_op_status_idx       on public.documentos_operacionais (status);
create index if not exists documentos_op_hash_idx         on public.documentos_operacionais (hash_sha256);
-- Suporta a view "documentos por empresa e competência".
create index if not exists documentos_op_empresa_comp_tipo_idx
  on public.documentos_operacionais (empresa_id, competencia_id, tipo_documento) where ativo;

drop trigger if exists documentos_operacionais_set_updated_at on public.documentos_operacionais;
create trigger documentos_operacionais_set_updated_at
  before update on public.documentos_operacionais
  for each row execute function public.op_set_updated_at();


-- -----------------------------------------------------------------------------
-- 2. documento_localizacoes
-- -----------------------------------------------------------------------------

create table if not exists public.documento_localizacoes (
  id                    uuid primary key default gen_random_uuid(),
  documento_id          uuid not null references public.documentos_operacionais(id) on delete cascade,
  provedor              varchar(30) not null,
  integracao            varchar(60),
  -- Bucket (Supabase) ou pasta raiz (Drive).
  bucket_ou_pasta       text,
  caminho               text,
  -- ID do arquivo no provedor (ex.: fileId do Google Drive).
  identificador_externo text,
  nome_utilizado        text,
  status                varchar(20) not null default 'pendente',
  armazenado_em         timestamptz,
  erro_mensagem         text,
  metadados             jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid,
  updated_by            uuid,
  constraint documento_localizacoes_provedor_check
    check (provedor in ('supabase_storage', 'google_drive', 'local_teste')),
  constraint documento_localizacoes_status_check
    check (status in ('pendente', 'enviando', 'armazenado', 'erro', 'removido', 'nao_configurado')),
  -- INTEGRIDADE: só é 'armazenado' com data de confirmação real do provedor.
  constraint documento_localizacoes_confirmacao_check
    check (status <> 'armazenado' or armazenado_em is not null),
  -- Um erro precisa registrar a mensagem.
  constraint documento_localizacoes_erro_check
    check (status <> 'erro' or erro_mensagem is not null),
  -- Um documento tem no máximo uma localização por provedor.
  constraint documento_localizacoes_documento_provedor_uk unique (documento_id, provedor)
);

comment on table public.documento_localizacoes is
  'Onde cada documento está armazenado. Status "armazenado" exige confirmação real do provedor (armazenado_em).';
comment on column public.documento_localizacoes.identificador_externo is
  'ID do arquivo no provedor (ex.: fileId do Google Drive). Usado para localizar/baixar depois.';

create index if not exists documento_localizacoes_documento_idx on public.documento_localizacoes (documento_id);
create index if not exists documento_localizacoes_provedor_idx  on public.documento_localizacoes (provedor, status);

drop trigger if exists documento_localizacoes_set_updated_at on public.documento_localizacoes;
create trigger documento_localizacoes_set_updated_at
  before update on public.documento_localizacoes
  for each row execute function public.op_set_updated_at();
