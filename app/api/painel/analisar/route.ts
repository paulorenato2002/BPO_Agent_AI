import { analisarDocumentos, type CorrecaoUsuario } from "@/lib/arquivador/analise";
import { portasAnalisePadrao } from "@/lib/arquivador/portas-analise";
import { usuarioAtual } from "@/lib/auth/usuario";
import { criarOuReutilizarConversa } from "@/lib/repositorios/conversas";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * Análise em lote para o painel.
 *
 * Não reimplementa nada: chama o MESMO `analisarDocumentos` que o chat usa.
 * Se a regra de identificação de empresa mudar, muda para os dois — duas
 * implementações da mesma decisão acabariam divergindo, e um documento
 * arquivado pelo painel iria para um lugar diferente do arquivado pelo chat.
 *
 * A proposta exige uma conversa: é ela que amarra o pedido ao usuário e dá
 * rastro de auditoria. O painel usa uma conversa própria, criada na hora.
 */
export async function POST(request: Request) {
  const usuario = await usuarioAtual();
  if (!usuario) return Response.json({ erro: "Sessão expirada." }, { status: 401 });

  let corpo: { anexoIds?: unknown; correcoes?: unknown; conversaId?: unknown };
  try {
    corpo = await request.json();
  } catch {
    return Response.json({ erro: "Corpo inválido." }, { status: 400 });
  }

  const anexoIds = Array.isArray(corpo.anexoIds)
    ? corpo.anexoIds.filter((v): v is string => typeof v === "string")
    : [];
  if (anexoIds.length === 0) {
    return Response.json({ erro: "Nenhum arquivo para analisar." }, { status: 400 });
  }

  // Reaproveita a conversa do painel enquanto ela existir; só cria outra
  // quando o usuário abre uma sessão nova.
  let conversaId = typeof corpo.conversaId === "string" ? corpo.conversaId : null;
  if (conversaId) {
    const { data } = await supabaseAdmin
      .from("conversas_agente")
      .select("id")
      .eq("id", conversaId)
      .eq("usuario_id", usuario.id)
      .maybeSingle();
    if (!data) conversaId = null;
  }
  if (!conversaId) {
    const nova = await criarOuReutilizarConversa(usuario.id, "Arquivamento em lote");
    if (!nova.ok) return Response.json({ erro: "Não foi possível abrir a sessão." }, { status: 503 });
    conversaId = nova.dados.id;
  }

  const correcoes = (
    corpo.correcoes && typeof corpo.correcoes === "object" ? corpo.correcoes : {}
  ) as Record<string, CorrecaoUsuario>;

  const resultado = await analisarDocumentos(
    { anexoIds, correcoes, conversaId },
    usuario.id,
    portasAnalisePadrao()
  );

  if (!resultado.ok) {
    return Response.json({ erro: resultado.erro, codigo: resultado.codigo }, { status: 422 });
  }

  return Response.json(
    { conversaId, proposta: resultado.proposta },
    { headers: { "Cache-Control": "no-store" } }
  );
}
