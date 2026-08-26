# Classificação de acesso das tabelas

Auditoria de quem pode ver o quê. Cada tabela cai em uma de quatro categorias.

**Regra que não se negocia:** papel superior **não** dá acesso a conversa privada
de outro usuário. Supervisor, sócio e administrador aprovam memórias e gerenciam
a operação — mas não leem as conversas alheias.

---

## Categorias

| Categoria | Significado |
|---|---|
| **Privada do usuário** | Só o dono (`auth.uid()`) acessa. Papel não abre exceção. |
| **Compartilhada pela equipe** | Qualquer usuário interno **ativo** lê. |
| **Restrita por papel** | Escrita ou aprovação exige papel específico. |
| **Exclusiva do backend** | Nenhum acesso via `authenticated`; só `service_role`. |

---

## Tabelas do agente

| Tabela | Categoria | Detalhe |
|---|---|---|
| `conversas_agente` | Privada do usuário | `usuario_id = auth.uid()` no SELECT/INSERT/UPDATE |
| `mensagens_agente` | Privada do usuário | Propriedade validada pela **conversa**, nunca por `usuario_id` vindo do cliente |
| `mensagem_documentos` | Privada do usuário | Herda a propriedade da conversa da mensagem |
| `feedback_agente` | Privada do usuário | Só o autor lê o próprio feedback |
| `memorias_agente` (escopo `pessoal`) | Privada do usuário | Só o dono, em qualquer status |
| `memorias_agente` (demais escopos) | Compartilhada / restrita por papel | **Ativas** são legíveis por todo interno ativo; ativar exige supervisor+ |
| `memoria_utilizacoes` | Exclusiva do backend | Telemetria; `authenticated` não lê nem escreve |

## Camada operacional

| Tabela | Categoria | Detalhe |
|---|---|---|
| `perfis_usuarios` | Compartilhada (leitura) / restrita (escrita) | Todos leem; criar exige administrador ou sócio; cada um edita o próprio |
| `competencias_operacionais`, `modelos_rotina`, `etapas_modelo_rotina`, `rotinas_empresa` | Compartilhada pela equipe | Leitura e escrita para interno ativo |
| `tarefas_operacionais` | Compartilhada pela equipe | Trabalho da equipe, não é privado |
| `apontamentos_tempo` | Privada do usuário (com exceção de gestão) | Cada um vê os próprios; supervisor+ vê todos — é apontamento de horas, não conversa |
| `documentos_operacionais`, `documento_localizacoes` | Compartilhada pela equipe | Documento do cliente pertence à operação |
| `execucoes_ferramenta` | Compartilhada pela equipe | Rastreabilidade operacional |
| `aprovacoes_operacionais` | Restrita por papel | Decidir exige papel autorizado |
| `notificacoes_operacionais` | Privada do usuário | Cada um vê as suas; administrador/sócio veem todas |
| `eventos_operacionais` | Compartilhada (append-only) | Leitura e inserção; UPDATE/DELETE bloqueados por trigger, inclusive para `service_role` |

## Cadastro (as 26 originais)

| Tabelas | Categoria |
|---|---|
| `empresas`, `pessoas`, `contratos`, `precificacoes`, onboarding etc. | Compartilhada pela equipe |

> ⚠️ **Estado real hoje:** essas 26 tabelas estão **legíveis pela chave `anon`**
> (verificado empiricamente em 2026-08-26). Ver a seção de risco abaixo.

---

## Papéis

| Papel | Aprova memória de empresa/organizacional | Cria usuário | Lê conversa alheia |
|---|:---:|:---:|:---:|
| `administrador` | sim | sim | **não** |
| `socio` | sim | sim | **não** |
| `supervisor` | sim | não | **não** |
| `analista` | não (só propõe) | não | **não** |
| `estagiaria` | não (só propõe) | não | **não** |

---

## Risco aberto: leitura anônima das 26 tabelas

Verificado com a própria chave `anon` do projeto: as 26 tabelas de cadastro
respondem a `SELECT`. Escrita está bloqueada (`42501`), então é exposição de
**leitura** — mas inclui CNPJ, contratos, valores e dados de pessoas.

Hoje isso não é explorável pela web porque nada no navegador usa a chave `anon`.
**Isso muda no momento em que o login for implementado**: o Supabase Auth roda no
cliente com a chave pública, que passa a ser embutida no bundle. A partir daí,
qualquer pessoa que abrir o app consegue extrair a chave e ler tudo.

Correção pronta em
`supabase/revisar-antes-de-aplicar/20260826121000_seguranca_revogacoes_legado.sql`,
com diagnóstico prévio e bloco de reversão. Precisa de decisão porque revoga o
acesso de `anon` — se alguma automação ou script usa essa chave hoje, para de
funcionar.

**Antes de aplicar, responder:** existe hoje alguma aplicação, script ou
automação lendo o banco com a chave `anon`?
