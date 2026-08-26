import { listarConversas, criarConversa } from "@/lib/repositorios/conversas";
import { usuarioAtual } from "@/lib/auth/usuario";

export const dynamic = "force-dynamic";

/**
 * Histórico de conversas do usuário autenticado.
 *
 * Enquanto não houver autenticação configurada nem as tabelas migradas, estas
 * rotas devolvem `disponivel: false` com o motivo real — a interface mostra o
 * aviso em vez de uma lista vazia enganosa.
 */

export async function GET(request: Request) {
  const usuario = await usuarioAtual();
  const busca = new URL(request.url).searchParams.get("busca") ?? undefined;

  const resultado = await listarConversas(usuario?.id ?? null, busca);
  return Response.json(resultado, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const usuario = await usuarioAtual();
  const corpo = await request.json().catch(() => ({}));
  const titulo = typeof corpo?.titulo === "string" ? corpo.titulo : undefined;

  const resultado = await criarConversa(usuario?.id ?? null, titulo);
  return Response.json(resultado, { status: resultado.disponivel ? 201 : 200 });
}
