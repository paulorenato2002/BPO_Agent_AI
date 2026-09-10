import { usuarioAtual } from "@/lib/auth/usuario";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * Empresas e regras para os campos de correção do painel.
 *
 * Sem isto, corrigir uma empresa exigiria digitar um UUID. O painel precisa
 * oferecer a lista — e a lista tem de vir do banco, nunca de um arquivo
 * estático que envelhece sem avisar.
 *
 * Só vai o necessário para escolher e exibir. CNPJ não é enviado: a tela não
 * mostra e não há motivo para expor a carteira inteira ao navegador.
 */
export async function GET() {
  const usuario = await usuarioAtual();
  if (!usuario) return Response.json({ erro: "Sessão expirada." }, { status: 401 });

  const [empresas, regras, mapa] = await Promise.all([
    supabaseAdmin
      .from("empresas")
      .select("id,codigo,razao_social,nome_fantasia,ativo")
      .eq("ativo", true)
      .order("codigo"),
    supabaseAdmin
      .from("regras_arquivamento")
      .select("codigo,nome,escopo,exige_competencia,exige_instituicao")
      .eq("ativo", true)
      .order("codigo"),
    // Quantos clientes já têm pasta conhecida. É o sinal de que o computador
    // responsável passou por aqui; sem isso o painel aceitaria arquivos que
    // nunca teriam destino.
    supabaseAdmin
      .from("empresa_pastas")
      .select("empresa_id,nome_pasta,container,conferido_em"),
  ]);

  if (empresas.error || regras.error) {
    return Response.json({ erro: "Não foi possível carregar o cadastro." }, { status: 503 });
  }

  const pastas = (mapa.data ?? []) as { empresa_id: string; nome_pasta: string; conferido_em: string }[];
  const porEmpresa = new Map(pastas.map((p) => [p.empresa_id, p]));
  const conferidoEm = pastas
    .map((p) => p.conferido_em)
    .sort()
    .at(-1) ?? null;

  return Response.json(
    {
      empresas: (empresas.data ?? []).map((e) => ({
        ...e,
        pasta: porEmpresa.get(e.id as string)?.nome_pasta ?? null,
      })),
      regras: regras.data ?? [],
      mapa: {
        // `null` quando a migration do mapa ainda não foi aplicada: o painel
        // avisa em vez de deixar o usuário descobrir no erro de cada arquivo.
        disponivel: !mapa.error,
        pastasConhecidas: pastas.length,
        conferidoEm,
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
