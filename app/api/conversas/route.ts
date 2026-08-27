import { usuarioAtual } from "@/lib/auth/usuario";
import {
  listarConversas,
  criarOuReutilizarConversa,
  contarAtivas,
  LIMITE_CONVERSAS_ATIVAS,
} from "@/lib/repositorios/conversas";

export const dynamic = "force-dynamic";

const SEM_SESSAO = Response.json(
  { ok: false, codigo: "sem_sessao", mensagem: "Sessão expirada." },
  { status: 401 }
);

export async function GET(request: Request) {
  const usuario = await usuarioAtual();
  if (!usuario) return SEM_SESSAO;

  const busca = new URL(request.url).searchParams.get("busca") ?? undefined;
  const resultado = await listarConversas(usuario.id, busca);
  if (!resultado.ok) return Response.json(resultado, { status: 500 });

  return Response.json(
    {
      ok: true,
      dados: resultado.dados,
      ativas: await contarAtivas(usuario.id),
      limite: LIMITE_CONVERSAS_ATIVAS,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * Cria uma conversa REAL no banco e devolve o id verdadeiro.
 *
 * Nunca devolve id temporário: se a criação falhar, o cliente recebe o erro e
 * não mostra no histórico uma conversa que não existe.
 */
export async function POST(request: Request) {
  const usuario = await usuarioAtual();
  if (!usuario) return SEM_SESSAO;

  const corpo = await request.json().catch(() => ({}));
  const titulo = typeof corpo?.titulo === "string" ? corpo.titulo : undefined;

  const resultado = await criarOuReutilizarConversa(usuario.id, titulo);

  if (!resultado.ok) {
    // Limite atingido não é erro de servidor: é uma decisão que cabe ao usuário.
    const status = resultado.codigo === "limite_atingido" ? 409 : 500;
    return Response.json(resultado, { status });
  }

  return Response.json({ ok: true, dados: resultado.dados }, { status: 201 });
}
