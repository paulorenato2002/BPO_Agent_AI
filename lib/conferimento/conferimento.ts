import "server-only";

/**
 * Conferimento de agendamentos pelo chat.
 *
 * Quem confere é o mini-sistema em Python (Mini-Sistemas/conferidor), com as
 * regras e os testes dele. Aqui só se garante que os anexos são do usuário,
 * que são PDFs liberados, e se entrega o conteúdo. As portas são injetadas
 * para que esta regra seja testada sem banco, Storage nem Python.
 */

export type EntradaConferimento = {
  anexoIds: string[];
  cliente: string;
  observacoes: string;
  relacoes: string;
};

export type AnexoParaConferir = {
  id: string;
  arquivo_id: string;
  nome_original: string;
  extensao: string | null;
  bloqueado: boolean;
  motivo_bloqueio: string | null;
};

export type DocumentoLido = {
  arquivo: string;
  tipo: string;
  registros: number;
  soma_lida: string;
  total_impresso: string | null;
  validado: boolean;
  cnpj_no_cabecalho: boolean;
  periodo: string;
  alertas: string[];
};

/** Resposta do `cli.py json --stdin`. */
export type RespostaConferidor = {
  ok: boolean;
  erros: string[];
  documentos?: DocumentoLido[];
  divergencias?: number;
  avisos?: string[];
  relatorio_markdown?: string;
  pendencias_antes_de_enviar?: string[];
  mensagem_whatsapp?: string;
};

export type PortasConferimento = {
  buscarAnexos: (ids: string[], usuarioId: string) => Promise<AnexoParaConferir[]>;
  lerConteudo: (anexo: AnexoParaConferir) => Promise<Buffer>;
  conferir: (pedido: {
    arquivos: { nome: string; base64: string }[];
    cliente: string;
    observacoes: string;
    relacoes: string;
  }) => Promise<RespostaConferidor>;
};

export type ResultadoConferimento =
  | { ok: true; resposta: RespostaConferidor }
  | { ok: false; erro: string; codigo: string };

export const MAX_ANEXOS_CONFERENCIA = 5;

export async function conferirAgendamentos(
  entrada: EntradaConferimento,
  usuarioId: string,
  portas: PortasConferimento
): Promise<ResultadoConferimento> {
  const anexos = await portas.buscarAnexos(entrada.anexoIds, usuarioId);

  // Anexo que não voltou é de outra pessoa ou não existe: recusa o lote todo,
  // sem dizer qual — conferir só parte dos arquivos daria um resultado falso.
  if (anexos.length !== entrada.anexoIds.length) {
    return {
      ok: false,
      erro: "Algum anexo não foi encontrado para este usuário. Peça para anexar os PDFs de novo.",
      codigo: "anexo_nao_encontrado",
    };
  }

  const bloqueados = anexos.filter((a) => a.bloqueado);
  if (bloqueados.length > 0) {
    return {
      ok: false,
      erro: `Anexo bloqueado: ${bloqueados.map((a) => `${a.nome_original} (${a.motivo_bloqueio ?? "sem motivo"})`).join(", ")}.`,
      codigo: "anexo_bloqueado",
    };
  }

  const naoPdf = anexos.filter((a) => (a.extensao ?? "").replace(/^\./, "").toLowerCase() !== "pdf");
  if (naoPdf.length > 0) {
    return {
      ok: false,
      erro: `A conferência lê apenas PDF. Fora do formato: ${naoPdf.map((a) => a.nome_original).join(", ")}.`,
      codigo: "formato_nao_suportado",
    };
  }

  // Mantém a ordem em que o usuário mandou, que é a ordem que ele vê.
  const porId = new Map(anexos.map((a) => [a.id, a]));
  const arquivos = [];
  for (const id of entrada.anexoIds) {
    const anexo = porId.get(id)!;
    const conteudo = await portas.lerConteudo(anexo);
    arquivos.push({ nome: anexo.nome_original, base64: conteudo.toString("base64") });
  }

  const resposta = await portas.conferir({
    arquivos,
    cliente: entrada.cliente,
    observacoes: entrada.observacoes,
    relacoes: entrada.relacoes,
  });
  return { ok: true, resposta };
}
