import type { RegraArquivamento } from "./caminhos";

/**
 * O fluxo de pagamentos do cliente mora numa pasta própria.
 *
 * Contas a pagar, agendamentos do banco e comprovantes de agendamento são
 * lidos juntos (é a conferência do período) e guardados juntos, na pasta
 * AGENDAMENTOS do cliente. Sem isto eles cairiam na pasta plana da
 * competência, misturados a nota fiscal, extrato e fatura.
 *
 * A escolha é do CÓDIGO, não do modelo: o classificador vê uma lista de
 * regras e acerta a maior parte das vezes, mas "quase sempre" não serve para
 * decidir onde um documento vive. O tipo do documento já é uma decisão do
 * modelo; a pasta que corresponde a ele é regra fixa.
 */

export const REGRA_AGENDAMENTOS = "CLIENTE_AGENDAMENTOS";

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ");
}

/** Comprovante de pagamento é do fluxo; comprovante de endereço não é. */
const COMPROVANTES = /\bCOMPROVANTE(S)?\b.*\b(AGENDAMENTO|PAGAMENTO|TRANSFERENCIA|PIX|TED|DOC|BOLETO|DARF|GUIA|GPS)/;
const DO_FLUXO = /\bAGENDAMENTO(S)?\b|\bCONTAS A PAGAR\b|\bCONTAS PAGAR\b/;

export function ehDoFluxoDeAgendamentos(tipoDocumento: string | null, nomeArquivo = ""): boolean {
  // O nome do arquivo entra como reforço: quem opera batiza "<CLIENTE> -
  // AGENDAMENTOS - 11.09 A 20.09.pdf" e isso é uma informação, não ruído.
  const texto = normalizar(`${tipoDocumento ?? ""} ${nomeArquivo}`);
  return DO_FLUXO.test(texto) || COMPROVANTES.test(texto);
}

/**
 * A regra que vale para este documento.
 *
 * Só substitui uma regra de CLIENTE: se o classificador entendeu que é
 * documento interno da Effective (ou o usuário corrigiu a regra na conversa),
 * a escolha dele continua valendo.
 */
export function regraDoFluxoDeAgendamentos(
  escolhida: RegraArquivamento | null,
  tipoDocumento: string | null,
  nomeArquivo: string,
  regras: RegraArquivamento[]
): RegraArquivamento | null {
  if (!ehDoFluxoDeAgendamentos(tipoDocumento, nomeArquivo)) return escolhida;
  if (escolhida && !escolhida.exige_empresa) return escolhida;
  return regras.find((r) => r.codigo === REGRA_AGENDAMENTOS) ?? escolhida;
}
