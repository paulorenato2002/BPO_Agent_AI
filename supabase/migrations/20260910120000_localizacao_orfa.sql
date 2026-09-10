-- =============================================================================
-- Registro órfão: linha no banco apontando para arquivo que não existe mais
--
-- O sistema tratava "existe linha em documentos_operacionais" como "o arquivo
-- está na pasta". São fatos diferentes. Quando alguém apaga o arquivo do
-- destino, o registro continua vivo, o índice único (empresa_id, hash_sha256)
-- where ativo segue ocupado, e rearquivar o mesmo documento fica impossível:
-- `concluir_arquivamento` levanta "Documento já registrado em outro caminho".
--
-- A REGRA NOVA: só quem tem o disco pode afirmar que o arquivo está lá.
--
-- A Vercel não tem a pasta montada — lá o aviso de duplicata é palpite. Quem
-- sabe é o worker, que roda na máquina com o OneDrive sincronizado. Então ele
-- confere antes de copiar e informa o que viu; o banco decide com esse fato,
-- não com uma suposição.
--
-- Nada é apagado. O registro órfão é APOSENTADO (ativo = false) e a
-- localização vira 'removido'. O histórico continua contando a verdade:
-- foi arquivado, sumiu do disco, foi arquivado de novo.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Onde o banco acha que o documento está
--
-- O worker chama isto antes de copiar. Devolve o caminho absoluto gravado para
-- o par (empresa, conteúdo) — é o que ele vai procurar no disco.
-- -----------------------------------------------------------------------------

create or replace function public.localizacao_registrada(p_empresa uuid, p_hash text)
returns table (documento_id uuid, caminho_final text, nome_final text)
language sql
stable
security invoker
set search_path = ''
as $$
  select d.id, l.identificador_externo, d.nome_final
  from public.documentos_operacionais d
  join public.documento_localizacoes l
    on l.documento_id = d.id
   and l.provedor = 'pasta_sincronizada'
   and l.status = 'armazenado'
  where d.empresa_id = p_empresa
    and d.hash_sha256 = p_hash
    and d.ativo
  limit 1;
$$;

comment on function public.localizacao_registrada(uuid, text) is
  'Caminho absoluto que o banco acredita conter este documento. Quem confere se existe é o worker.';


-- -----------------------------------------------------------------------------
-- 2. Aposentar o registro órfão
--
-- Chamado pelo worker DEPOIS de constatar, no disco, que o arquivo sumiu.
-- Libera o índice único e deixa o rastro do motivo.
-- -----------------------------------------------------------------------------

create or replace function public.aposentar_documento_orfao(p_documento uuid, p_motivo text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  n int;
begin
  if p_documento is null then
    raise exception 'Documento obrigatório.';
  end if;
  if nullif(trim(coalesce(p_motivo, '')), '') is null then
    -- Aposentadoria sem motivo é aposentadoria que ninguém explica depois.
    raise exception 'Motivo obrigatório para aposentar um registro.';
  end if;

  update public.documentos_operacionais
     set ativo = false,
         status = 'removido',
         observacoes = concat_ws(E'\n', observacoes,
           format('[%s] Registro aposentado: %s', now()::date, p_motivo)),
         updated_at = now()
   where id = p_documento
     and ativo;

  get diagnostics n = row_count;
  if n = 0 then
    -- Já aposentado por uma tentativa anterior. Repetir é seguro.
    return;
  end if;

  update public.documento_localizacoes
     set status = 'removido',
         erro_mensagem = p_motivo,
         updated_at = now()
   where documento_id = p_documento
     and provedor = 'pasta_sincronizada';
end;
$$;

comment on function public.aposentar_documento_orfao(uuid, text) is
  'Marca como inativo um documento cujo arquivo sumiu do disco. Não apaga: o histórico continua.';


-- -----------------------------------------------------------------------------
-- 3. `status` de documento aceita 'removido'
--
-- O CHECK original não previa que um documento arquivado pudesse deixar de
-- existir no destino.
-- -----------------------------------------------------------------------------

alter table public.documentos_operacionais
  drop constraint if exists documentos_op_status_check;

alter table public.documentos_operacionais
  add constraint documentos_op_status_check
  check (status in ('recebido', 'classificado', 'armazenado', 'armazenado_parcial',
                    'erro', 'duplicado', 'arquivado', 'removido'));


-- -----------------------------------------------------------------------------
-- 4. Aposenta os órfãos que já existem
--
-- Não dá para conferir o disco daqui: o Postgres roda no Supabase e a pasta
-- está na máquina do operador. Então este bloco NÃO adivinha — quem varre é o
-- worker, na primeira vez que topar com cada um. Fica só o registro de que a
-- correção existe a partir daqui.
-- -----------------------------------------------------------------------------

do $$
begin
  raise notice 'Registros órfãos são aposentados pelo worker ao reencontrá-los.';
end $$;
