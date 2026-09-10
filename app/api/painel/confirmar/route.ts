import { enfileirarArquivamento } from "@/lib/arquivador/fila";
import { usuarioAtual } from "@/lib/auth/usuario";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * Confirmação em lote.
 *
 * A confirmação é o único momento em que um humano assume o destino proposto,
 * então ela é EXPLÍCITA: a rota exige a lista dos anexos aceitos, e não um
 * "confirma tudo". Quem revisou marcou o que revisou.
 *
 * A validação de verdade acontece na RPC `enfileirar_arquivamento`: proposta
 * vencida, item com conflito, empresa não confirmada ou anexo alterado desde a
 * análise são recusados lá, dentro da transação. Repetir esta chamada com a
 * mesma proposta devolve o mesmo trabalho em vez de duplicar.
 */
export async function POST(request: Request) {
  const usuario = await usuarioAtual();
  if (!usuario) return Response.json({ erro: "Sessão expirada." }, { status: 401 });

  let corpo: { propostaId?: unknown; anexoIds?: unknown; conversaId?: unknown };
  try {
    corpo = await request.json();
  } catch {
    return Response.json({ erro: "Corpo inválido." }, { status: 400 });
  }

  const propostaId = typeof corpo.propostaId === "string" ? corpo.propostaId : null;
  const conversaId = typeof corpo.conversaId === "string" ? corpo.conversaId : null;
  const anexoIds = Array.isArray(corpo.anexoIds)
    ? corpo.anexoIds.filter((v): v is string => typeof v === "string")
    : [];

  if (!propostaId || !conversaId) {
    return Response.json({ erro: "Proposta ou sessão ausente." }, { status: 400 });
  }
  if (anexoIds.length === 0) {
    return Response.json({ erro: "Selecione ao menos um arquivo para arquivar." }, { status: 400 });
  }

  const { data: conversa } = await supabaseAdmin
    .from("conversas_agente")
    .select("id")
    .eq("id", conversaId)
    .eq("usuario_id", usuario.id)
    .maybeSingle();
  if (!conversa) return Response.json({ erro: "Sessão não encontrada." }, { status: 404 });

  try {
    const saida = await enfileirarArquivamento(
      { propostaId, anexosConfirmados: anexoIds, confirmar: true },
      usuario.id,
      conversaId
    );
    return Response.json(saida, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // A mensagem da RPC é escrita para o usuário final ("Refaça a análise",
    // "Confirme qual é a empresa"). Passar adiante é mais útil que trocar por
    // um genérico.
    return Response.json(
      { erro: e instanceof Error ? e.message : "Não foi possível enfileirar." },
      { status: 422 }
    );
  }
}
