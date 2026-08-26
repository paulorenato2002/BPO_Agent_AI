import { usuarioAtual } from "@/lib/auth/usuario";

export const dynamic = "force-dynamic";

/**
 * Usuário autenticado para o rodapé da barra lateral.
 *
 * Devolve `autenticado: false` quando não há sessão — a interface mostra esse
 * estado real em vez de um nome fictício.
 */
export async function GET() {
  const usuario = await usuarioAtual();

  if (!usuario) {
    return Response.json(
      {
        autenticado: false,
        detalhe:
          "Nenhuma sessão ativa. Crie usuários em Authentication › Users e vincule em perfis_usuarios.",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  return Response.json(
    { autenticado: true, usuario },
    { headers: { "Cache-Control": "no-store" } }
  );
}
