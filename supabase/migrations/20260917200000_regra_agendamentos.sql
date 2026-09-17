-- Pasta AGENDAMENTOS dentro da pasta do cliente.
--
-- O histórico do fluxo de pagamentos (contas a pagar, agendamentos do banco e
-- comprovantes) fica junto, separado dos demais documentos do mês. A pasta do
-- ano e da competência continua dentro dela, então o histórico é navegável:
--   999-CLIENTE/AGENDAMENTOS/2026/09.2026/999_CLIENTE_2026-09_RELATORIO_AGENDAMENTOS_ITAU_v1.pdf
--
-- O caminho_modelo é escrito para a estrutura do banco; a adaptação em
-- lib/arquivador/regras-pastas-existentes.ts (e a gêmea em Python) troca
-- {COMPETENCIA} por {COMPETENCIA_PASTA} e preserva a pasta fixa.

insert into regras_arquivamento
  (codigo, nome, escopo, caminho_modelo, padrao_nome,
   exige_empresa, exige_competencia, exige_instituicao, projeto, subcategoria, descricao, ativo)
values
  ('CLIENTE_AGENDAMENTOS',
   'Agendamentos e contas a pagar do cliente',
   'mensal',
   array['AGENDAMENTOS', '{ANO}', '{COMPETENCIA}'],
   '{CODIGO}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}',
   true, true, false, null, null,
   'Relatório de contas a pagar, relatório de agendamentos do banco e comprovantes de agendamento. Vão para a pasta AGENDAMENTOS do cliente, que guarda o histórico desse fluxo.',
   true)
on conflict (codigo) do update
  set nome = excluded.nome,
      escopo = excluded.escopo,
      caminho_modelo = excluded.caminho_modelo,
      padrao_nome = excluded.padrao_nome,
      exige_empresa = excluded.exige_empresa,
      exige_competencia = excluded.exige_competencia,
      exige_instituicao = excluded.exige_instituicao,
      descricao = excluded.descricao,
      ativo = excluded.ativo;
