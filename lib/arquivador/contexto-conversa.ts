import "server-only";
import { supabaseAdmin } from "../supabase-admin";
import type { ItemAnalisado } from "./analise";

/** Recupera IDs reais inclusive para conversas anteriores à persistência das tools. */
export async function propostasDaConversa(usuarioId: string, conversaId: string) {
  const { data, error } = await supabaseAdmin.from("propostas_arquivamento")
    .select("id,status,expira_em,itens").eq("usuario_id", usuarioId).eq("conversa_id", conversaId)
    .order("created_at", { ascending: false }).limit(5);
  if (error) return null;
  const vistos = new Set<string>();
  return (data ?? []).flatMap(p => {
    const itens = (p.itens as ItemAnalisado[]).filter(i => !vistos.has(i.anexoId));
    itens.forEach(i => vistos.add(i.anexoId));
    if (!itens.length) return [];
    return [{ propostaId: p.id, status: p.status, expiraEm: p.expira_em, itens: itens.map(i => ({
      anexoId: i.anexoId, nome: i.nomeOriginal, status: i.status, empresa: i.empresa,
      competencia: i.competencia, regra: i.regra, destino: i.caminhoSugerido,
      faltantes: i.camposFaltantes, conflitos: i.conflitos,
    })) }];
  });
}
