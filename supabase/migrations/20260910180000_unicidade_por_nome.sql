-- =============================================================================
-- Unicidade do documento: pelo NOME, não pela versão
--
-- O índice `documentos_op_versao_uk` era:
--
--     (empresa_id, caminho_logico, versao) where ativo
--
-- `caminho_logico` guarda a PASTA, nunca a identidade do documento. Então a
-- regra dizia, na prática: "um único documento por pasta, por versão". Com a
-- estrutura atual (cliente/ano/competência) isso vira "um único documento por
-- cliente, por mês" — e oito arquivos de agosto do mesmo cliente brigam por
-- `versao = 1`.
--
-- Foi exatamente o que aconteceu: 8 arquivos copiados para a pasta, 2
-- registrados, 6 recusados por chave duplicada. O pior tipo de falha — o
-- arquivo está lá e o sistema não sabe.
--
-- O erro é de origem, não da simplificação da estrutura. Mesmo na árvore
-- antiga, com subpasta por categoria, duas notas fiscais da mesma competência
-- colidiriam. A estrutura plana só antecipou o encontro.
--
-- A REGRA CERTA: numa pasta não podem existir dois documentos ativos com o
-- mesmo nome final. É o que o sistema de arquivos já garante, e a versão já
-- está dentro do nome (`_v1`, `_v2`) — o banco só precisa concordar com o
-- disco em vez de inventar uma regra própria.
-- =============================================================================

drop index if exists public.documentos_op_versao_uk;

create unique index if not exists documentos_op_nome_uk
  on public.documentos_operacionais (empresa_id, caminho_logico, nome_final)
  where ativo and caminho_logico is not null and nome_final is not null;

comment on index public.documentos_op_nome_uk is
  'Dois documentos ativos não ocupam o mesmo nome na mesma pasta. Espelha o que o disco já impõe.';
