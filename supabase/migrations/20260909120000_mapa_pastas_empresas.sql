-- =============================================================================
-- Mapa das pastas de cliente: do disco para o banco
--
-- O problema que isto resolve
-- ---------------------------
-- Para montar o destino de um documento, a análise precisa saber que o cliente
-- de código 210 mora na pasta "210-TL ACADEMIA". Até aqui esse nome era
-- descoberto com um readdir na pasta sincronizada do OneDrive
-- (lib/arquivador/pasta-cliente-local.ts).
--
-- Isso funciona no PC e NÃO funciona na Vercel: lá não existe pasta do
-- OneDrive. O readdir estoura, a análise marca `pastaEmpresa` como faltante e
-- todo item para com "pasta do cliente não encontrada". O sistema publicado
-- não erra o destino — ele simplesmente não arquiva nada.
--
-- A saída é inverter quem descobre. Quem tem o disco (o worker Python no PC)
-- varre e ENVIA o mapa; quem não tem (a Vercel) LÊ o mapa do banco. O nome da
-- pasta deixa de ser uma leitura de disco no meio da análise e passa a ser um
-- dado cadastrado, com data de conferência.
--
-- Por que o casamento acontece aqui, no SQL
-- -----------------------------------------
-- O Python manda a lista crua de nomes de pasta e nada mais. A regra de qual
-- pasta pertence a qual empresa fica em um lugar só — aqui. Se ela morasse no
-- Python, a Vercel leria um mapa montado por uma regra que ela não consegue
-- verificar, e as duas pontas divergiriam em silêncio.
--
-- A regra: a pasta começa com o código da empresa, e o que vem logo depois é
-- fim do nome, espaço ou traço. Assim "210" casa com "210-TL ACADEMIA",
-- "210 - TL ACADEMIA" e "210 TL ACADEMIA", mas NUNCA com "2100-OUTRA" — que é
-- exatamente o erro que arquivaria documento de um cliente na pasta de outro.
--
-- Ambiguidade não vira escolha
-- ----------------------------
-- Quando duas pastas casam com o mesmo código (existem casos reais: o código
-- 233 tem "233- LP COMERCIO" e "233- POLAR BRASILIA"), NENHUMA é gravada. O
-- código fica sem mapa e a análise continua pedindo confirmação humana.
-- Escolher a primeira em ordem alfabética seria rápido, silencioso e errado.
--
-- A varredura é a fonte da verdade do momento
-- -------------------------------------------
-- Cada varredura manda o conteúdo INTEIRO de um contêiner. Pasta que sumiu do
-- disco sai do mapa: se alguém renomeou "210-TL ACADEMIA" para "210 - TL
-- ACADEMIA", o mapa acompanha em vez de continuar apontando para um caminho
-- que não existe mais.
-- =============================================================================

create table if not exists public.empresa_pastas (
  empresa_id   uuid not null references public.empresas(id) on delete cascade,
  -- Contêiner é o 1º nível ("01_CLIENTES_ATIVOS"). A mesma empresa pode ter
  -- pasta em ativos e em inativos durante uma transição.
  container    text not null,
  nome_pasta   text not null,
  -- Qual raiz produziu este mapa. Duas máquinas podem sincronizar bibliotecas
  -- diferentes; sem isso uma sobrescreveria o mapa da outra.
  raiz         text not null,
  conferido_em timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  primary key (empresa_id, container, raiz)
);

comment on table public.empresa_pastas is
  'Nome real da pasta de cada cliente no disco sincronizado. Preenchido pela '
  'varredura do worker; lido pela análise para montar o destino sem tocar disco.';

-- Duas empresas não podem reivindicar a mesma pasta.
create unique index if not exists empresa_pastas_pasta_unica_idx
  on public.empresa_pastas(raiz, container, nome_pasta);

create index if not exists empresa_pastas_empresa_idx
  on public.empresa_pastas(empresa_id);

alter table public.empresa_pastas enable row level security;
revoke all on public.empresa_pastas from anon, authenticated;
grant all on public.empresa_pastas to service_role;

-- -----------------------------------------------------------------------------
-- Pastas que a varredura viu e não soube a quem pertencem.
--
-- Não é erro: a maioria são pastas legítimas que não são de cliente (00_INTERNO,
-- "001 CERTIFICADOS"). Guardar serve para o painel poder mostrar "estas 12
-- pastas não têm empresa cadastrada" em vez de o documento falhar mais tarde
-- sem ninguém entender por quê.
-- -----------------------------------------------------------------------------
create table if not exists public.pastas_sem_empresa (
  raiz         text not null,
  container    text not null,
  nome_pasta   text not null,
  motivo       text not null check (motivo in ('sem_codigo', 'ambigua')),
  detalhe      text,
  visto_em     timestamptz not null default now(),
  primary key (raiz, container, nome_pasta)
);

alter table public.pastas_sem_empresa enable row level security;
revoke all on public.pastas_sem_empresa from anon, authenticated;
grant all on public.pastas_sem_empresa to service_role;

-- -----------------------------------------------------------------------------
-- sincronizar_pastas_empresas
--
-- Recebe o conteúdo completo de UM contêiner e reconcilia o mapa inteiro dele.
-- Idempotente: rodar de novo com a mesma lista não muda nada além de
-- `conferido_em`, que é justamente o sinal de "isto foi conferido agora".
-- -----------------------------------------------------------------------------
create or replace function public.sincronizar_pastas_empresas(
  p_raiz text, p_container text, p_pastas text[]
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  -- Materializados como jsonb porque o mesmo conjunto é usado em quatro
  -- comandos. Tabela temporária resolveria, mas `on commit drop` quebra se a
  -- função for chamada duas vezes na mesma transação — que é exatamente o que
  -- o teste faz, e o que uma varredura de vários contêineres faria.
  v_boas      jsonb;
  v_recusadas jsonb;
  v_ambiguas  jsonb;
  v_mapeadas  int;
  v_orfas     int;
  v_sem_pasta int;
begin
  if nullif(trim(p_raiz), '') is null or nullif(trim(p_container), '') is null then
    raise exception 'Raiz e contêiner são obrigatórios.';
  end if;
  if p_pastas is null then
    raise exception 'Lista de pastas ausente. Uma varredura vazia manda um array vazio, não null.';
  end if;

  -- Casamento: prefixo do código seguido de fim, espaço ou traço. Comparação
  -- por substr em vez de LIKE porque um código com "%" ou "_" viraria curinga.
  --
  -- As duas contagens de janela decidem tudo: uma empresa com mais de uma
  -- pasta candidata é ambígua, e uma pasta disputada por mais de uma empresa
  -- também. Nos dois casos ninguém é mapeado.
  with casamentos as (
    select e.id as empresa_id, e.codigo, p.nome as nome_pasta
      from unnest(p_pastas) as p(nome)
      join public.empresas e
        on starts_with(p.nome, e.codigo)
       and ( length(p.nome) = length(e.codigo)
          or substr(p.nome, length(e.codigo) + 1, 1) in (' ', '-') )
     where e.codigo is not null and e.codigo <> ''
  ), contagem as (
    select empresa_id, codigo, nome_pasta,
           count(*) over (partition by empresa_id) as por_empresa,
           count(*) over (partition by nome_pasta) as por_pasta,
           -- As pastas daquela empresa, para o relatório dizer QUAIS
           -- disputaram o código em vez de só quantas.
           jsonb_agg(nome_pasta) over (partition by empresa_id) as pastas_da_empresa
      from casamentos
  )
  select
    coalesce(jsonb_agg(jsonb_build_object('empresa_id', empresa_id, 'nome_pasta', nome_pasta))
               filter (where por_empresa = 1 and por_pasta = 1), '[]'),
    coalesce(jsonb_agg(distinct nome_pasta)
               filter (where por_empresa > 1 or por_pasta > 1), '[]'),
    coalesce(jsonb_agg(distinct jsonb_build_object(
               'empresa_id', empresa_id, 'codigo', codigo, 'pastas', pastas_da_empresa))
               filter (where por_empresa > 1), '[]')
    into v_boas, v_recusadas, v_ambiguas
    from contagem;

  insert into public.empresa_pastas(empresa_id, container, nome_pasta, raiz, conferido_em)
  select (b->>'empresa_id')::uuid, p_container, b->>'nome_pasta', p_raiz, now()
    from jsonb_array_elements(v_boas) b
  on conflict (empresa_id, container, raiz)
    do update set nome_pasta = excluded.nome_pasta, conferido_em = now();

  get diagnostics v_mapeadas = row_count;

  -- Some do mapa o que sumiu do disco (ou virou ambíguo desde a última vez).
  delete from public.empresa_pastas m
   where m.raiz = p_raiz and m.container = p_container
     and not exists (select 1 from jsonb_array_elements(v_boas) b
                      where (b->>'empresa_id')::uuid = m.empresa_id
                        and b->>'nome_pasta' = m.nome_pasta);

  -- Recadastra o diagnóstico deste contêiner do zero.
  delete from public.pastas_sem_empresa
   where raiz = p_raiz and container = p_container;

  insert into public.pastas_sem_empresa(raiz, container, nome_pasta, motivo, detalhe)
  select p_raiz, p_container, p.nome,
         case when v_recusadas ? p.nome then 'ambigua' else 'sem_codigo' end,
         case when v_recusadas ? p.nome
              then 'Mais de uma pasta ou empresa disputa este código.'
              else 'Nenhuma empresa cadastrada tem código compatível.' end
    from unnest(p_pastas) as p(nome)
   where not exists (select 1 from jsonb_array_elements(v_boas) b
                      where b->>'nome_pasta' = p.nome);

  get diagnostics v_orfas = row_count;

  select count(*) into v_sem_pasta from public.empresas e
   where e.ativo and e.codigo is not null and e.codigo <> ''
     and not exists (select 1 from public.empresa_pastas m
                      where m.empresa_id = e.id and m.raiz = p_raiz and m.container = p_container);

  return jsonb_build_object(
    'raiz', p_raiz, 'container', p_container,
    'pastas_lidas', coalesce(array_length(p_pastas, 1), 0),
    'mapeadas', v_mapeadas, 'ambiguas', v_ambiguas,
    'sem_empresa', v_orfas, 'empresas_sem_pasta', v_sem_pasta,
    'conferido_em', now()
  );
end;
$$;

revoke all on function public.sincronizar_pastas_empresas(text, text, text[])
  from public, anon, authenticated;
grant execute on function public.sincronizar_pastas_empresas(text, text, text[])
  to service_role;

grant select on public.empresa_pastas, public.pastas_sem_empresa to service_role;
