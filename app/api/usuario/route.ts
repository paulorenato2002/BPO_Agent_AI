import { usuarioAtualDetalhado } from "@/lib/auth/usuario";

export const dynamic = "force-dynamic";

/** Usuário autenticado, para o rodapé da barra lateral. */
export async function GET() {
  const r = await usuarioAtualDetalhado();

  if (!r.autenticado) {
    const detalhe =
      r.motivo === "inativo"
        ? "Sua conta está desativada."
        : r.motivo === "sem_perfil"
          ? "Sua conta ainda não tem perfil interno."
          : "Sessão expirada.";
    return Response.json(
      { autenticado: false, motivo: r.motivo, detalhe },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  return Response.json(
    { autenticado: true, usuario: r.usuario },
    { headers: { "Cache-Control": "no-store" } }
  );
}
