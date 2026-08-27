import { usuarioAtual } from "@/lib/auth/usuario";
import { listarMensagens } from "@/lib/repositorios/conversas";

export const dynamic = "force-dynamic";

/** Mensagens de uma conversa. A propriedade é validada no repositório. */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/conversas/[id]/mensagens">
) {
  const usuario = await usuarioAtual();
  if (!usuario) {
    return Response.json(
      { ok: false, codigo: "sem_sessao", mensagem: "Sessão expirada." },
      { status: 401 }
    );
  }

  const { id } = await ctx.params;
  const r = await listarMensagens(usuario.id, id);
  return Response.json(r, {
    status: r.ok ? 200 : r.codigo === "sem_permissao" ? 404 : 500,
    headers: { "Cache-Control": "no-store" },
  });
}
