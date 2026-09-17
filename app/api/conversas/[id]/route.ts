import { usuarioAtual } from "@/lib/auth/usuario";
import {
  renomearConversa,
  arquivarConversa,
  excluirConversa,
  restaurarConversa,
} from "@/lib/repositorios/conversas";

export const dynamic = "force-dynamic";

const SEM_SESSAO = Response.json(
  { ok: false, codigo: "sem_sessao", mensagem: "Sessão expirada." },
  { status: 401 }
);

/** Renomear, ou restaurar uma conversa arquivada. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/conversas/[id]">) {
  const usuario = await usuarioAtual();
  if (!usuario) return SEM_SESSAO;

  const { id } = await ctx.params;
  const corpo = await request.json().catch(() => ({}));

  if (corpo?.acao === "restaurar") {
    const r = await restaurarConversa(usuario.id, id);
    // Restaurar revalida o limite de 10 — pode não caber.
    return Response.json(r, {
      status: r.ok ? 200 : r.codigo === "limite_atingido" ? 409 : 400,
    });
  }

  const titulo = typeof corpo?.titulo === "string" ? corpo.titulo.trim() : "";
  if (!titulo) {
    return Response.json(
      { ok: false, codigo: "erro", mensagem: "Título não pode ser vazio." },
      { status: 400 }
    );
  }

  const r = await renomearConversa(usuario.id, id, titulo.slice(0, 120));
  return Response.json(r, { status: r.ok ? 200 : 404 });
}

/**
 * Arquiva ou exclui. Nos dois casos a conversa sai da lista e do agente; o
 * registro continua no banco, que é o que o schema chama de exclusão lógica.
 * `?modo=excluir` é a exclusão pedida pelo usuário.
 */
export async function DELETE(request: Request, ctx: RouteContext<"/api/conversas/[id]">) {
  const usuario = await usuarioAtual();
  if (!usuario) return SEM_SESSAO;

  const { id } = await ctx.params;
  const modo = new URL(request.url).searchParams.get("modo");
  const r = modo === "excluir"
    ? await excluirConversa(usuario.id, id)
    : await arquivarConversa(usuario.id, id);
  return Response.json(r, { status: r.ok ? 200 : 404 });
}
