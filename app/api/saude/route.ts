import { supabaseAdmin } from "@/lib/supabase-admin";
import { supabaseStorage } from "@/lib/storage/supabase-storage";
import { googleDrive } from "@/lib/storage/google-drive";

export const dynamic = "force-dynamic";

/**
 * Health check REAL das integrações.
 *
 * Cada item é efetivamente consultado. Nada aqui é estático — se o Drive não
 * tem credencial, ele aparece como "não configurado", nunca como "conectado".
 */

export type EstadoIntegracao = "conectado" | "indisponivel" | "nao_configurado";

export type ItemSaude = {
  chave: string;
  nome: string;
  estado: EstadoIntegracao;
  detalhe: string;
};

async function checarBanco(): Promise<ItemSaude> {
  const base = { chave: "banco", nome: "Supabase" };
  try {
    // `empresas` existe desde antes desta camada — serve de ping do schema.
    const { error } = await supabaseAdmin.from("empresas").select("id").limit(1);
    if (error) {
      return { ...base, estado: "indisponivel", detalhe: error.message };
    }

    // As tabelas novas existem? Muda o que a interface consegue oferecer.
    const { error: erroConversas } = await supabaseAdmin
      .from("conversas_agente")
      .select("id")
      .limit(1);

    if (erroConversas?.code === "PGRST205") {
      return {
        ...base,
        estado: "indisponivel",
        detalhe: "Conectado, mas a camada operacional ainda não foi migrada.",
      };
    }
    return { ...base, estado: "conectado", detalhe: "Banco e camada operacional disponíveis." };
  } catch (e) {
    return {
      ...base,
      estado: "indisponivel",
      detalhe: e instanceof Error ? e.message : String(e),
    };
  }
}

function traduzir(
  chave: string,
  nome: string,
  r: { configurado: boolean; disponivel: boolean; detalhe: string }
): ItemSaude {
  if (!r.configurado) return { chave, nome, estado: "nao_configurado", detalhe: r.detalhe };
  return {
    chave,
    nome,
    estado: r.disponivel ? "conectado" : "indisponivel",
    detalhe: r.detalhe,
  };
}

export async function GET() {
  const [banco, storage, drive] = await Promise.all([
    checarBanco(),
    supabaseStorage.healthCheck(),
    googleDrive.healthCheck(),
  ]);

  const itens: ItemSaude[] = [
    banco,
    traduzir("storage", "Supabase Storage", storage),
    traduzir("drive", "Google Drive", drive),
  ];

  return Response.json(
    { itens, verificadoEm: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
