-- =============================================================================
-- Asserções do aprendizado de documentos.
--
-- O defeito que estes testes impedem: um padrão errado gravado. Depois de
-- gravado ele decide sozinho, então errar aqui manda documento de um cliente
-- para a pasta de outro todo mês, sem ninguém perguntar nada.
-- =============================================================================
begin;

do $$
declare
  v_tl    uuid;
  v_rz    uuid;
  r       jsonb;
  n       int;
  dono    uuid;
  txt     text;
  falhas  int := 0;
begin
  insert into public.empresas(codigo, razao_social, cnpj, matriz_filial, status_operacao, ativo)
  values ('910', 'TL EXEMPLO LTDA', '11222333000191', 'matriz', 'ativo', true)
  returning id into v_tl;
  insert into public.empresas(codigo, razao_social, cnpj, matriz_filial, status_operacao, ativo)
  values ('911', 'RZ EXEMPLO LTDA', '11222333000192', 'matriz', 'ativo', true)
  returning id into v_rz;

  -- ---------------------------------------------------------------------------
  -- 1. Uma confirmação grava conta e layout.
  -- ---------------------------------------------------------------------------
  r := public.registrar_aprendizado(jsonb_build_array(jsonb_build_object(
        'conta', '11360828', 'agencia', '50040', 'instituicao', 'SICOOB',
        'layout', 'abc123', 'empresa_id', v_tl::text,
        'tipo_documento', 'EXTRATO_BANCARIO', 'regra_codigo', 'CLIENTE_DOCUMENTO')), null);

  select empresa_id into dono from public.empresa_contas where conta = '11360828';
  if dono = v_tl then raise notice 'OK   conta aprendida aponta para a empresa certa';
  else raise notice 'FALHOU conta nao foi gravada'; falhas := falhas+1; end if;

  select tipo_documento into txt from public.padroes_documento where assinatura = 'abc123';
  if txt = 'EXTRATO_BANCARIO' then raise notice 'OK   layout aprendido guarda o tipo';
  else raise notice 'FALHOU layout: %', coalesce(txt,'(nada)'); falhas := falhas+1; end if;

  -- ---------------------------------------------------------------------------
  -- 2. Repetir a mesma confirmação conta, não duplica.
  -- ---------------------------------------------------------------------------
  r := public.registrar_aprendizado(jsonb_build_array(jsonb_build_object(
        'conta', '11360828', 'layout', 'abc123', 'empresa_id', v_tl::text,
        'tipo_documento', 'EXTRATO_BANCARIO')), null);

  select confirmacoes into n from public.empresa_contas where conta = '11360828';
  if n = 2 then raise notice 'OK   repetir soma confirmacao em vez de duplicar';
  else raise notice 'FALHOU confirmacoes=%', n; falhas := falhas+1; end if;

  select count(*) into n from public.empresa_contas where conta = '11360828';
  if n = 1 then raise notice 'OK   uma linha por conta';
  else raise notice 'FALHOU % linhas para a mesma conta', n; falhas := falhas+1; end if;

  -- ---------------------------------------------------------------------------
  -- 3. O TESTE QUE MAIS IMPORTA: outra empresa NÃO rouba a conta.
  -- ---------------------------------------------------------------------------
  r := public.registrar_aprendizado(jsonb_build_array(jsonb_build_object(
        'conta', '11360828', 'empresa_id', v_rz::text,
        'tipo_documento', 'EXTRATO_BANCARIO')), null);

  select empresa_id into dono from public.empresa_contas where conta = '11360828';
  if dono = v_tl then raise notice 'OK   conta em disputa nao troca de dono';
  else raise notice 'FALHOU a conta trocou de empresa'; falhas := falhas+1; end if;

  if (r->>'contas_em_disputa')::int = 1 then raise notice 'OK   a disputa e reportada';
  else raise notice 'FALHOU disputa nao reportada: %', r; falhas := falhas+1; end if;

  -- ---------------------------------------------------------------------------
  -- 4. Item incompleto é ignorado, não gravado pela metade.
  -- ---------------------------------------------------------------------------
  r := public.registrar_aprendizado(jsonb_build_array(
        jsonb_build_object('conta', '99999999'),                       -- sem empresa
        jsonb_build_object('empresa_id', v_rz::text),                  -- sem conta
        jsonb_build_object('layout', 'semtipo', 'empresa_id', v_rz::text)  -- sem tipo
       ), null);

  select count(*) into n from public.empresa_contas where conta = '99999999';
  if n = 0 then raise notice 'OK   conta sem empresa nao e gravada';
  else raise notice 'FALHOU gravou conta sem empresa'; falhas := falhas+1; end if;

  select count(*) into n from public.padroes_documento where assinatura = 'semtipo';
  if n = 0 then raise notice 'OK   layout sem tipo nao e gravado';
  else raise notice 'FALHOU gravou layout sem tipo'; falhas := falhas+1; end if;

  -- ---------------------------------------------------------------------------
  -- 5. O layout NÃO guarda empresa: o mesmo relatório serve vários clientes.
  -- ---------------------------------------------------------------------------
  r := public.registrar_aprendizado(jsonb_build_array(
        jsonb_build_object('layout', 'cielo-vendas', 'empresa_id', v_tl::text,
                           'tipo_documento', 'RELATORIO_VENDAS', 'instituicao', 'CIELO'),
        jsonb_build_object('layout', 'cielo-vendas', 'empresa_id', v_rz::text,
                           'tipo_documento', 'RELATORIO_VENDAS', 'instituicao', 'CIELO')
       ), null);

  select count(*) into n from public.padroes_documento where assinatura = 'cielo-vendas';
  if n = 1 then raise notice 'OK   um layout serve clientes diferentes';
  else raise notice 'FALHOU % linhas para o mesmo layout', n; falhas := falhas+1; end if;

  -- ---------------------------------------------------------------------------
  -- 6. Reclassificar um layout vale a última confirmação humana.
  -- ---------------------------------------------------------------------------
  r := public.registrar_aprendizado(jsonb_build_array(jsonb_build_object(
        'layout', 'abc123', 'tipo_documento', 'EXTRATO_INVESTIMENTOS')), null);

  select tipo_documento into txt from public.padroes_documento where assinatura = 'abc123';
  if txt = 'EXTRATO_INVESTIMENTOS' then raise notice 'OK   ultima confirmacao humana vence';
  else raise notice 'FALHOU tipo ficou %', txt; falhas := falhas+1; end if;

  -- ---------------------------------------------------------------------------
  -- 7. Entrada inválida é recusada em vez de gravar lixo.
  -- ---------------------------------------------------------------------------
  begin
    r := public.registrar_aprendizado('{"nao":"e-lista"}'::jsonb, null);
    raise notice 'FALHOU objeto foi aceito no lugar de lista'; falhas := falhas+1;
  exception when others then
    raise notice 'OK   entrada que nao e lista e recusada';
  end;

  r := public.registrar_aprendizado('[]'::jsonb, null);
  if (r->>'contas_registradas')::int = 0 then raise notice 'OK   lista vazia e aceita sem gravar nada';
  else raise notice 'FALHOU lista vazia gravou algo'; falhas := falhas+1; end if;

  if falhas = 0 then
    raise notice '=== TODOS OS TESTES DE APRENDIZADO PASSARAM ===';
  else
    raise exception '% asserção(ões) falharam', falhas;
  end if;
end $$;

rollback;
