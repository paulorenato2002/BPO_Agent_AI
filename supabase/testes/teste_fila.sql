-- Massa fictícia para banco DESCARTÁVEL, nunca produção.
insert into auth.users(id,email) values
 ('11111111-1111-1111-1111-111111111111','fila@teste.invalid'),
 ('22222222-2222-2222-2222-222222222222','outro@teste.invalid');
insert into public.perfis_usuarios(usuario_id,nome,papel,ativo) values
 ('11111111-1111-1111-1111-111111111111','Teste fila','analista',true);
insert into public.empresas(id,codigo,razao_social,cnpj,ativo)
 values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','999','EMPRESA TESTE','11222333000181',true);
insert into public.conversas_agente(id,usuario_id)
 values('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','11111111-1111-1111-1111-111111111111');
insert into public.anexos_agente(id,arquivo_id,usuario_id,nome_original,extensao,tamanho_bytes,hash_sha256)
 values('cccccccc-cccc-cccc-cccc-cccccccccccc','dddddddd-dddd-dddd-dddd-dddddddddddd',
 '11111111-1111-1111-1111-111111111111','teste.txt','txt',10,repeat('a',64));
insert into public.regras_arquivamento(codigo,nome,escopo,caminho_modelo,padrao_nome,exige_empresa,exige_competencia)
 values('TESTE_FILA','Teste','mensal','["{COMPETENCIA}"]','{CODIGO}_v{VERSAO}.{EXTENSAO}',true,true);
insert into public.propostas_arquivamento(id,usuario_id,conversa_id,itens,hashes)
 values('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','11111111-1111-1111-1111-111111111111',
 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',jsonb_build_array(jsonb_build_object(
 'anexoId','cccccccc-cccc-cccc-cccc-cccccccccccc','status','analisado','nomeOriginal','teste.txt',
 'hashSha256',repeat('a',64),'conflitos','[]'::jsonb,'evidencias','[]'::jsonb,
 'nomeSugerido','999_v1.txt','caminhoSugerido','CLIENTES/999/2026-09/999_v1.txt',
 'empresa',jsonb_build_object('empresaId','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','confianca','provavel'),
 'regra',jsonb_build_object('valor','TESTE_FILA'),'competencia',jsonb_build_object('valor','2026-09'),
 'tipoDocumento',jsonb_build_object('valor','TESTE'),'instituicao',jsonb_build_object('valor',null))), '[]');

set role service_role;
do $$
declare f public.fila_arquivamento; r jsonb; repetido jsonb;
begin
  if has_function_privilege('anon','public.assumir_arquivamento(text)','execute') then raise exception 'anon pode assumir'; end if;
  if has_function_privilege('authenticated','public.concluir_arquivamento(uuid,text,jsonb)','execute') then raise exception 'usuário pode concluir'; end if;
  if has_table_privilege('authenticated','public.fila_arquivamento','select') then raise exception 'fila exposta'; end if;
  begin
    perform public.enfileirar_arquivamento('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','22222222-2222-2222-2222-222222222222',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',array['cccccccc-cccc-cccc-cccc-cccccccccccc']::uuid[]);
    raise exception 'TESTE: aceitou outro usuário';
  exception when others then if sqlerrm like 'TESTE:%' then raise; end if; end;
  begin
    perform public.enfileirar_arquivamento('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','11111111-1111-1111-1111-111111111111',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',array['cccccccc-cccc-cccc-cccc-cccccccccccc']::uuid[]);
    raise exception 'TESTE: aceitou empresa provável';
  exception when others then if sqlerrm like 'TESTE:%' then raise; end if; end;
  update public.propostas_arquivamento set itens=jsonb_set(itens,'{0,empresa,confianca}','"confirmado"');
  perform public.enfileirar_arquivamento('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','11111111-1111-1111-1111-111111111111',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',array['cccccccc-cccc-cccc-cccc-cccccccccccc']::uuid[]);
  perform public.enfileirar_arquivamento('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','11111111-1111-1111-1111-111111111111',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',array['cccccccc-cccc-cccc-cccc-cccccccccccc']::uuid[]);
  if (select count(*) from public.fila_arquivamento)<>1 then raise exception 'Duplicou fila'; end if;
  select * into f from public.assumir_arquivamento('pc-teste');
  if f.status<>'processando' then raise exception 'Não assumiu'; end if;
  if exists(select 1 from public.assumir_arquivamento('outro-pc')) then raise exception 'Outro worker assumiu'; end if;
  if not exists(select 1 from public.assumir_arquivamento('pc-teste') where id=f.id) then raise exception 'Não retomou'; end if;
  r := jsonb_build_object('status','arquivado','sha256',repeat('a',64),'caminho_relativo','CLIENTES/999/2026-09',
    'nome_final','999_v1.txt','caminho_final','C:/TESTE/CLIENTES/999/2026-09/999_v1.txt','versao',1);
  perform public.concluir_arquivamento(f.id,'pc-teste',r);
  repetido := public.concluir_arquivamento(f.id,'pc-teste',r);
  if repetido->>'documento_id' is null then raise exception 'Não registrou documento'; end if;
  if (select count(*) from public.mensagens_agente where metadados->>'fila_arquivamento_id'=f.id::text)<>1 then raise exception 'Duplicou aviso'; end if;
  if (select status from public.propostas_arquivamento where id=f.proposta_id)<>'arquivada' then raise exception 'Proposta não concluída'; end if;
end;
$$;
reset role;
