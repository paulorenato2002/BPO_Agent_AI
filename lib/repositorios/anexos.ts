import "server-only";
import { supabaseAdmin } from "../supabase-admin";
import { extrairExtensao } from "../documentos/inspecao";
import type { AnexoRegistrado } from "../arquivador/analise";

/**
 * Registro dos anexos do chat.
 *
 * O conteúdo continua no Storage; aqui ficam identidade, DONO e hash. Sem
 * isso, o `arquivoId` sorteado no upload era a única credencial de acesso ao
 * arquivo — quem o tivesse, lia.
 */

const COLUNAS =
  "id,arquivo_id,usuario_id,conversa_id,nome_original,extensao," +
  "tamanho_bytes,hash_sha256,bloqueado,motivo_bloqueio";

export async function registrarAnexo(dados: {
  arquivoId: string;
  usuarioId: string;
  conversaId: string | null;
  nomeOriginal: string;
  tamanhoBytes: number;
  mimeType: string | null;
  hashSha256: string;
  bloqueado?: boolean;
  motivoBloqueio?: string | null;
}): Promise<{ id: string }> {
  const { data, error } = await supabaseAdmin
    .from("anexos_agente")
    .insert({
      arquivo_id: dados.arquivoId,
      usuario_id: dados.usuarioId,
      conversa_id: dados.conversaId,
      nome_original: dados.nomeOriginal,
      extensao: extrairExtensao(dados.nomeOriginal) || "bin",
      mime_type: dados.mimeType,
      tamanho_bytes: dados.tamanhoBytes,
      hash_sha256: dados.hashSha256,
      bloqueado: dados.bloqueado ?? false,
      motivo_bloqueio: dados.motivoBloqueio ?? null,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Falha ao registrar anexo: ${error.message}`);
  return { id: (data as { id: string }).id };
}

/**
 * Busca anexos garantindo a propriedade.
 *
 * O filtro por `usuario_id` é a defesa: quem pede anexo alheio recebe uma
 * lista menor, e o chamador trata isso como recusa do lote inteiro.
 */
export async function buscarAnexosDoUsuario(
  ids: string[],
  usuarioId: string
): Promise<AnexoRegistrado[]> {
  if (ids.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("anexos_agente")
    .select(COLUNAS)
    .in("id", ids)
    .eq("usuario_id", usuarioId);

  if (error) throw new Error(`Falha ao buscar anexos: ${error.message}`);
  return (data ?? []) as unknown as AnexoRegistrado[];
}

/** Vincula os anexos à mensagem depois que ela é criada. */
export async function vincularAnexosAMensagem(
  anexoIds: string[],
  mensagemId: string,
  conversaId: string,
  usuarioId: string
): Promise<void> {
  if (anexoIds.length === 0) return;

  const { error } = await supabaseAdmin
    .from("anexos_agente")
    .update({ mensagem_id: mensagemId, conversa_id: conversaId })
    .in("id", anexoIds)
    .eq("usuario_id", usuarioId);

  if (error) throw new Error(`Falha ao vincular anexos: ${error.message}`);
}
