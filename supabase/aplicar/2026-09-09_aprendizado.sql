-- =============================================================================
-- PENDENTE DE 2026-09-09 (segunda leva) — colar no SQL Editor do Supabase
--
-- Aprendizado de documentos: parar de perguntar de quem é e o que é todo mês.
--
-- Cria DUAS TABELAS NOVAS e uma função. Não altera nada existente, não apaga
-- dado e não mexe em regra de arquivamento. É seguro reaplicar.
--
-- Depois de colar, o sistema passa a gravar o que você confirmar:
--   * a conta bancária do documento -> a empresa (resolve o conflito em que
--     dois códigos de cliente aparecem no meio dos lançamentos de um extrato);
--   * o layout do arquivo -> o tipo de documento.
--
-- Nada é aprendido sozinho: só entra o que uma pessoa aprovou.
-- =============================================================================

-- =============================================================================
-- Aprendizado: parar de perguntar a mesma coisa todo mês
--
-- O PROBLEMA
-- ----------
-- Todo mês chegam os mesmos documentos: o extrato do Sicoob da mesma conta, o
-- export de vendas da Cielo com as mesmas colunas. E todo mês o sistema
-- pergunta de novo de quem é e o que é — porque cada análise começa do zero.
--
-- Pior: para o extrato bancário ele frequentemente NÃO consegue responder. A
-- empresa é procurada casando o código do cliente com o texto do documento, e
-- num extrato os números "147" e "210" — códigos de dois clientes — aparecem
-- como valores no meio dos lançamentos. Resultado observado em teste real: o
-- documento é recusado por ambiguidade entre dois clientes.
--
-- DUAS TABELAS, PORQUE SÃO DUAS PERGUNTAS
-- ---------------------------------------
-- "De quem é" e "o que é" envelhecem de formas diferentes:
--
--   empresa_contas      A conta 1.136.082-8 é do TL Academia. É fato de
--                       cadastro, específico do cliente, e não muda.
--
--   padroes_documento   O export de vendas da Cielo tem as mesmas colunas para
--                       TODOS os clientes. O layout diz o que o documento é,
--                       não de quem.
--
-- Numa tabela só, o tipo do documento teria de ser reaprendido para cada
-- cliente novo, e se perderia quando o cliente trocasse de conta.
--
-- ISTO NÃO É UM MODELO TREINADO
-- -----------------------------
-- É memória de decisão humana: o que uma pessoa confirmou fica gravado com o
-- que serviu de chave. Vale desde a primeira confirmação, dá para auditar linha
-- a linha e não deriva sozinho. Para este problema é melhor que um classificador
-- estatístico — e é honesto sobre o que faz.
--
-- APRENDIZADO ERRADO É PIOR QUE NENHUM
-- ------------------------------------
-- Uma vez gravado, um padrão passa a decidir sozinho. Por isso as duas tabelas
-- só aceitam o que veio de uma CONFIRMAÇÃO HUMANA de arquivamento, e a
-- gravação recusa em silêncio quando há qualquer disputa — ver
-- `registrar_aprendizado`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Conta bancária -> empresa. Responde DE QUEM É.
-- -----------------------------------------------------------------------------
create table if not exists public.empresa_contas (
  -- Só dígitos. "1.136.082-8" e "1136082-8" são a mesma conta escrita por telas
  -- diferentes do mesmo banco; normalizar é o que faz o PDF e o OFX casarem.
  conta         text primary key,
  empresa_id    uuid not null references public.empresas(id) on delete cascade,
  -- Informativos: ajudam a auditar, não entram na chave. A agência aparece como
  -- "5004-0" num relatório e "5004" em outro, conforme a tela que gerou.
  instituicao   text,
  agencia       text,
  origem        text not null default 'confirmacao'
                check (origem in ('confirmacao', 'cadastro')),
  confirmacoes  integer not null default 1,
  created_at    timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  created_by    uuid references auth.users(id)
);

comment on table public.empresa_contas is
  'Conta bancária de cada cliente. Aprendida de arquivamentos confirmados ou '
  'cadastrada à mão. Identifica o titular de um extrato sem depender de achar '
  'o código do cliente no meio dos lançamentos.';

create index if not exists empresa_contas_empresa_idx on public.empresa_contas(empresa_id);

alter table public.empresa_contas enable row level security;
revoke all on public.empresa_contas from anon, authenticated;
grant all on public.empresa_contas to service_role;

-- -----------------------------------------------------------------------------
-- Layout -> tipo de documento. Responde O QUE É.
--
-- Sem empresa_id de propósito: o layout é do emissor, não do cliente.
-- -----------------------------------------------------------------------------
create table if not exists public.padroes_documento (
  assinatura     text primary key,
  tipo_documento text not null,
  instituicao    text,
  regra_codigo   text,
  confirmacoes   integer not null default 1,
  created_at     timestamptz not null default now(),
  atualizado_em  timestamptz not null default now(),
  created_by     uuid references auth.users(id)
);

comment on table public.padroes_documento is
  'Layout de documento (conjunto de colunas, ou esqueleto do cabeçalho) que já '
  'foi classificado por uma pessoa. Dispensa o modelo no mês seguinte.';

alter table public.padroes_documento enable row level security;
revoke all on public.padroes_documento from anon, authenticated;
grant all on public.padroes_documento to service_role;

-- -----------------------------------------------------------------------------
-- registrar_aprendizado
--
-- Chamada DEPOIS de o arquivamento ser confirmado, e de propósito fora daquela
-- transação: aprender é melhor-esforço. Uma falha aqui não pode impedir um
-- arquivamento que o usuário já autorizou.
--
-- Recebe uma lista de {conta, agencia, instituicao, layout, empresa_id,
-- tipo_documento, regra_codigo}. Ignora o que vier incompleto.
-- -----------------------------------------------------------------------------
create or replace function public.registrar_aprendizado(p_itens jsonb, p_usuario uuid)
returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  item          jsonb;
  v_conta       text;
  v_layout      text;
  v_empresa     uuid;
  v_dono        uuid;
  contas_novas  int := 0;
  layouts_novos int := 0;
  recusados     int := 0;
begin
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' then
    raise exception 'Esperava uma lista de itens.';
  end if;

  for item in select * from jsonb_array_elements(p_itens) loop
    v_conta   := nullif(trim(item->>'conta'), '');
    v_layout  := nullif(trim(item->>'layout'), '');
    v_empresa := nullif(item->>'empresa_id', '')::uuid;

    -- ---- conta -> empresa -------------------------------------------------
    if v_conta is not null and v_empresa is not null then
      select empresa_id into v_dono from public.empresa_contas where conta = v_conta;

      if v_dono is null then
        insert into public.empresa_contas(conta, empresa_id, instituicao, agencia, created_by)
        values (v_conta, v_empresa, nullif(item->>'instituicao', ''),
                nullif(item->>'agencia', ''), p_usuario);
        contas_novas := contas_novas + 1;

      elsif v_dono = v_empresa then
        update public.empresa_contas
           set confirmacoes = confirmacoes + 1, atualizado_em = now()
         where conta = v_conta;

      else
        -- A conta já pertence a OUTRA empresa. Pode ser erro de cadastro, pode
        -- ser conta transferida. Sobrescrever mandaria os extratos do titular
        -- antigo para a pasta do novo, em silêncio. Não mexe: a pessoa continua
        -- confirmando à mão até alguém resolver.
        recusados := recusados + 1;
      end if;
    end if;

    -- ---- layout -> tipo de documento --------------------------------------
    if v_layout is not null and nullif(item->>'tipo_documento', '') is not null then
      insert into public.padroes_documento(
        assinatura, tipo_documento, instituicao, regra_codigo, created_by)
      values (v_layout, item->>'tipo_documento', nullif(item->>'instituicao', ''),
              nullif(item->>'regra_codigo', ''), p_usuario)
      on conflict (assinatura) do update
        set confirmacoes  = public.padroes_documento.confirmacoes + 1,
            atualizado_em = now(),
            -- O tipo mais recente confirmado vence: se o emissor mudou o
            -- significado do relatório, a última pessoa que olhou está certa.
            tipo_documento = excluded.tipo_documento,
            instituicao    = coalesce(excluded.instituicao, public.padroes_documento.instituicao);
      layouts_novos := layouts_novos + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'contas_registradas', contas_novas,
    'layouts_registrados', layouts_novos,
    'contas_em_disputa', recusados
  );
end;
$$;

revoke all on function public.registrar_aprendizado(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.registrar_aprendizado(jsonb, uuid) to service_role;

grant select on public.empresa_contas, public.padroes_documento to service_role;
