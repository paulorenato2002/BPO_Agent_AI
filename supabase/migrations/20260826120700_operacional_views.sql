-- =============================================================================
-- Camada operacional — Views para uso futuro do Hub
--
-- A INTERFACE DO HUB NÃO É CONSTRUÍDA NESTA FASE. Apenas as views.
--
-- SEGURANÇA: todas as views usam `security_invoker = true`. Sem isso, uma view
-- roda com os privilégios de quem a criou e IGNORA a RLS de quem consulta —
-- viraria um caminho para vazar dados. Com security_invoker, a RLS do usuário
-- que consulta é respeitada normalmente.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tarefas
-- -----------------------------------------------------------------------------

create or replace view public.vw_tarefas_hoje
with (security_invoker = true) as
select
  t.id,
  t.titulo,
  t.status,
  t.prioridade,
  t.prazo,
  t.empresa_id,
  e.codigo         as empresa_codigo,
  e.razao_social   as empresa_razao_social,
  t.responsavel_id,
  p.nome           as responsavel_nome,
  t.competencia_id,
  c.ano            as competencia_ano,
  c.mes            as competencia_mes,
  t.iniciada_em,
  t.duracao_estimada_minutos
from public.tarefas_operacionais t
join public.empresas e on e.id = t.empresa_id
left join public.perfis_usuarios p on p.usuario_id = t.responsavel_id
left join public.competencias_operacionais c on c.id = t.competencia_id
where t.ativo
  and t.prazo = current_date
  and t.status not in ('concluida', 'cancelada');

comment on view public.vw_tarefas_hoje is 'Hub: tarefas operacionais com prazo para hoje.';


create or replace view public.vw_tarefas_atrasadas
with (security_invoker = true) as
select
  t.id,
  t.titulo,
  t.status,
  t.prioridade,
  t.prazo,
  (current_date - t.prazo) as dias_atraso,
  t.empresa_id,
  e.codigo       as empresa_codigo,
  e.razao_social as empresa_razao_social,
  t.responsavel_id,
  p.nome         as responsavel_nome,
  t.competencia_id
from public.tarefas_operacionais t
join public.empresas e on e.id = t.empresa_id
left join public.perfis_usuarios p on p.usuario_id = t.responsavel_id
where t.ativo
  and t.prazo is not null
  and t.prazo < current_date
  and t.status not in ('concluida', 'cancelada');

comment on view public.vw_tarefas_atrasadas is 'Hub: tarefas operacionais vencidas e não concluídas.';


create or replace view public.vw_tarefas_semana
with (security_invoker = true) as
select
  t.id,
  t.titulo,
  t.status,
  t.prioridade,
  t.prazo,
  t.empresa_id,
  e.codigo       as empresa_codigo,
  e.razao_social as empresa_razao_social,
  t.responsavel_id,
  p.nome         as responsavel_nome,
  t.competencia_id
from public.tarefas_operacionais t
join public.empresas e on e.id = t.empresa_id
left join public.perfis_usuarios p on p.usuario_id = t.responsavel_id
where t.ativo
  and t.prazo between date_trunc('week', current_date)::date
                  and (date_trunc('week', current_date) + interval '6 days')::date
  and t.status not in ('concluida', 'cancelada');

comment on view public.vw_tarefas_semana is 'Hub: tarefas operacionais da semana corrente (segunda a domingo).';


-- -----------------------------------------------------------------------------
-- Operação por empresa
-- -----------------------------------------------------------------------------

create or replace view public.vw_operacao_por_empresa
with (security_invoker = true) as
select
  e.id             as empresa_id,
  e.codigo         as empresa_codigo,
  e.razao_social   as empresa_razao_social,
  e.status_operacao,
  count(t.id) filter (where t.status not in ('concluida', 'cancelada'))            as tarefas_abertas,
  count(t.id) filter (where t.status = 'concluida')                                as tarefas_concluidas,
  count(t.id) filter (where t.prazo < current_date
                        and t.status not in ('concluida', 'cancelada'))            as tarefas_atrasadas,
  count(t.id) filter (where t.status = 'bloqueada')                                as tarefas_bloqueadas,
  count(t.id) filter (where t.status like 'aguardando%')                           as tarefas_aguardando,
  max(t.updated_at)                                                                as ultima_movimentacao
from public.empresas e
left join public.tarefas_operacionais t
       on t.empresa_id = e.id and t.ativo
where e.ativo
group by e.id, e.codigo, e.razao_social, e.status_operacao;

comment on view public.vw_operacao_por_empresa is 'Hub: panorama operacional consolidado por empresa.';


-- -----------------------------------------------------------------------------
-- Cronômetros e horas
-- -----------------------------------------------------------------------------

create or replace view public.vw_cronometros_ativos
with (security_invoker = true) as
select
  a.id,
  a.usuario_id,
  p.nome            as usuario_nome,
  a.empresa_id,
  e.codigo          as empresa_codigo,
  e.razao_social    as empresa_razao_social,
  a.tarefa_operacional_id,
  t.titulo          as tarefa_titulo,
  a.inicio,
  greatest(0, (extract(epoch from (now() - a.inicio)) / 60)::int) as minutos_decorridos
from public.apontamentos_tempo a
join public.perfis_usuarios p on p.usuario_id = a.usuario_id
left join public.empresas e on e.id = a.empresa_id
left join public.tarefas_operacionais t on t.id = a.tarefa_operacional_id
where a.status = 'em_andamento';

comment on view public.vw_cronometros_ativos is 'Hub: cronômetros em andamento (no máximo um por usuário).';


create or replace view public.vw_horas_por_empresa
with (security_invoker = true) as
select
  e.id                                          as empresa_id,
  e.codigo                                      as empresa_codigo,
  e.razao_social                                as empresa_razao_social,
  date_trunc('month', a.inicio)::date           as mes_referencia,
  count(a.id)                                   as total_apontamentos,
  coalesce(sum(a.duracao_minutos), 0)           as minutos_totais,
  round(coalesce(sum(a.duracao_minutos), 0) / 60.0, 2) as horas_totais
from public.empresas e
join public.apontamentos_tempo a
  on a.empresa_id = e.id and a.status = 'concluido'
group by e.id, e.codigo, e.razao_social, date_trunc('month', a.inicio);

comment on view public.vw_horas_por_empresa is 'Hub: horas apontadas por empresa e mês (sessões concluídas).';


-- -----------------------------------------------------------------------------
-- Execuções de ferramenta
-- -----------------------------------------------------------------------------

create or replace view public.vw_execucoes_pendentes
with (security_invoker = true) as
select
  x.id,
  x.ferramenta_codigo,
  x.ferramenta_versao,
  x.status,
  x.tentativas,
  x.criada_em,
  x.iniciada_em,
  x.empresa_id,
  e.codigo       as empresa_codigo,
  e.razao_social as empresa_razao_social,
  x.usuario_id,
  p.nome         as usuario_nome,
  greatest(0, (extract(epoch from (now() - x.criada_em)) / 60)::int) as minutos_na_fila
from public.execucoes_ferramenta x
left join public.empresas e on e.id = x.empresa_id
left join public.perfis_usuarios p on p.usuario_id = x.usuario_id
where x.status in ('criada', 'validando', 'na_fila', 'executando', 'aguardando_aprovacao');

comment on view public.vw_execucoes_pendentes is 'Hub: execuções de ferramenta ainda não finalizadas.';


create or replace view public.vw_execucoes_erro
with (security_invoker = true) as
select
  x.id,
  x.ferramenta_codigo,
  x.ferramenta_versao,
  x.tentativas,
  x.erro_codigo,
  x.erro_mensagem,
  x.criada_em,
  x.concluida_em,
  x.empresa_id,
  e.codigo       as empresa_codigo,
  e.razao_social as empresa_razao_social,
  x.usuario_id,
  p.nome         as usuario_nome
from public.execucoes_ferramenta x
left join public.empresas e on e.id = x.empresa_id
left join public.perfis_usuarios p on p.usuario_id = x.usuario_id
where x.status = 'erro';

comment on view public.vw_execucoes_erro is 'Hub: execuções de ferramenta que terminaram em erro.';


-- -----------------------------------------------------------------------------
-- Documentos
-- -----------------------------------------------------------------------------

create or replace view public.vw_documentos_por_empresa_competencia
with (security_invoker = true) as
select
  d.empresa_id,
  e.codigo                as empresa_codigo,
  e.razao_social          as empresa_razao_social,
  d.competencia_id,
  c.ano                   as competencia_ano,
  c.mes                   as competencia_mes,
  c.referencia            as competencia_referencia,
  d.tipo_documento,
  count(d.id)                                                          as total_documentos,
  count(d.id) filter (where d.status = 'armazenado')                   as total_armazenados,
  count(d.id) filter (where d.status = 'armazenado_parcial')           as total_parciais,
  count(d.id) filter (where d.status = 'erro')                         as total_com_erro,
  coalesce(sum(d.tamanho_bytes), 0)                                    as bytes_totais,
  max(d.created_at)                                                    as ultimo_recebimento
from public.documentos_operacionais d
join public.empresas e on e.id = d.empresa_id
left join public.competencias_operacionais c on c.id = d.competencia_id
where d.ativo
group by d.empresa_id, e.codigo, e.razao_social,
         d.competencia_id, c.ano, c.mes, c.referencia, d.tipo_documento;

comment on view public.vw_documentos_por_empresa_competencia is
  'Hub: documentos consolidados por empresa, competência e tipo documental.';
