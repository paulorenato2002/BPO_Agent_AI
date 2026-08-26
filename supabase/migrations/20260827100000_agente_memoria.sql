-- =============================================================================
-- Memória controlada do agente
--
-- memorias_agente      : regras, contextos, preferências e decisões persistidas
-- memoria_utilizacoes  : quando uma memória influenciou uma resposta
-- feedback_agente      : correções e avaliações do usuário
-- mensagem_documentos  : liga mensagens a documentos JÁ registrados
--
-- PRINCÍPIO: o agente NÃO aprende sozinho. Toda memória nasce `candidata` e só
-- vira `ativa` por confirmação do usuário (pessoal) ou aprovação de quem tem
-- papel para isso (empresa/organizacional). Isso é garantido por trigger, não
-- só pela aplicação.
--
-- NÃO usa embeddings nem pgvector: a seleção é relacional (escopo, empresa,
-- usuário, tipo, prioridade, vigência) + busca textual em português.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. memorias_agente
-- -----------------------------------------------------------------------------

create table if not exists public.memorias_agente (
  id                    uuid primary key default gen_random_uuid(),
  tipo_memoria          varchar(30) not null,
  escopo                varchar(20) not null,
  -- Preenchido conforme o escopo (ver constraint de coerência abaixo).
  usuario_id            uuid references auth.users(id) on delete cascade,
  empresa_id            uuid references public.empresas(id) on delete cascade,
  rotina_codigo         varchar(50),
  ferramenta_codigo     varchar(80),
  titulo                text not null,
  conteudo              text not null,
  prioridade            smallint not null default 50,
  status                varchar(25) not null default 'candidata',
  versao                integer not null default 1,
  memoria_anterior_id   uuid references public.memorias_agente(id) on delete set null,
  conversa_origem_id    uuid references public.conversas_agente(id) on delete set null,
  mensagem_origem_id    uuid references public.mensagens_agente(id) on delete set null,
  criada_por            uuid references auth.users(id) on delete set null,
  aprovada_por          uuid references auth.users(id) on delete set null,
  aprovada_em           timestamptz,
  revogada_por          uuid references auth.users(id) on delete set null,
  revogada_em           timestamptz,
  motivo_revogacao      text,
  vigencia_inicio       date,
  vigencia_fim          date,
  metadados             jsonb not null default '{}'::jsonb,
  ativo                 boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by            uuid,
  updated_by            uuid,

  constraint memorias_agente_tipo_check
    check (tipo_memoria in ('regra', 'contexto', 'preferencia', 'decisao',
                            'correcao', 'procedimento', 'observacao')),
  constraint memorias_agente_escopo_check
    check (escopo in ('pessoal', 'empresa', 'organizacional', 'rotina', 'ferramenta')),
  constraint memorias_agente_status_check
    check (status in ('candidata', 'aguardando_aprovacao', 'ativa', 'rejeitada',
                      'revogada', 'substituida', 'expirada')),
  constraint memorias_agente_prioridade_check
    check (prioridade between 0 and 100),
  constraint memorias_agente_versao_check check (versao >= 1),
  constraint memorias_agente_vigencia_check
    check (vigencia_fim is null or vigencia_inicio is null or vigencia_fim >= vigencia_inicio),

  -- Coerência entre escopo e a coluna que o identifica.
  constraint memorias_agente_escopo_alvo_check check (
    (escopo = 'pessoal'        and usuario_id is not null and empresa_id is null)
    or (escopo = 'empresa'     and empresa_id is not null)
    or (escopo = 'organizacional' and empresa_id is null)
    or (escopo = 'rotina'      and rotina_codigo is not null)
    or (escopo = 'ferramenta'  and ferramenta_codigo is not null)
  ),
  -- Memória ativa precisa dizer quem aprovou e quando.
  constraint memorias_agente_aprovacao_check
    check (status <> 'ativa' or (aprovada_por is not null and aprovada_em is not null)),
  -- Revogação preserva o registro, mas exige rastro.
  constraint memorias_agente_revogacao_check
    check (status <> 'revogada' or (revogada_por is not null and revogada_em is not null))
);

comment on table public.memorias_agente is
  'Memória operacional do agente. Nasce candidata; só vira ativa por confirmação/aprovação humana.';
comment on column public.memorias_agente.prioridade is
  '0-100. Usado no desempate; regra organizacional pesa mais que preferência pessoal na aplicação.';
comment on column public.memorias_agente.memoria_anterior_id is
  'Versionamento: aponta para a memória que esta substitui.';

create index if not exists memorias_agente_escopo_idx
  on public.memorias_agente (escopo, status) where ativo;
create index if not exists memorias_agente_usuario_idx
  on public.memorias_agente (usuario_id, status) where ativo and usuario_id is not null;
create index if not exists memorias_agente_empresa_idx
  on public.memorias_agente (empresa_id, status) where ativo and empresa_id is not null;
create index if not exists memorias_agente_tipo_idx
  on public.memorias_agente (tipo_memoria, prioridade desc) where ativo;
create index if not exists memorias_agente_vigencia_idx
  on public.memorias_agente (vigencia_fim) where ativo and vigencia_fim is not null;
-- Busca textual em português para localizar memórias relevantes sem embeddings.
create index if not exists memorias_agente_busca_idx
  on public.memorias_agente
  using gin (to_tsvector('portuguese', titulo || ' ' || conteudo));

drop trigger if exists memorias_agente_set_updated_at on public.memorias_agente;
create trigger memorias_agente_set_updated_at
  before update on public.memorias_agente
  for each row execute function public.op_set_updated_at();


-- -----------------------------------------------------------------------------
-- 2. Bloqueio de segredos
--
-- Nenhuma senha, token ou chave pode virar memória. A checagem fica no banco
-- porque é a última linha de defesa: mesmo um bug na aplicação não grava.
-- -----------------------------------------------------------------------------

create or replace function public.op_bloquear_segredo_em_memoria()
returns trigger
language plpgsql
as $$
declare
  alvo text := lower(coalesce(new.titulo, '') || ' ' || coalesce(new.conteudo, ''));
begin
  if alvo ~ '(senha|password|passwd)\s*[:=]'
     or alvo ~ '(token|bearer|api[_ -]?key|secret|chave[_ -]?api)\s*[:=]'
     or alvo ~ 'sk-[a-z0-9_-]{16,}'                    -- chave estilo OpenAI
     or alvo ~ 'eyj[a-z0-9_-]{20,}\.'                  -- JWT
     or alvo ~ '\m[0-9]{13,16}\M'                      -- número de cartão
     or alvo ~ '-----begin [a-z ]*private key-----'
  then
    raise exception 'Conteúdo bloqueado: parece conter credencial ou segredo.'
      using errcode = 'check_violation',
            hint = 'Memória não pode guardar senha, token, chave de API ou dado de cartão.';
  end if;
  return new;
end;
$$;

comment on function public.op_bloquear_segredo_em_memoria() is
  'Impede que credenciais/segredos sejam gravados como memória do agente.';

drop trigger if exists memorias_agente_bloqueia_segredo on public.memorias_agente;
create trigger memorias_agente_bloqueia_segredo
  before insert or update of titulo, conteudo on public.memorias_agente
  for each row execute function public.op_bloquear_segredo_em_memoria();


-- -----------------------------------------------------------------------------
-- 3. memoria_utilizacoes
-- -----------------------------------------------------------------------------

create table if not exists public.memoria_utilizacoes (
  id                      bigint generated always as identity primary key,
  memoria_id              uuid not null references public.memorias_agente(id) on delete cascade,
  conversa_id             uuid references public.conversas_agente(id) on delete set null,
  mensagem_id             uuid references public.mensagens_agente(id) on delete set null,
  execucao_ferramenta_id  uuid references public.execucoes_ferramenta(id) on delete set null,
  usuario_id              uuid references auth.users(id) on delete set null,
  utilizada_em            timestamptz not null default now(),
  resultado               varchar(20) not null default 'aplicada',
  metadados               jsonb not null default '{}'::jsonb,
  constraint memoria_utilizacoes_resultado_check
    check (resultado in ('aplicada', 'ignorada', 'conflito', 'erro'))
);

comment on table public.memoria_utilizacoes is
  'Registra quando uma memória influenciou uma resposta ou execução.';

create index if not exists memoria_utilizacoes_memoria_idx
  on public.memoria_utilizacoes (memoria_id, utilizada_em desc);
create index if not exists memoria_utilizacoes_conversa_idx
  on public.memoria_utilizacoes (conversa_id) where conversa_id is not null;


-- -----------------------------------------------------------------------------
-- 4. feedback_agente
-- -----------------------------------------------------------------------------

create table if not exists public.feedback_agente (
  id                  uuid primary key default gen_random_uuid(),
  usuario_id          uuid not null references auth.users(id) on delete cascade,
  conversa_id         uuid references public.conversas_agente(id) on delete set null,
  mensagem_id         uuid references public.mensagens_agente(id) on delete set null,
  tipo_feedback       varchar(20) not null,
  comentario          text,
  correcao_proposta   text,
  -- Preenchido só se o usuário decidir transformar o feedback em memória.
  -- Feedback NÃO vira regra automaticamente.
  gerou_memoria_id    uuid references public.memorias_agente(id) on delete set null,
  metadados           jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  constraint feedback_agente_tipo_check
    check (tipo_feedback in ('positivo', 'negativo', 'correcao', 'sugestao'))
);

comment on table public.feedback_agente is
  'Correções e avaliações do usuário. Nunca vira regra ativa automaticamente.';

create index if not exists feedback_agente_usuario_idx
  on public.feedback_agente (usuario_id, created_at desc);
create index if not exists feedback_agente_conversa_idx
  on public.feedback_agente (conversa_id) where conversa_id is not null;


-- -----------------------------------------------------------------------------
-- 5. mensagem_documentos
--
-- Liga uma mensagem a um documento JÁ registrado. Não duplica o arquivo:
-- guarda apenas a relação.
-- -----------------------------------------------------------------------------

create table if not exists public.mensagem_documentos (
  id            bigint generated always as identity primary key,
  mensagem_id   uuid not null references public.mensagens_agente(id) on delete cascade,
  documento_id  uuid not null references public.documentos_operacionais(id) on delete cascade,
  papel_anexo   varchar(20) not null default 'entrada',
  created_at    timestamptz not null default now(),
  constraint mensagem_documentos_papel_check
    check (papel_anexo in ('entrada', 'saida', 'referencia')),
  constraint mensagem_documentos_uk unique (mensagem_id, documento_id)
);

comment on table public.mensagem_documentos is
  'Relação entre mensagem e documento existente. Não duplica o arquivo.';

create index if not exists mensagem_documentos_documento_idx
  on public.mensagem_documentos (documento_id);
