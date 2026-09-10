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
