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
