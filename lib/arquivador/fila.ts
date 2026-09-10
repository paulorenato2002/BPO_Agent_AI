import "server-only";
import { supabaseAdmin } from "../supabase-admin";
import type { EntradaArquivamento } from "./arquivamento";
import type { ItemAnalisado } from "./analise";

export type ArquivamentoEnfileirado = {
  status: "enfileirado";
  propostaId: string;
  itens: { id: string; status: string; nome_original: string }[];
};

/** Estado atual para o agente responder sobre um pedido antigo sem repetir a operação. */
export async function statusArquivamentosDaConversa(usuarioId: string, conversaId: string) {
  const { data, error } = await supabaseAdmin.from("fila_arquivamento")
    .select("nome_original,status,erro,resultado")
    .eq("usuario_id", usuarioId).eq("conversa_id", conversaId)
    .order("created_at", { ascending: false }).limit(20);
  if (error) return null;
  return (data ?? []).map(item => ({ nome: item.nome_original, status: item.status, erro: item.erro,
    caminho: item.resultado?.caminho_relativo, nomeFinal: item.resultado?.nome_final }));
}

/** A RPC valida a proposta e insere todos os itens numa única transação.
 * Não baixa bytes nem abre um processo Python na Vercel. */
export async function enfileirarArquivamento(
  entrada: EntradaArquivamento,
  usuarioId: string,
  conversaId: string | null,
): Promise<ArquivamentoEnfileirado> {
  if (entrada.confirmar !== true || !entrada.anexosConfirmados.length) {
    throw new Error("Confirme explicitamente quais arquivos devem ser arquivados.");
  }
  const { data, error } = await supabaseAdmin.rpc("enfileirar_arquivamento", {
    p_proposta: entrada.propostaId,
    p_usuario: usuarioId,
    p_conversa: conversaId,
    p_anexos: [...new Set(entrada.anexosConfirmados)],
  });
  if (error) throw new Error(`Não foi possível enfileirar: ${error.message}`);
  const itens = (data ?? []) as { id: string; status: string; nome_original: string }[];

  await aprenderComAConfirmacao(entrada.propostaId, entrada.anexosConfirmados, usuarioId);

  return { status: "enfileirado", propostaId: entrada.propostaId,
    itens: itens.map(({ id, status, nome_original }) => ({ id, status, nome_original })) };
}

/**
 * Grava o que esta confirmação ensinou: de quem é a conta, o que é o layout.
 *
 * MELHOR-ESFORÇO, E FORA DA TRANSAÇÃO DO ENFILEIRAMENTO. O usuário já aprovou o
 * arquivamento; uma falha ao aprender não pode desfazer isso nem aparecer como
 * erro para ele. Na pior das hipóteses o sistema volta a perguntar no mês que
 * vem, que é exatamente o comportamento de antes.
 */
async function aprenderComAConfirmacao(
  propostaId: string,
  anexosConfirmados: string[],
  usuarioId: string
): Promise<void> {
  try {
    const { data } = await supabaseAdmin
      .from("propostas_arquivamento")
      .select("itens")
      .eq("id", propostaId)
      .maybeSingle();

    const itens = (Array.isArray(data?.itens) ? data.itens : []) as ItemAnalisado[];
    const confirmados = new Set(anexosConfirmados);

    const licoes = itens
      .filter((i) => confirmados.has(i.anexoId) && i.assinaturas)
      .map((i) => ({
        conta: i.assinaturas?.conta ?? null,
        agencia: i.assinaturas?.agencia ?? null,
        layout: i.assinaturas?.layout ?? null,
        instituicao: i.instituicao?.valor ?? null,
        empresa_id: i.empresa?.empresaId ?? null,
        tipo_documento: i.tipoDocumento?.valor ?? null,
        regra_codigo: i.regra?.valor ?? null,
      }))
      .filter((l) => (l.conta && l.empresa_id) || (l.layout && l.tipo_documento));

    if (!licoes.length) return;

    await supabaseAdmin.rpc("registrar_aprendizado", {
      p_itens: licoes,
      p_usuario: usuarioId,
    });
  } catch {
    // Silêncio de propósito: aprender é um bônus, arquivar é o compromisso.
  }
}
