import { usuarioAtual } from "@/lib/auth/usuario";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const usuario = await usuarioAtual();
  if (!usuario) return Response.json({ erro: "Sessão expirada." }, { status: 401 });
  // Os modos síncronos respondem no próprio chat e não dependem da migration da fila.
  if (process.env.ARQUIVAMENTO_DESTINO === "local" || process.env.ARQUIVAMENTO_DESTINO === "google_drive") {
    return Response.json({ itens: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  const conversa = new URL(request.url).searchParams.get("conversaId");
  if (!conversa || !/^[0-9a-f-]{36}$/i.test(conversa)) {
    return Response.json({ erro: "Conversa inválida." }, { status: 400 });
  }
  const { data, error } = await supabaseAdmin.from("fila_arquivamento")
    .select("id,nome_original,status,erro,resultado,created_at,iniciado_em,atualizado_em")
    .eq("usuario_id", usuario.id).eq("conversa_id", conversa)
    .order("created_at", { ascending: false }).limit(100);
  if (error) return Response.json({ erro: "Não foi possível consultar os arquivamentos." }, { status: 503 });
  return Response.json({ itens: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
}
