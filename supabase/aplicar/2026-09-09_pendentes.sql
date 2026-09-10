-- =============================================================================
-- PENDENTES DE 2026-09-09 — colar inteiro no SQL Editor do Supabase
--
-- Diagnóstico feito contra o banco real em 2026-09-09: as migrations abaixo
-- ainda não estavam aplicadas. Sem elas o arquivamento não funciona ponta a
-- ponta — a fila nem sequer existe.
--
-- ORDEM IMPORTA. Este arquivo já está na ordem certa; cole tudo de uma vez,
-- não em pedaços.
--
-- É SEGURO REAPLICAR. Todas são idempotentes: rodar de novo não duplica nada
-- nem apaga dado. Se você não tiver certeza se já rodou, rode.
--
-- O QUE MUDA NOS SEUS DADOS:
--   * 20260901 DESATIVA as regras de cliente antigas (ativo = false) e cria a
--     regra única CLIENTE_DOCUMENTO. Nada é apagado — documentos já arquivados
--     continuam apontando para as regras antigas.
--   * As outras três só criam tabelas, funções e permissões novas.
--
-- Gerado a partir de supabase/migrations/. A fonte continua sendo aquela pasta;
-- este arquivo é uma conveniência para colar.
-- =============================================================================


-- ###########################################################################
-- # 20260831100000_provedor_pasta_sincronizada.sql
-- ###########################################################################

-- =============================================================================
-- Provedor: pasta sincronizada
--
-- O arquivamento deixou de subir por API do Drive e passou a escrever numa
-- pasta do OneDrive sincronizada na máquina — o acesso de aplicativo ao tenant
-- dependia de aprovação que não estava disponível.
--
-- `documento_localizacoes.provedor` só aceitava supabase_storage, google_drive
-- e local_teste. Sem um valor para a rota nova, o registro diria "google_drive"
-- para um arquivo que está no OneDrive: o banco mentindo sobre onde o
-- documento está, que é o pior tipo de erro num arquivo de documentos.
-- =============================================================================

alter table public.documento_localizacoes
  drop constraint if exists documento_localizacoes_provedor_check;

alter table public.documento_localizacoes
  add constraint documento_localizacoes_provedor_check
  check (provedor in (
    'supabase_storage',
    'google_drive',
    -- Pasta do OneDrive/SharePoint sincronizada na máquina do operador. O
    -- `identificador_externo` aqui é o caminho absoluto no disco daquela
    -- máquina — não um id de provedor, porque não existe um.
    'pasta_sincronizada',
    'local_teste'
  ));

comment on column public.documento_localizacoes.identificador_externo is
  'Id no provedor (Drive) ou caminho absoluto na máquina (pasta_sincronizada).';


-- ###########################################################################
-- # 20260901100000_estrutura_simplificada_cliente.sql
-- ###########################################################################

-- =============================================================================
-- Estrutura do cliente: só ano / competência
--
-- As 23 regras de cliente (3 fixas + 8 mensais + 12 de projeto) criavam uma
-- árvore de categorias dentro de cada empresa:
--
--   RZ/01_DOCUMENTOS_MENSAIS/2026/2026-08/05_NOTAS_FISCAIS/arquivo.pdf
--   RZ/02_RELATORIOS_E_PROJETOS/CONFERENCIA_DE_CARTOES/2026/2026-08/01_INSUMOS/...
--
-- Passa a ser:
--
--   RZ/2026/2026-08/RZ_2026-08_NOTA_FISCAL_v1.pdf
--
-- O tipo do documento sai da PASTA e passa a viver no NOME. Três ganhos:
--
-- 1. O agente não escolhe mais entre 23 regras — só precisa acertar empresa,
--    competência e tipo. Some a classe inteira de erro "regra errada".
-- 2. O caminho encurta muito. A raiz real já consome 112 dos 255 caracteres
--    do Windows, e a árvore de projeto estourava com cliente de nome comprido.
-- 3. Menos pasta vazia: uma competência é uma pasta, não vinte.
--
-- O nome perde {EMPRESA}: a pasta do cliente já está no caminho, e repetir
-- razão social no arquivo era o maior desperdício de caracteres.
--
-- As regras antigas são DESATIVADAS, não apagadas. Documentos já arquivados
-- apontam para elas por regra_arquivamento_id, e apagar cortaria esse
-- histórico.
-- =============================================================================

-- 1. Desativa as regras de cliente antigas.
update public.regras_arquivamento
   set ativo = false,
       descricao = coalesce(descricao || ' ', '') ||
                   '[desativada em 2026-09: estrutura do cliente simplificada '
                   'para ano/competência]'
 where escopo in ('fixo', 'mensal', 'projeto')
   and ativo;

-- 2. A regra única de documento de cliente.
insert into public.regras_arquivamento
  (codigo, nome, escopo, caminho_modelo, padrao_nome,
   exige_empresa, exige_competencia, exige_instituicao, projeto, subcategoria,
   descricao)
values
  ('CLIENTE_DOCUMENTO',
   'Documento de cliente',
   'mensal',
   '["{ANO}","{COMPETENCIA}"]',
   '{CODIGO}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, null, null,
   'Qualquer documento de cliente. O tipo vive no nome do arquivo, não em '
   'subpasta — a pasta da competência é plana de propósito.')
on conflict (codigo) do update
   set nome = excluded.nome,
       caminho_modelo = excluded.caminho_modelo,
       padrao_nome = excluded.padrao_nome,
       exige_empresa = excluded.exige_empresa,
       exige_competencia = excluded.exige_competencia,
       descricao = excluded.descricao,
       ativo = true;

-- 3. As regras internas mantêm a estrutura: não são por cliente, então não
--    multiplicam pasta, e a separação por assunto continua útil. Só perdem o
--    {EMPRESA} do nome, que nunca fez sentido em documento interno.
update public.regras_arquivamento
   set padrao_nome = '{TIPO_DOCUMENTO}_{DATA_DOCUMENTO}_v{VERSAO}.{EXTENSAO}'
 where escopo = 'interno'
   and ativo;


-- ###########################################################################
-- # 20260908130800_fila_arquivamento_local.sql
-- ###########################################################################

-- Somente backend/worker escrevem. O navegador consulta pela rota autenticada.
create table if not exists public.fila_arquivamento (
  id uuid primary key default gen_random_uuid(),
  proposta_id uuid not null references public.propostas_arquivamento(id),
  anexo_id uuid not null references public.anexos_agente(id),
  usuario_id uuid not null references auth.users(id),
  conversa_id uuid references public.conversas_agente(id) on delete set null,
  nome_original text not null,
  status text not null default 'pendente' check (status in ('pendente','processando','concluido','erro')),
  payload jsonb not null,
  resultado jsonb,
  erro text,
  worker_id text,
  tentativas integer not null default 0,
  created_at timestamptz not null default now(),
  iniciado_em timestamptz,
  atualizado_em timestamptz not null default now(),
  concluido_em timestamptz,
  unique(proposta_id, anexo_id)
);
alter table public.fila_arquivamento enable row level security;
revoke all on public.fila_arquivamento from anon, authenticated;
grant all on public.fila_arquivamento to service_role;
-- Não depende dos defaults de grants do projeto Supabase.
grant select on public.perfis_usuarios, public.conversas_agente, public.anexos_agente,
  public.regras_arquivamento, public.empresas to service_role;
grant select, update on public.propostas_arquivamento to service_role;
grant select, insert on public.documentos_operacionais, public.documento_localizacoes,
  public.mensagens_agente to service_role;
create index if not exists fila_arquivamento_pendente_idx
  on public.fila_arquivamento(created_at) where status = 'pendente';
create index if not exists fila_arquivamento_conversa_idx
  on public.fila_arquivamento(usuario_id, conversa_id, created_at desc);
create index if not exists fila_arquivamento_worker_idx
  on public.fila_arquivamento(worker_id) where status = 'processando';

create or replace function public.enfileirar_arquivamento(
  p_proposta uuid, p_usuario uuid, p_conversa uuid, p_anexos uuid[]
) returns setof public.fila_arquivamento
language plpgsql security invoker set search_path = '' as $$
declare
  p public.propostas_arquivamento;
  a public.anexos_agente;
  r public.regras_arquivamento;
  e public.empresas;
  item jsonb;
  anexo uuid;
begin
  if coalesce(cardinality(p_anexos),0) = 0 then raise exception 'Nenhum arquivo confirmado.'; end if;
  if not exists(select 1 from public.perfis_usuarios where usuario_id=p_usuario and ativo) then
    raise exception 'Usuário sem acesso.';
  end if;
  if p_conversa is null or not exists(select 1 from public.conversas_agente where id=p_conversa and usuario_id=p_usuario) then
    raise exception 'Conversa não encontrada.';
  end if;
  select * into p from public.propostas_arquivamento where id=p_proposta and usuario_id=p_usuario for update;
  if not found then raise exception 'Proposta não encontrada.'; end if;
  if p.conversa_id is distinct from p_conversa then raise exception 'Proposta de outra conversa.'; end if;
  -- Retentativa de uma confirmação já aceita devolve o mesmo trabalho.
  if exists(select 1 from public.fila_arquivamento where proposta_id=p.id) then
    if exists(select 1 from unnest(p_anexos) x where not exists(
      select 1 from public.fila_arquivamento f where f.proposta_id=p.id and f.anexo_id=x
    )) then raise exception 'A confirmação já foi registrada. Reanalise os outros itens.'; end if;
    return query select * from public.fila_arquivamento where proposta_id=p.id and anexo_id=any(p_anexos);
    return;
  end if;
  if p.status <> 'aguardando' or p.expira_em <= now() then raise exception 'Proposta resolvida ou vencida. Refaça a análise.'; end if;
  foreach anexo in array p_anexos loop
    select value into item from jsonb_array_elements(p.itens) where value->>'anexoId'=anexo::text;
    if item is null then raise exception 'Arquivo não pertence à proposta.'; end if;
    if item->>'status' is distinct from 'analisado' or jsonb_array_length(item->'conflitos')>0
       or nullif(item->>'nomeSugerido','') is null or nullif(item->>'caminhoSugerido','') is null then
      raise exception 'Arquivo incompleto ou bloqueado. Refaça a análise.';
    end if;
    if item#>>'{empresa,empresaId}' is not null and item#>>'{empresa,confianca}' is distinct from 'confirmado' then
      raise exception 'Confirme qual é a empresa e repita a análise com correcoes.empresaId.';
    end if;
    select * into a from public.anexos_agente where id=anexo and usuario_id=p_usuario and not bloqueado;
    if not found or a.hash_sha256 is distinct from item->>'hashSha256' then raise exception 'Anexo indisponível ou alterado.'; end if;
    select * into r from public.regras_arquivamento where codigo=item#>>'{regra,valor}' and ativo;
    if not found then raise exception 'Regra indisponível.'; end if;
    select * into e from public.empresas where id=(item#>>'{empresa,empresaId}')::uuid;
    if r.exige_empresa and e.id is null then raise exception 'Empresa não encontrada.'; end if;
    insert into public.fila_arquivamento(proposta_id,anexo_id,usuario_id,conversa_id,nome_original,payload)
    values(p.id,a.id,p_usuario,p_conversa,a.nome_original,jsonb_build_object(
      'item',item,'regra',to_jsonb(r),'arquivo_id',a.arquivo_id,'nome_original',a.nome_original,
      'hash_sha256',a.hash_sha256,'tamanho_bytes',a.tamanho_bytes,'mime_type',a.mime_type,
      'contexto',jsonb_build_object('empresa_codigo',e.codigo,'empresa_nome',coalesce(e.nome_fantasia,e.razao_social),
        'pasta_clientes',split_part(item->>'caminhoSugerido','/',1),
        'competencia',item#>>'{competencia,valor}','instituicao',item#>>'{instituicao,valor}',
        'tipo_documento',item#>>'{tipoDocumento,valor}','extensao',a.extensao)
    )) on conflict (proposta_id,anexo_id) do nothing;
  end loop;
  update public.propostas_arquivamento set status='confirmada',confirmada_por=p_usuario,confirmada_em=now() where id=p.id;
  return query select * from public.fila_arquivamento where proposta_id=p.id;
end;
$$;

create or replace function public.assumir_arquivamento(p_worker text)
returns setof public.fila_arquivamento
language plpgsql security invoker set search_path = '' as $$
declare escolhido uuid;
begin
  if nullif(trim(p_worker),'') is null then raise exception 'Worker obrigatório.'; end if;
  -- Um único worker local. Reinício retoma o item que ele estava processando.
  select id into escolhido from public.fila_arquivamento
    where status='processando' and worker_id=p_worker order by created_at limit 1 for update skip locked;
  if escolhido is null then
    select id into escolhido from public.fila_arquivamento
      where status='pendente' order by created_at limit 1 for update skip locked;
  end if;
  return query update public.fila_arquivamento set status='processando',worker_id=p_worker,
    tentativas=tentativas+1,iniciado_em=coalesce(iniciado_em,now()),atualizado_em=now()
    where id=escolhido returning *;
end;
$$;

-- Documento, localização, conclusão e mensagem são confirmados juntos.
-- Se a conexão cair depois do COMMIT, repetir esta RPC devolve o resultado salvo.
create or replace function public.concluir_arquivamento(p_id uuid,p_worker text,p_resultado jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  f public.fila_arquivamento;
  item jsonb;
  documento uuid;
  caminho text;
  nome text;
  v_resultado jsonb;
begin
  select * into f from public.fila_arquivamento where id=p_id for update;
  if not found or f.worker_id is distinct from p_worker then raise exception 'Trabalho não pertence ao worker.'; end if;
  if f.status='concluido' then return f.resultado; end if;
  if f.status <> 'processando' then raise exception 'Trabalho não está em processamento.'; end if;
  item := f.payload->'item';
  caminho := p_resultado->>'caminho_relativo';
  nome := p_resultado->>'nome_final';
  if p_resultado->>'sha256' is distinct from f.payload->>'hash_sha256'
    or nullif(caminho,'') is null or nullif(nome,'') is null
    or nullif(p_resultado->>'caminho_final','') is null
    or coalesce(p_resultado->>'status','') not in ('arquivado','ja_existia') then
    raise exception 'Resultado de cópia inválido.';
  end if;
  insert into public.documentos_operacionais(empresa_id,tipo_documento,nome_original,nome_final,
    extensao,mime_type,tamanho_bytes,hash_sha256,versao,status,origem,instituicao,caminho_logico,
    evidencias,classificacao_sugerida,classificacao_confirmada,confirmado_por,confirmado_em,proposta_id,created_by)
  values((item#>>'{empresa,empresaId}')::uuid,coalesce(item#>>'{tipoDocumento,valor}','NAO_CLASSIFICADO'),
    f.nome_original,nome,f.payload#>>'{contexto,extensao}',f.payload->>'mime_type',
    (f.payload->>'tamanho_bytes')::bigint,f.payload->>'hash_sha256',coalesce((p_resultado->>'versao')::int,1),
    'armazenado','agente',item#>>'{instituicao,valor}',caminho,coalesce(item->'evidencias','[]'),
    item,jsonb_build_object('regra',item#>>'{regra,valor}','competencia',item#>>'{competencia,valor}',
    'tipoDocumento',item#>>'{tipoDocumento,valor}'),f.usuario_id,now(),f.proposta_id,f.usuario_id)
  on conflict (empresa_id,hash_sha256) where ativo do nothing returning id into documento;
  if documento is null then
    select id into documento from public.documentos_operacionais
      where empresa_id=(item#>>'{empresa,empresaId}')::uuid and hash_sha256=f.payload->>'hash_sha256' and ativo;
    -- Preserva uma localização existente. Não declara como nova uma cópia em outro caminho.
    if exists(select 1 from public.documento_localizacoes where documento_id=documento and provedor='pasta_sincronizada'
      and identificador_externo is distinct from p_resultado->>'caminho_final') then
      raise exception 'Documento já registrado em outro caminho. Confira a localização existente.';
    end if;
  end if;
  insert into public.documento_localizacoes(documento_id,provedor,bucket_ou_pasta,caminho,identificador_externo,
    nome_utilizado,status,armazenado_em,created_by)
  values(documento,'pasta_sincronizada',caminho,caminho||'/'||nome,p_resultado->>'caminho_final',nome,'armazenado',now(),f.usuario_id)
  on conflict (documento_id,provedor) do nothing;
  v_resultado := p_resultado || jsonb_build_object('documento_id',documento);
  update public.fila_arquivamento set status='concluido',resultado=v_resultado,erro=null,
    atualizado_em=now(),concluido_em=now() where id=f.id;
  if f.conversa_id is not null then
    insert into public.mensagens_agente(conversa_id,papel,conteudo,tipo_mensagem,status,documento_id,metadados)
    values(f.conversa_id,'agente','Arquivo '||f.nome_original||' salvo na pasta local: '||caminho||'/'||nome||
      '. A sincronização com a nuvem fica a cargo do OneDrive.', 'resultado','concluida',documento,
      jsonb_build_object('fila_arquivamento_id',f.id));
  end if;
  update public.propostas_arquivamento p set status=case
    when exists(select 1 from public.fila_arquivamento where proposta_id=f.proposta_id and status in ('pendente','processando')) then 'confirmada'
    when exists(select 1 from public.fila_arquivamento where proposta_id=f.proposta_id and status='erro')
      or (select count(*) from public.fila_arquivamento where proposta_id=f.proposta_id) < jsonb_array_length(p.itens) then 'parcial'
    else 'arquivada' end where p.id=f.proposta_id;
  return v_resultado;
end;
$$;

create or replace function public.falhar_arquivamento(p_id uuid,p_worker text,p_erro text)
returns void language plpgsql security invoker set search_path = '' as $$
declare f public.fila_arquivamento;
begin
  select * into f from public.fila_arquivamento where id=p_id for update;
  if not found or f.worker_id is distinct from p_worker then raise exception 'Trabalho não pertence ao worker.'; end if;
  if f.status='erro' then return; end if;
  if f.status<>'processando' then raise exception 'Trabalho não está em processamento.'; end if;
  update public.fila_arquivamento set status='erro',erro=left(coalesce(p_erro,'Falha no arquivamento.'),500),
    atualizado_em=now(),concluido_em=now() where id=f.id;
  update public.propostas_arquivamento set status='parcial',erro_mensagem=left(p_erro,500) where id=f.proposta_id;
  if f.conversa_id is not null then
    insert into public.mensagens_agente(conversa_id,papel,conteudo,tipo_mensagem,status,metadados)
    values(f.conversa_id,'agente','Não foi possível concluir o arquivamento de '||f.nome_original||': '||left(p_erro,500),
      'erro','concluida',jsonb_build_object('fila_arquivamento_id',f.id));
  end if;
end;
$$;

revoke all on function public.falhar_arquivamento(uuid,text,text) from public,anon,authenticated;
grant execute on function public.falhar_arquivamento(uuid,text,text) to service_role;
revoke all on function public.enfileirar_arquivamento(uuid,uuid,uuid,uuid[]) from public,anon,authenticated;
revoke all on function public.assumir_arquivamento(text) from public,anon,authenticated;
revoke all on function public.concluir_arquivamento(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.enfileirar_arquivamento(uuid,uuid,uuid,uuid[]) to service_role;
grant execute on function public.assumir_arquivamento(text) to service_role;
grant execute on function public.concluir_arquivamento(uuid,text,jsonb) to service_role;


-- ###########################################################################
-- # 20260909120000_mapa_pastas_empresas.sql
-- ###########################################################################

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

