-- =============================================================================
-- Preço por unidade nas regras de precificação
--
-- O banco calculava o preço de um serviço de três jeitos: valor fixo mensal,
-- tempo fixo mensal e tempo por unidade (minutos × custo da equipe). A Effective
-- cobra parte dos serviços por quantidade em reais: um valor por pagamento, por
-- banco, por nota fiscal.
--
-- Converter esses valores em minutos exigiria o custo da equipe, que ainda não
-- está definido, e mudaria o preço praticado. Este método guarda o preço como
-- ele é cobrado. Quando o custo da equipe existir, o tempo pode ser usado para
-- conferir se o preço cobre o custo, sem substituir o preço.
--
-- As constraints originais destas tabelas são anteriores às migrations do
-- repositório. Por isso esta migration lê a definição atual no banco e só
-- ACRESCENTA o novo método, preservando os que já existem.
--
-- Escopo: só regras_precificacao_servicos. precificacao_itens tem cálculo
-- próprio de totais, e o novo método entra lá quando esse cálculo for revisto.
-- =============================================================================

alter table public.regras_precificacao_servicos
  add column if not exists valor_por_unidade numeric(14,4);

comment on column public.regras_precificacao_servicos.valor_por_unidade is
  'Preço em reais por unidade (pagamento, banco, nota…) quando metodo_calculo = valor_por_unidade. A unidade fica em unidade_medida.';

-- 1. Lista de métodos: acrescenta valor_por_unidade aos valores já aceitos.
do $$
declare
  definicao text;
  metodos   text[];
begin
  select pg_get_constraintdef(oid) into definicao
    from pg_constraint
   where conrelid = 'public.regras_precificacao_servicos'::regclass
     and conname  = 'regras_precificacao_metodo_check';

  if definicao is null then
    raise exception 'Constraint regras_precificacao_metodo_check não encontrada: confira o banco antes de seguir.';
  end if;

  if position('valor_por_unidade' in definicao) = 0 then
    select array_agg(distinct m[1]) into metodos
      from regexp_matches(definicao, '''([a-z_]+)''', 'g') as m;

    alter table public.regras_precificacao_servicos drop constraint regras_precificacao_metodo_check;
    execute format(
      'alter table public.regras_precificacao_servicos add constraint regras_precificacao_metodo_check check (metodo_calculo in (%s))',
      (select string_agg(quote_literal(v), ', ' order by v) from unnest(metodos || array['valor_por_unidade']) as v)
    );
  end if;
end $$;

-- 2. O que o novo método exige: valor e unidade.
alter table public.regras_precificacao_servicos
  drop constraint if exists regras_precificacao_valor_unidade_check;
alter table public.regras_precificacao_servicos
  add constraint regras_precificacao_valor_unidade_check check (
    (valor_por_unidade is null or valor_por_unidade >= 0)
    and (metodo_calculo <> 'valor_por_unidade' or (valor_por_unidade is not null and unidade_medida is not null))
  );

-- 3. A regra antiga de valores (regras_precificacao_valores_check) pode ter sido
--    escrita listando os métodos. Testa se uma regra válida do novo método passa
--    nela; se não passar, libera o novo método nessa constraint — quem valida o
--    novo método é a constraint do passo 2.
do $$
declare
  definicao text;
  expressao text;
  passa     boolean;
begin
  select pg_get_constraintdef(oid) into definicao
    from pg_constraint
   where conrelid = 'public.regras_precificacao_servicos'::regclass
     and conname  = 'regras_precificacao_valores_check';

  if definicao is null then
    return;
  end if;

  expressao := substring(definicao from '^CHECK \((.*)\)$');

  execute format(
    'select (%s) from jsonb_populate_record(null::public.regras_precificacao_servicos, %L::jsonb) as t',
    expressao,
    '{"metodo_calculo": "valor_por_unidade", "valor_por_unidade": 1, "unidade_medida": "unidade", "multiplicador_complexidade": 1, "ativo": true}'
  ) into passa;

  if passa is false then
    alter table public.regras_precificacao_servicos drop constraint regras_precificacao_valores_check;
    execute format(
      'alter table public.regras_precificacao_servicos add constraint regras_precificacao_valores_check check ((%s) or metodo_calculo = %L)',
      expressao, 'valor_por_unidade'
    );
  end if;
end $$;

notify pgrst, 'reload schema';
