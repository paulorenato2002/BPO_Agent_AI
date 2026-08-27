import "server-only";
import { supabaseAdmin } from "../supabase-admin";
import { registrarEvento } from "../ferramentas/registro";

/**
 * Repositório de conversas do agente.
 *
 * Usa `supabaseAdmin` (service_role) e filtra por `usuario_id` EXPLICITAMENTE
 * em toda consulta. A service_role ignora RLS, então a checagem de propriedade
 * precisa estar aqui — nunca confiar em id vindo do cliente.
 */

export const LIMITE_CONVERSAS_ATIVAS = 10;

export type PapelMensagem = "usuario" | "agente" | "sistema" | "ferramenta";
export type TipoMensagem = "texto" | "arquivo" | "resultado" | "status" | "erro" | "aprovacao";
export type StatusMensagem = "criada" | "processando" | "concluida" | "erro" | "cancelada";

export type Conversa = {
  id: string;
  titulo: string;
  status: "ativa" | "arquivada" | "excluida";
  iniciadaEm: string;
  ultimaAtividadeEm: string;
  totalMensagens?: number;
};

export type Mensagem = {
  id: string;
  papel: PapelMensagem;
  conteudo: string | null;
  tipoMensagem: TipoMensagem;
  status: StatusMensagem;
  metadados: Record<string, unknown>;
  criadaEm: string;
};

export type Falha = {
  ok: false;
  codigo: "limite_atingido" | "nao_encontrada" | "sem_permissao" | "erro";
  mensagem: string;
};

export type Sucesso<T> = { ok: true; dados: T };
export type Resultado<T> = Sucesso<T> | Falha;

/** O trigger do banco levanta check_violation ao passar de 10 conversas. */
function ehLimiteAtingido(erro: { message: string; code?: string }): boolean {
  return /limite de \d+ conversas ativas/i.test(erro.message);
}

function falha(erro: { message: string; code?: string }): Falha {
  if (ehLimiteAtingido(erro)) {
    return {
      ok: false,
      codigo: "limite_atingido",
      mensagem: `Você atingiu o limite de ${LIMITE_CONVERSAS_ATIVAS} conversas ativas. Arquive uma para abrir outra.`,
    };
  }
  return { ok: false, codigo: "erro", mensagem: erro.message };
}

function mapear(linha: Record<string, unknown>): Conversa {
  return {
    id: linha.id as string,
    titulo: linha.titulo as string,
    status: linha.status as Conversa["status"],
    iniciadaEm: linha.iniciada_em as string,
    ultimaAtividadeEm: linha.ultima_atividade_em as string,
  };
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export async function listarConversas(
  usuarioId: string,
  busca?: string
): Promise<Resultado<Conversa[]>> {
  let query = supabaseAdmin
    .from("conversas_agente")
    .select("id, titulo, status, iniciada_em, ultima_atividade_em")
    .eq("usuario_id", usuarioId)
    .eq("status", "ativa")
    .order("ultima_atividade_em", { ascending: false })
    .limit(LIMITE_CONVERSAS_ATIVAS);

  if (busca?.trim()) query = query.ilike("titulo", `%${busca.trim()}%`);

  const { data, error } = await query;
  if (error) return falha(error);
  return { ok: true, dados: (data ?? []).map(mapear) };
}

export async function contarAtivas(usuarioId: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("conversas_agente")
    .select("*", { count: "exact", head: true })
    .eq("usuario_id", usuarioId)
    .eq("status", "ativa");
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Criação
// ---------------------------------------------------------------------------

/**
 * Cria uma conversa — ou REUTILIZA um chat vazio que o usuário já tenha.
 *
 * Sem isso, clicar em "Novo chat" repetidamente enche o histórico de conversas
 * vazias e consome o limite de 10 à toa.
 */
export async function criarOuReutilizarConversa(
  usuarioId: string,
  titulo = "Nova conversa"
): Promise<Resultado<Conversa & { reutilizada: boolean }>> {
  // Procura uma conversa ativa sem nenhuma mensagem.
  const { data: candidatas } = await supabaseAdmin
    .from("conversas_agente")
    .select("id, titulo, status, iniciada_em, ultima_atividade_em, mensagens_agente(id)")
    .eq("usuario_id", usuarioId)
    .eq("status", "ativa")
    .order("ultima_atividade_em", { ascending: false })
    .limit(LIMITE_CONVERSAS_ATIVAS);

  const vazia = (candidatas ?? []).find(
    (c) => ((c.mensagens_agente as unknown[]) ?? []).length === 0
  );

  if (vazia) {
    return { ok: true, dados: { ...mapear(vazia), reutilizada: true } };
  }

  const { data, error } = await supabaseAdmin
    .from("conversas_agente")
    .insert({ usuario_id: usuarioId, titulo })
    .select("id, titulo, status, iniciada_em, ultima_atividade_em")
    .single();

  if (error) return falha(error);

  await registrarEvento({
    tipoEvento: "conversa_criada",
    descricao: "Nova conversa iniciada.",
    usuarioId,
    entidadeTipo: "conversas_agente",
    entidadeId: data.id as string,
  });

  return { ok: true, dados: { ...mapear(data), reutilizada: false } };
}

// ---------------------------------------------------------------------------
// Alteração
// ---------------------------------------------------------------------------

export async function renomearConversa(
  usuarioId: string,
  conversaId: string,
  titulo: string
): Promise<Resultado<true>> {
  const { data, error } = await supabaseAdmin
    .from("conversas_agente")
    .update({ titulo })
    .eq("id", conversaId)
    .eq("usuario_id", usuarioId)
    .select("id");

  if (error) return falha(error);
  if (!data?.length) {
    return { ok: false, codigo: "nao_encontrada", mensagem: "Conversa não encontrada." };
  }
  return { ok: true, dados: true };
}

/** Arquivamento — preferido à exclusão física; libera espaço no limite. */
export async function arquivarConversa(
  usuarioId: string,
  conversaId: string
): Promise<Resultado<true>> {
  const { data, error } = await supabaseAdmin
    .from("conversas_agente")
    .update({ status: "arquivada", arquivada_em: new Date().toISOString() })
    .eq("id", conversaId)
    .eq("usuario_id", usuarioId)
    .select("id");

  if (error) return falha(error);
  if (!data?.length) {
    return { ok: false, codigo: "nao_encontrada", mensagem: "Conversa não encontrada." };
  }

  await registrarEvento({
    tipoEvento: "conversa_arquivada",
    descricao: "Conversa arquivada pelo usuário.",
    usuarioId,
    entidadeTipo: "conversas_agente",
    entidadeId: conversaId,
  });

  return { ok: true, dados: true };
}

/** Restaurar valida o limite de novo — o trigger recusa se não couber. */
export async function restaurarConversa(
  usuarioId: string,
  conversaId: string
): Promise<Resultado<true>> {
  const { data, error } = await supabaseAdmin
    .from("conversas_agente")
    .update({ status: "ativa", arquivada_em: null })
    .eq("id", conversaId)
    .eq("usuario_id", usuarioId)
    .select("id");

  if (error) return falha(error);
  if (!data?.length) {
    return { ok: false, codigo: "nao_encontrada", mensagem: "Conversa não encontrada." };
  }
  return { ok: true, dados: true };
}

// ---------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------

/** Confirma que a conversa é do usuário antes de qualquer leitura/escrita. */
export async function conversaPertenceAoUsuario(
  usuarioId: string,
  conversaId: string
): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("conversas_agente")
    .select("id")
    .eq("id", conversaId)
    .eq("usuario_id", usuarioId)
    .maybeSingle();
  return Boolean(data);
}

export async function listarMensagens(
  usuarioId: string,
  conversaId: string
): Promise<Resultado<Mensagem[]>> {
  if (!(await conversaPertenceAoUsuario(usuarioId, conversaId))) {
    return { ok: false, codigo: "sem_permissao", mensagem: "Conversa não encontrada." };
  }

  const { data, error } = await supabaseAdmin
    .from("mensagens_agente")
    .select("id, papel, conteudo, tipo_mensagem, status, metadados, created_at")
    .eq("conversa_id", conversaId)
    // `sequencia` garante ordem estável; created_at pode empatar.
    .order("sequencia", { ascending: true });

  if (error) return falha(error);

  return {
    ok: true,
    dados: (data ?? []).map((m) => ({
      id: m.id as string,
      papel: m.papel as PapelMensagem,
      conteudo: m.conteudo as string | null,
      tipoMensagem: m.tipo_mensagem as TipoMensagem,
      status: m.status as StatusMensagem,
      metadados: (m.metadados ?? {}) as Record<string, unknown>,
      criadaEm: m.created_at as string,
    })),
  };
}

export async function salvarMensagem(
  conversaId: string,
  mensagem: {
    papel: PapelMensagem;
    conteudo: string | null;
    tipoMensagem?: TipoMensagem;
    status?: StatusMensagem;
    metadados?: Record<string, unknown>;
  }
): Promise<Resultado<string>> {
  const { data, error } = await supabaseAdmin
    .from("mensagens_agente")
    .insert({
      conversa_id: conversaId,
      papel: mensagem.papel,
      conteudo: mensagem.conteudo,
      tipo_mensagem: mensagem.tipoMensagem ?? "texto",
      status: mensagem.status ?? "concluida",
      metadados: mensagem.metadados ?? {},
    })
    .select("id")
    .single();

  if (error) return falha(error);
  return { ok: true, dados: data.id as string };
}

export async function atualizarMensagem(
  mensagemId: string,
  campos: {
    conteudo?: string | null;
    status?: StatusMensagem;
    tipoMensagem?: TipoMensagem;
    metadados?: Record<string, unknown>;
  }
): Promise<void> {
  const atualizacao: Record<string, unknown> = {};
  if (campos.conteudo !== undefined) atualizacao.conteudo = campos.conteudo;
  if (campos.status) atualizacao.status = campos.status;
  if (campos.tipoMensagem) atualizacao.tipo_mensagem = campos.tipoMensagem;
  if (campos.metadados) atualizacao.metadados = campos.metadados;

  const { error } = await supabaseAdmin
    .from("mensagens_agente")
    .update(atualizacao)
    .eq("id", mensagemId);

  if (error) {
    console.error(`[conversas] falha ao atualizar mensagem ${mensagemId}: ${error.message}`);
  }
}

/**
 * Título curto derivado da primeira mensagem.
 *
 * Sem IA de propósito: gerar título por modelo custa uma chamada extra e atrasa
 * a resposta. O usuário pode renomear a qualquer momento.
 */
export function derivarTitulo(primeiraMensagem: string): string {
  const limpo = primeiraMensagem
    .replace(/\[Arquivo anexado[^\]]*\][\s\S]*?(?=\n\n|$)/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!limpo) return "Nova conversa";
  if (limpo.length <= 48) return limpo;

  const corte = limpo.slice(0, 48);
  const ultimoEspaco = corte.lastIndexOf(" ");
  return (ultimoEspaco > 24 ? corte.slice(0, ultimoEspaco) : corte) + "…";
}

/** Define o título a partir da primeira mensagem, se ainda for o padrão. */
export async function definirTituloSeNecessario(
  conversaId: string,
  primeiraMensagem: string
): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("conversas_agente")
    .select("titulo")
    .eq("id", conversaId)
    .maybeSingle();

  if (!data || data.titulo !== "Nova conversa") return null;

  const titulo = derivarTitulo(primeiraMensagem);
  await supabaseAdmin.from("conversas_agente").update({ titulo }).eq("id", conversaId);
  return titulo;
}
