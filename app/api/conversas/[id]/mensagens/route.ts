import { listarMensagens } from "@/lib/repositorios/conversas";
import { usuarioAtual } from "@/lib/auth/usuario";

export const dynamic = "force-dynamic";

/** Mensagens de uma conversa. A posse é verificada no repositório. */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/conversas/[id]/mensagens">
) {
  const { id } = await ctx.params;
  const usuario = await usuarioAtual();

  const resultado = await listarMensagens(usuario?.id ?? null, id);
  return Response.json(resultado, { headers: { "Cache-Control": "no-store" } });
}
