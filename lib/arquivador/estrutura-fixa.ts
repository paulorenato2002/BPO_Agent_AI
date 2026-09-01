import "server-only";
import { supabaseAdmin } from "../supabase-admin";

/**
 * Leitura da estrutura fixa do Drive (`estrutura_fixa_drive`).
 *
 * Separado do núcleo puro porque toca o banco. O ponto aqui é que nenhum
 * caminho fica hardcoded no código: os nomes das pastas vivem no banco e são
 * encontrados por CHAVE, não por posição nem por texto literal.
 */

export type PastaFixa = {
  chave: string;
  caminho_modelo: string[];
  descricao: string | null;
  ordem: number;
};

/** Chaves dos contêineres de cliente. A pasta de empresa vive dentro de um. */
export const CHAVE_CLIENTES_ATIVOS = "clientes_ativos";
export const CHAVE_CLIENTES_INATIVOS = "clientes_inativos";

/** Toda a estrutura fixa ativa, na ordem de criação. */
export async function listarEstruturaFixa(): Promise<PastaFixa[]> {
  const { data, error } = await supabaseAdmin
    .from("estrutura_fixa_drive")
    .select("chave,caminho_modelo,descricao,ordem")
    .eq("ativo", true)
    .order("ordem");

  if (error) throw new Error(`Falha ao ler estrutura_fixa_drive: ${error.message}`);
  return (data ?? []) as PastaFixa[];
}

/** Uma pasta fixa pela chave. Devolve null se não estiver cadastrada. */
export async function buscarPastaFixa(chave: string): Promise<PastaFixa | null> {
  const { data, error } = await supabaseAdmin
    .from("estrutura_fixa_drive")
    .select("chave,caminho_modelo,descricao,ordem")
    .eq("chave", chave)
    .eq("ativo", true)
    .maybeSingle();

  if (error) throw new Error(`Falha ao ler estrutura_fixa_drive: ${error.message}`);
  return (data as PastaFixa | null) ?? null;
}

/**
 * Nome do contêiner onde a pasta de uma empresa deve ficar.
 *
 * Recebe `empresas.ativo` explicitamente — não existe padrão. Assumir "ativo"
 * quando a informação falta arquivaria documento de cliente inativo no lugar
 * errado, e em silêncio, que é o pior jeito de errar.
 */
export async function nomePastaClientes(empresaAtiva: boolean): Promise<string> {
  const chave = empresaAtiva ? CHAVE_CLIENTES_ATIVOS : CHAVE_CLIENTES_INATIVOS;
  const pasta = await buscarPastaFixa(chave);

  if (!pasta) {
    throw new Error(
      `A estrutura fixa "${chave}" não está cadastrada em estrutura_fixa_drive. ` +
        "Aplique a migration da estrutura fixa antes de arquivar."
    );
  }

  // O contêiner é um caminho de um nível só; o nome é o último segmento.
  const nome = pasta.caminho_modelo[pasta.caminho_modelo.length - 1];
  if (!nome) {
    throw new Error(`A estrutura fixa "${chave}" está cadastrada com caminho vazio.`);
  }

  return nome;
}
