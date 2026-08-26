import "server-only";
import { supabaseAdmin } from "../supabase-admin";

/**
 * Repositório de conversas do agente.
 *
 * DEGRADAÇÃO HONESTA: as tabelas `conversas_agente` / `mensagens_agente` só
 * existem depois que as migrations forem aplicadas (ver docs/aplicar_migrations.md).
 * Enquanto isso, este módulo não finge — devolve `disponivel: false` com o
 * motivo real, e a interface mostra isso ao usuário em vez de uma lista vazia
 * que pareceria "sem conversas ainda".
 */

/** PostgREST usa este código quando a tabela não existe no schema exposto. */
const CODIGO_TABELA_INEXISTENTE = "PGRST205";

export type PapelMensagem = "usuario" | "agente" | "sistema" | "ferramenta";
export type TipoMensagem = "texto" | "arquivo" | "resultado" | "status" | "erro" | "aprovacao";

export type Conversa = {
  id: string;
  titulo: string;
  status: "ativa" | "arquivada" | "excluida";
  iniciadaEm: string;
  ultimaAtividadeEm: string;
};

export type Mensagem = {
  id: string;
  papel: PapelMensagem;
  conteudo: string | null;
  tipoMensagem: TipoMensagem;
  metadados: Record<string, unknown>;
  criadaEm: string;
};

export type MotivoIndisponivel = "banco_nao_migrado" | "sem_autenticacao" | "erro";

export type Resultado<T> =
  | { disponivel: true; dados: T }
  | { disponivel: false; motivo: MotivoIndisponivel; detalhe: string };

function indisponivel(erro: { code?: string; message: string }): Resultado<never> {
  if (erro.code === CODIGO_TABELA_INEXISTENTE) {
    return {
      disponivel: false,
      motivo: "banco_nao_migrado",
      detalhe:
        "As tabelas de conversa ainda não existem. Aplique as migrations (docs/aplicar_migrations.md).",
    };
  }
  return { disponivel: false, motivo: "erro", detalhe: erro.message };
}

const SEM_AUTENTICACAO: Resultado<never> = {
  disponivel: false,
  motivo: "sem_autenticacao",
  detalhe: "Nenhum usuário autenticado. O histórico é individual por usuário.",
};

export async function listarConversas(
  usuarioId: string | null,
  busca?: string
): Promise<Resultado<Conversa[]>> {
  if (!usuarioId) return SEM_AUTENTICACAO;

  let query = supabaseAdmin
    .from("conversas_agente")
    .select("id, titulo, status, iniciada_em, ultima_atividade_em")
    .eq("usuario_id", usuarioId)
    .eq("status", "ativa")
    .order("ultima_atividade_em", { ascending: false })
    .limit(100);

  if (busca?.trim()) {
    // ilike é suficiente para busca por título na barra lateral.
    query = query.ilike("titulo", `%${busca.trim()}%`);
  }

  const { data, error } = await query;
  if (error) return indisponivel(error);

  return {
    disponivel: true,
    dados: (data ?? []).map((c) => ({
      id: c.id as string,
      titulo: c.titulo as string,
      status: c.status as Conversa["status"],
      iniciadaEm: c.iniciada_em as string,
      ultimaAtividadeEm: c.ultima_atividade_em as string,
    })),
  };
}

export async function criarConversa(
  usuarioId: string | null,
  titulo = "Nova conversa"
): Promise<Resultado<Conversa>> {
  if (!usuarioId) return SEM_AUTENTICACAO;

  const { data, error } = await supabaseAdmin
    .from("conversas_agente")
    .insert({ usuario_id: usuarioId, titulo })
    .select("id, titulo, status, iniciada_em, ultima_atividade_em")
    .single();

  if (error) return indisponivel(error);
  return {
    disponivel: true,
    dados: {
      id: data.id as string,
      titulo: data.titulo as string,
      status: data.status as Conversa["status"],
      iniciadaEm: data.iniciada_em as string,
      ultimaAtividadeEm: data.ultima_atividade_em as string,
    },
  };
}

export async function renomearConversa(
  usuarioId: string | null,
  conversaId: string,
  titulo: string
): Promise<Resultado<true>> {
  if (!usuarioId) return SEM_AUTENTICACAO;

  const { error } = await supabaseAdmin
    .from("conversas_agente")
    .update({ titulo })
    // Filtro por usuário mesmo usando service_role: a chave ignora RLS, então a
    // checagem de dono precisa ser explícita aqui.
    .eq("id", conversaId)
    .eq("usuario_id", usuarioId);

  if (error) return indisponivel(error);
  return { disponivel: true, dados: true };
}

/** Arquivamento é preferido à exclusão física. */
export async function arquivarConversa(
  usuarioId: string | null,
  conversaId: string
): Promise<Resultado<true>> {
  if (!usuarioId) return SEM_AUTENTICACAO;

  const { error } = await supabaseAdmin
    .from("conversas_agente")
    .update({ status: "arquivada", arquivada_em: new Date().toISOString() })
    .eq("id", conversaId)
    .eq("usuario_id", usuarioId);

  if (error) return indisponivel(error);
  return { disponivel: true, dados: true };
}

export async function listarMensagens(
  usuarioId: string | null,
  conversaId: string
): Promise<Resultado<Mensagem[]>> {
  if (!usuarioId) return SEM_AUTENTICACAO;

  // Confirma a posse da conversa antes de devolver qualquer mensagem.
  const { data: dono, error: erroDono } = await supabaseAdmin
    .from("conversas_agente")
    .select("id")
    .eq("id", conversaId)
    .eq("usuario_id", usuarioId)
    .maybeSingle();

  if (erroDono) return indisponivel(erroDono);
  if (!dono) {
    return { disponivel: false, motivo: "erro", detalhe: "Conversa não encontrada." };
  }

  const { data, error } = await supabaseAdmin
    .from("mensagens_agente")
    .select("id, papel, conteudo, tipo_mensagem, metadados, created_at")
    .eq("conversa_id", conversaId)
    .order("sequencia", { ascending: true });

  if (error) return indisponivel(error);

  return {
    disponivel: true,
    dados: (data ?? []).map((m) => ({
      id: m.id as string,
      papel: m.papel as PapelMensagem,
      conteudo: m.conteudo as string | null,
      tipoMensagem: m.tipo_mensagem as TipoMensagem,
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
    metadados?: Record<string, unknown>;
    documentoId?: string | null;
  }
): Promise<Resultado<string>> {
  const { data, error } = await supabaseAdmin
    .from("mensagens_agente")
    .insert({
      conversa_id: conversaId,
      papel: mensagem.papel,
      conteudo: mensagem.conteudo,
      tipo_mensagem: mensagem.tipoMensagem ?? "texto",
      metadados: mensagem.metadados ?? {},
      documento_id: mensagem.documentoId ?? null,
    })
    .select("id")
    .single();

  if (error) return indisponivel(error);
  return { disponivel: true, dados: data.id as string };
}

/**
 * Título curto derivado da primeira mensagem.
 *
 * Deliberadamente sem IA: gerar título por modelo custa uma chamada extra e
 * atrasa a resposta. O usuário pode renomear.
 */
export function derivarTitulo(primeiraMensagem: string): string {
  const limpo = primeiraMensagem
    .replace(/\[Arquivo anexado[^\]]*\]/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!limpo) return "Nova conversa";
  if (limpo.length <= 48) return limpo;

  const corte = limpo.slice(0, 48);
  const ultimoEspaco = corte.lastIndexOf(" ");
  return (ultimoEspaco > 24 ? corte.slice(0, ultimoEspaco) : corte) + "…";
}
