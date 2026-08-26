import { renomearConversa, arquivarConversa } from "@/lib/repositorios/conversas";
import { usuarioAtual } from "@/lib/auth/usuario";

export const dynamic = "force-dynamic";

/** Renomear a conversa. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/conversas/[id]">) {
  const { id } = await ctx.params;
  const usuario = await usuarioAtual();
  const corpo = await request.json().catch(() => ({}));

  const titulo = typeof corpo?.titulo === "string" ? corpo.titulo.trim() : "";
  if (!titulo) {
    return Response.json(
      { disponivel: false, motivo: "erro", detalhe: "Título não pode ser vazio." },
      { status: 400 }
    );
  }

  const resultado = await renomearConversa(usuario?.id ?? null, id, titulo.slice(0, 120));
  return Response.json(resultado);
}

/**
 * Arquivar a conversa.
 *
 * Deliberadamente NÃO é exclusão física: o histórico operacional é preservado.
 */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/conversas/[id]">) {
  const { id } = await ctx.params;
  const usuario = await usuarioAtual();

  const resultado = await arquivarConversa(usuario?.id ?? null, id);
  return Response.json(resultado);
}
