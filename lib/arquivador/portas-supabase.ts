import "server-only";
import { supabaseAdmin } from "../supabase-admin";
import { googleDrive } from "../storage/google-drive";
import type { SegmentoDestino } from "./caminhos";
import type { LinhaPasta, PortasResolvedor } from "./resolvedor-pastas";

/**
 * Ligação do resolvedor de pastas com o mundo real: Supabase e Google Drive.
 *
 * Fica separado de `resolvedor-pastas.ts` de propósito. Importar
 * `supabase-admin` exige credenciais no ambiente já na carga do módulo; se o
 * algoritmo dependesse disso, não daria para testá-lo sem .env — e é o
 * algoritmo que precisa de teste.
 */

const PROVEDOR = "google_drive";
const COLUNAS = "id,chave_logica,external_id,nome,caminho_logico,status";

/** 23505 = unique_violation. É corrida esperada, não defeito. */
const UNIQUE_VIOLATION = "23505";

async function buscarMapeamento(chaveLogica: string): Promise<LinhaPasta | null> {
  const { data, error } = await supabaseAdmin
    .from("pastas_drive")
    .select(COLUNAS)
    .eq("provedor", PROVEDOR)
    .eq("chave_logica", chaveLogica)
    .maybeSingle();

  if (error) throw new Error(`Falha ao consultar pastas_drive: ${error.message}`);
  return (data as LinhaPasta | null) ?? null;
}

async function inserirMapeamento(dados: {
  segmento: SegmentoDestino;
  externalId: string;
  parentExternalId: string;
  pastaPaiId: string | null;
  empresaId: string | null;
}): Promise<{ linha: LinhaPasta; conflito: false } | { conflito: true }> {
  const { segmento, externalId, parentExternalId, pastaPaiId, empresaId } = dados;

  const { data, error } = await supabaseAdmin
    .from("pastas_drive")
    .insert({
      provedor: PROVEDOR,
      escopo: segmento.escopo,
      // Só pasta de empresa carrega empresa_id — é o que o CHECK exige.
      empresa_id: segmento.escopo === "empresa" ? empresaId : null,
      chave_logica: segmento.chaveLogica,
      pasta_pai_id: pastaPaiId,
      external_id: externalId,
      parent_external_id: parentExternalId,
      nome: segmento.nome,
      caminho_logico: segmento.caminhoLogico,
      status: "ativa",
      verificada_em: new Date().toISOString(),
    })
    .select(COLUNAS)
    .single();

  if (!error && data) return { linha: data as LinhaPasta, conflito: false };
  if (error && error.code === UNIQUE_VIOLATION) return { conflito: true };

  throw new Error(`Falha ao gravar pastas_drive: ${error?.message ?? "erro desconhecido"}`);
}

async function reapontarMapeamento(dados: {
  id: string;
  segmento: SegmentoDestino;
  externalId: string;
  parentExternalId: string;
  pastaPaiId: string | null;
}): Promise<LinhaPasta> {
  const { id, segmento, externalId, parentExternalId, pastaPaiId } = dados;

  const { data, error } = await supabaseAdmin
    .from("pastas_drive")
    .update({
      external_id: externalId,
      parent_external_id: parentExternalId,
      pasta_pai_id: pastaPaiId,
      nome: segmento.nome,
      caminho_logico: segmento.caminhoLogico,
      status: "ativa",
      erro_mensagem: null,
      verificada_em: new Date().toISOString(),
    })
    .eq("id", id)
    .select(COLUNAS)
    .single();

  if (error) throw new Error(`Falha ao reativar pastas_drive: ${error.message}`);
  return data as LinhaPasta;
}

/**
 * Registra uma pasta órfã de corrida: criamos, mas outra execução venceu.
 *
 * Não apagamos nada no Drive. A pasta fica visível em pastas_drive com status
 * 'substituida' e chave própria, para revisão humana.
 */
async function registrarOrfa(segmento: SegmentoDestino, externalId: string): Promise<void> {
  const { error } = await supabaseAdmin.from("pastas_drive").insert({
    provedor: PROVEDOR,
    escopo: segmento.escopo,
    chave_logica: `${segmento.chaveLogica}#orfa:${externalId}`,
    external_id: externalId,
    nome: segmento.nome,
    caminho_logico: segmento.caminhoLogico,
    status: "substituida",
    erro_mensagem:
      "Criada por uma execução concorrente que perdeu a corrida. " +
      "Não foi apagada — revisar e remover manualmente se estiver vazia.",
  });

  // Falhar aqui não pode derrubar o arquivamento: é trilha de auditoria.
  if (error && error.code !== UNIQUE_VIOLATION) {
    console.warn(`[arquivador] não registrei a pasta órfã ${externalId}: ${error.message}`);
  }
}

export function portasPadrao(): PortasResolvedor {
  return {
    pastaRaizId: () => googleDrive.pastaRaizId(),
    listarPastasPorNome: (nome, paiId) => googleDrive.listarPastasPorNome(nome, paiId),
    criarPasta: (nome, paiId) => googleDrive.criarPastaBruta(nome, paiId),
    buscarMapeamento,
    inserirMapeamento,
    reapontarMapeamento,
    registrarOrfa,
  };
}

/**
 * Marca uma pasta como inacessível.
 *
 * Chamado quando uma operação falha porque a pasta sumiu ou foi para a
 * lixeira no Drive. Assim a próxima resolução refaz o mapeamento em vez de
 * insistir num external_id morto.
 */
export async function marcarInacessivel(chaveLogica: string, motivo: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("pastas_drive")
    .update({ status: "inacessivel", erro_mensagem: motivo.slice(0, 500) })
    .eq("provedor", PROVEDOR)
    .eq("chave_logica", chaveLogica);

  if (error) {
    console.warn(
      `[arquivador] não marquei ${chaveLogica} como inacessível: ${error.message}`
    );
  }
}
