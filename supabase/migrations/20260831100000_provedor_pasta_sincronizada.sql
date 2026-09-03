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
