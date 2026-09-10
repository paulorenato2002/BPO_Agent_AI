-- =============================================================================
-- Asserções do mapa de pastas de cliente.
--
-- O defeito que estes testes existem para impedir: mapear o cliente errado.
-- Uma pasta atribuída à empresa errada arquiva documento de um cliente na
-- pasta de outro — e ninguém percebe até alguém abrir a pasta.
-- =============================================================================
\set ON_ERROR_STOP on
begin;

do $$
declare
  v_tl      uuid;
  v_curto   uuid;
  v_lp      uuid;
  v_polar   uuid;
  v_semp    uuid;
  r         jsonb;
  n         int;
  nome      text;
  falhas    int := 0;

begin
  -- Massa: códigos escolhidos para provocar colisão de prefixo.
  insert into public.empresas(codigo, razao_social, cnpj, matriz_filial, status_operacao, ativo)
  values ('210', 'TL ACADEMIA DE GINASTICA LTDA', '11222333000181', 'matriz', 'ativo', true)
  returning id into v_tl;
  insert into public.empresas(codigo, razao_social, cnpj, matriz_filial, status_operacao, ativo)
  values ('21',  'VINTE E UM LTDA',              '11222333000182', 'matriz', 'ativo', true)
  returning id into v_curto;
  insert into public.empresas(codigo, razao_social, cnpj, matriz_filial, status_operacao, ativo)
  values ('233', 'LP COMERCIO DE TINTAS LTDA',   '11222333000183', 'matriz', 'ativo', true)
  returning id into v_lp;
  insert into public.empresas(codigo, razao_social, cnpj, matriz_filial, status_operacao, ativo)
  values ('999', 'SEM PASTA NENHUMA LTDA',       '11222333000184', 'matriz', 'ativo', true)
  returning id into v_semp;

  -- ---------------------------------------------------------------------------
  -- 1. Os três formatos reais de nome casam com o mesmo código.
  -- ---------------------------------------------------------------------------
  r := public.sincronizar_pastas_empresas('RAIZ_A', '01_CLIENTES_ATIVOS',
        array['210-TL ACADEMIA']);
  select nome_pasta into nome from public.empresa_pastas
   where empresa_id = v_tl and raiz = 'RAIZ_A';
  if nome = '210-TL ACADEMIA' then raise notice 'OK   codigo-NOME casa';
  else raise notice 'FALHOU codigo-NOME: %', coalesce(nome,'(nada)'); falhas := falhas+1; end if;

  r := public.sincronizar_pastas_empresas('RAIZ_A', '01_CLIENTES_ATIVOS',
        array['210 - TL ACADEMIA']);
  select nome_pasta into nome from public.empresa_pastas
   where empresa_id = v_tl and raiz = 'RAIZ_A';
  if nome = '210 - TL ACADEMIA' then raise notice 'OK   codigo - NOME casa';
  else raise notice 'FALHOU codigo - NOME: %', coalesce(nome,'(nada)'); falhas := falhas+1; end if;

  r := public.sincronizar_pastas_empresas('RAIZ_A', '01_CLIENTES_ATIVOS',
        array['210 TL ACADEMIA']);
  select nome_pasta into nome from public.empresa_pastas
   where empresa_id = v_tl and raiz = 'RAIZ_A';
  if nome = '210 TL ACADEMIA' then raise notice 'OK   codigo NOME casa';
  else raise notice 'FALHOU codigo NOME: %', coalesce(nome,'(nada)'); falhas := falhas+1; end if;

  -- ---------------------------------------------------------------------------
  -- 2. O TESTE QUE MAIS IMPORTA: prefixo não basta.
  --    O código 21 NÃO pode ficar com a pasta do 210.
  -- ---------------------------------------------------------------------------
  r := public.sincronizar_pastas_empresas('RAIZ_A', '01_CLIENTES_ATIVOS',
        array['210-TL ACADEMIA']);
  select count(*) into n from public.empresa_pastas where empresa_id = v_curto;
  if n = 0 then raise notice 'OK   codigo 21 nao rouba a pasta do 210';
  else raise notice 'FALHOU 21 casou com pasta do 210'; falhas := falhas+1; end if;

  -- ...e quando a pasta do 21 existe de fato, ela é dele.
  r := public.sincronizar_pastas_empresas('RAIZ_A', '01_CLIENTES_ATIVOS',
        array['210-TL ACADEMIA', '21-VINTE E UM']);
  select nome_pasta into nome from public.empresa_pastas where empresa_id = v_curto;
  if nome = '21-VINTE E UM' then raise notice 'OK   cada codigo fica com a sua pasta';
  else raise notice 'FALHOU 21 recebeu: %', coalesce(nome,'(nada)'); falhas := falhas+1; end if;

  -- ---------------------------------------------------------------------------
  -- 3. Ambiguidade não vira escolha: duas pastas para o 233, nenhuma mapeada.
  -- ---------------------------------------------------------------------------
  r := public.sincronizar_pastas_empresas('RAIZ_A', '01_CLIENTES_ATIVOS',
        array['233- LP COMERCIO DE TINTAS', '233- POLAR BRASILIA']);
  select count(*) into n from public.empresa_pastas where empresa_id = v_lp;
  if n = 0 then raise notice 'OK   codigo ambiguo nao entra no mapa';
  else raise notice 'FALHOU 233 foi mapeado apesar da ambiguidade'; falhas := falhas+1; end if;

  select count(*) into n from public.pastas_sem_empresa
   where raiz='RAIZ_A' and motivo='ambigua';
  if n = 2 then raise notice 'OK   as duas pastas ambiguas viraram diagnostico';
  else raise notice 'FALHOU diagnostico de ambiguidade tem % linhas', n; falhas := falhas+1; end if;

  -- ---------------------------------------------------------------------------
  -- 4. A varredura é a verdade do momento: pasta que sumiu sai do mapa.
  -- ---------------------------------------------------------------------------
  r := public.sincronizar_pastas_empresas('RAIZ_A', '01_CLIENTES_ATIVOS',
        array['210-TL ACADEMIA']);
  r := public.sincronizar_pastas_empresas('RAIZ_A', '01_CLIENTES_ATIVOS',
        array['999-OUTRA COISA']);
  select count(*) into n from public.empresa_pastas where empresa_id = v_tl;
  if n = 0 then raise notice 'OK   pasta que sumiu do disco sai do mapa';
  else raise notice 'FALHOU pasta removida continua mapeada'; falhas := falhas+1; end if;

  -- ---------------------------------------------------------------------------
  -- 5. Renomear a pasta atualiza o mapa em vez de duplicar.
  -- ---------------------------------------------------------------------------
  r := public.sincronizar_pastas_empresas('RAIZ_A', '01_CLIENTES_ATIVOS',
        array['210-TL ACADEMIA']);
  r := public.sincronizar_pastas_empresas('RAIZ_A', '01_CLIENTES_ATIVOS',
        array['210 - TL ACADEMIA NOVO NOME']);
  select count(*) into n from public.empresa_pastas where empresa_id = v_tl;
  select nome_pasta into nome from public.empresa_pastas where empresa_id = v_tl;
  if n = 1 and nome = '210 - TL ACADEMIA NOVO NOME'
    then raise notice 'OK   renomear atualiza sem duplicar';
  else raise notice 'FALHOU renomear: % linha(s), nome=%', n, coalesce(nome,'(nada)'); falhas := falhas+1; end if;

  -- ---------------------------------------------------------------------------
  -- 6. Pasta sem empresa cadastrada vira diagnóstico, não erro.
  -- ---------------------------------------------------------------------------
  r := public.sincronizar_pastas_empresas('RAIZ_A', '01_CLIENTES_ATIVOS',
        array['210-TL ACADEMIA', '00_ALGUMA COISA INTERNA']);
  select count(*) into n from public.pastas_sem_empresa
   where raiz='RAIZ_A' and nome_pasta='00_ALGUMA COISA INTERNA' and motivo='sem_codigo';
  if n = 1 then raise notice 'OK   pasta sem empresa vira diagnostico';
  else raise notice 'FALHOU pasta orfa nao registrada'; falhas := falhas+1; end if;

  -- ---------------------------------------------------------------------------
  -- 7. Duas raízes convivem sem sobrescrever uma à outra.
  -- ---------------------------------------------------------------------------
  r := public.sincronizar_pastas_empresas('RAIZ_B', '01_CLIENTES_ATIVOS',
        array['210-TL ACADEMIA EM OUTRA MAQUINA']);
  select count(*) into n from public.empresa_pastas where empresa_id = v_tl;
  if n = 2 then raise notice 'OK   duas raizes convivem';
  else raise notice 'FALHOU raizes distintas: % linha(s)', n; falhas := falhas+1; end if;

  -- ---------------------------------------------------------------------------
  -- 8. Contagem de empresas sem pasta é reportada.
  -- ---------------------------------------------------------------------------
  r := public.sincronizar_pastas_empresas('RAIZ_A', '01_CLIENTES_ATIVOS',
        array['210-TL ACADEMIA']);
  if (r->>'empresas_sem_pasta')::int >= 1 then raise notice 'OK   empresas sem pasta sao contadas';
  else raise notice 'FALHOU empresas_sem_pasta=%', r->>'empresas_sem_pasta'; falhas := falhas+1; end if;

  -- ---------------------------------------------------------------------------
  -- 9. Varredura vazia é aceita; null é recusado.
  -- ---------------------------------------------------------------------------
  r := public.sincronizar_pastas_empresas('RAIZ_A', '01_CLIENTES_ATIVOS', array[]::text[]);
  select count(*) into n from public.empresa_pastas where raiz='RAIZ_A';
  if n = 0 then raise notice 'OK   contêiner esvaziado limpa o mapa daquela raiz';
  else raise notice 'FALHOU esvaziar deixou % linha(s)', n; falhas := falhas+1; end if;

  begin
    r := public.sincronizar_pastas_empresas('RAIZ_A', '01_CLIENTES_ATIVOS', null);
    raise notice 'FALHOU null foi aceito como varredura'; falhas := falhas+1;
  exception when others then
    raise notice 'OK   varredura null e recusada';
  end;

  if falhas = 0 then
    raise notice '=== TODOS OS TESTES DO MAPA PASSARAM ===';
  else
    raise exception '% asserção(ões) falharam', falhas;
  end if;
end $$;

rollback;
