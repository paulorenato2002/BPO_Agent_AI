import "server-only";
import type { DefinicaoFerramenta, ResultadoFerramenta, Validador } from "./tipos";
import {
  conferirAgendamentos,
  MAX_ANEXOS_CONFERENCIA,
  type EntradaConferimento,
  type RespostaConferidor,
} from "../conferimento/conferimento";

/**
 * Ferramenta `conferir_agendamentos`.
 *
 * A conferência é determinística e roda no mini-sistema; o modelo não confere
 * nada. O papel dele é juntar os anexos, as observações e os dados que o
 * usuário escreveu, chamar, e repassar o relatório e a mensagem SEM reescrever
 * os números.
 */

const DESCRICAO = `Confere o contas a pagar com os agendamentos do banco, o extrato da folha e as planilhas de VT/VA.

Use quando o usuário anexar os arquivos de uma empresa e pedir conferência de
agendamentos, do contas a pagar, da folha, de VT/VA, ou a mensagem de envio dos
agendamentos ao cliente.

Entrada:
- anexoIds: os anexoIds reais dos arquivos do MESMO cliente (máximo ${MAX_ANEXOS_CONFERENCIA}):
  o contas a pagar do Conta Azul (PDF) e pelo menos um entre agendamentos do
  banco (Itaú/Sicoob, PDF), extrato mensal da folha (PDF) e planilhas de VT/VA
  (XLSX, CSV ou TXT). A ferramenta identifica cada um.
- empresa: nome curto da empresa para o título da mensagem (ex.: "L2H",
  "REZENDE", "TL"), como o usuário escreveu. Vazio se ele não disse: a
  ferramenta usa o prefixo do nome do arquivo ("L2H - CONTAS A PAGAR...").
- cliente: como marcar o cliente no WhatsApp (ex.: "@Maria"). Se o usuário
  pedir para deixar só o arroba, passe "@". Vazio se não informado.
- observacoes: as observações que o usuário quer levar ao cliente, uma por
  linha, com as palavras dele. Não resuma nem corrija.
- dadosTexto: listas de valores que o usuário escreveu na mensagem (VT, VA,
  pagamentos avulsos), copiadas como ele escreveu, uma pessoa por linha com o
  valor. Mantenha as linhas de título ("VT", "Vale alimentação"). Não invente
  nem some valores.
- relacoes: pares já confirmados "nome no contas a pagar = nome no banco",
  um por linha. Só use o que o usuário disse.

Ao receber o resultado com ok=true, responda nesta ordem:
1. O relatorio_markdown EXATAMENTE como veio (valores, nomes e tabelas sem
   alteração, sem recalcular e sem acrescentar divergências).
2. Os avisos, se houver.
3. Se houver pendencias_antes_de_enviar, liste-as como "Antes de enviar ao cliente".
4. A mensagem_whatsapp num bloco de código (\`\`\`text), idêntica à recebida,
   para o usuário copiar. Não mude a formatação: os asteriscos e traços são
   a formatação do WhatsApp.

Com ok=false, mostre os erros e o que corrigir (arquivo faltando, CNPJ
diferente, layout não reconhecido, total que não fecha, coluna não achada na
planilha). Não invente resultado. Se o usuário mudar observações, empresa,
cliente ou dados, chame de novo com os mesmos anexoIds.`;

const LIMITE_TEXTO = 4000;
const LIMITE_DADOS = 20_000;

function texto(v: unknown, limite = LIMITE_TEXTO): string {
  if (typeof v !== "string") return "";
  return v.slice(0, limite).trim();
}

/** Aceita lista ou texto: o modelo às vezes manda observações como array. */
function linhas(v: unknown, limite = LIMITE_TEXTO): string {
  if (Array.isArray(v)) return texto(v.filter((x) => typeof x === "string").join("\n"), limite);
  return texto(v, limite);
}

const validarEntrada: Validador<EntradaConferimento> = (dado) => {
  const d = (dado ?? {}) as Record<string, unknown>;
  const bruto = d.anexoIds ?? d.anexoId;
  const lista = Array.isArray(bruto) ? bruto : [bruto];
  const anexoIds = [...new Set(lista.filter((v): v is string => typeof v === "string" && v.trim().length > 0))];

  const problemas: string[] = [];
  if (anexoIds.length === 0) problemas.push("Informe os anexoIds dos arquivos.");
  if (anexoIds.length > MAX_ANEXOS_CONFERENCIA) {
    problemas.push(`Máximo de ${MAX_ANEXOS_CONFERENCIA} anexos por conferência (um cliente por vez).`);
  }
  if (problemas.length) return { valido: false, problemas };

  return {
    valido: true,
    dado: {
      anexoIds,
      cliente: texto(d.cliente).slice(0, 120),
      empresa: texto(d.empresa).slice(0, 40),
      observacoes: linhas(d.observacoes),
      relacoes: linhas(d.relacoes),
      dadosTexto: linhas(d.dadosTexto ?? d.dados_texto, LIMITE_DADOS),
    },
  };
};

function resumir(r: RespostaConferidor): string {
  if (!r.ok) return `Conferência não realizada: ${r.erros.join(" ")}`;
  const n = r.divergencias ?? 0;
  const partes = [n === 0 ? "Conferência sem divergências" : `Conferência com ${n} divergência(s)`];
  if (r.pendencias_antes_de_enviar?.length) partes.push("há pendências antes de enviar ao cliente");
  return `${partes.join("; ")}. Apresente o relatorio_markdown e a mensagem_whatsapp como vieram.`;
}

export const ferramentaConferirAgendamentos: DefinicaoFerramenta<EntradaConferimento, RespostaConferidor> = {
  codigo: "conferir_agendamentos",
  nome: "Conferimento de agendamentos",
  descricao: DESCRICAO,
  versao: "1.1.0",
  schemaEntrada: {
    type: "object",
    properties: {
      anexoIds: {
        type: "array",
        items: { type: "string" },
        description:
          "anexoIds dos arquivos do mesmo cliente: contas a pagar + agendamentos, extrato da folha e/ou planilhas de VT/VA.",
      },
      empresa: {
        type: "string",
        description: "Nome curto da empresa para a mensagem (ex.: L2H). Vazio se o usuário não disse.",
      },
      cliente: { type: "string", description: "Como marcar o cliente no WhatsApp. Vazio se não informado." },
      observacoes: {
        type: "string",
        description: "Observações para o cliente, uma por linha, nas palavras do usuário. Vazio se não houver.",
      },
      dadosTexto: {
        type: "string",
        description:
          "Listas (VT, VA, pagamentos) escritas na mensagem, copiadas como o usuário escreveu, uma pessoa por linha com o valor. Vazio se não houver.",
      },
      relacoes: {
        type: "string",
        description: "Pares confirmados 'nome no contas a pagar = nome no banco', um por linha. Vazio se não houver.",
      },
    },
    required: ["anexoIds"],
    additionalProperties: false,
  },
  validarEntrada,
  // Só lê. Não grava no banco, não envia nada ao cliente.
  nivelRisco: "baixo",
  modo: "sincrono",
  timeoutMs: 150_000,
  tentativas: 1,
  exigeAprovacao: false,
  disponivelParaAgente: true,
  async handler(entrada, contexto): Promise<ResultadoFerramenta<RespostaConferidor>> {
    if (!contexto.usuarioId) {
      return { ok: false, erro: "Conferência exige usuário autenticado.", codigoErro: "sem_usuario" };
    }

    // Import preguiçoso: as portas carregam o Supabase, que exige credenciais.
    const { portasConferimentoLocal } = await import("../conferimento/portas-local");
    const r = await conferirAgendamentos(entrada, contexto.usuarioId, portasConferimentoLocal());
    if (!r.ok) return { ok: false, erro: r.erro, codigoErro: r.codigo };

    // Erro de leitura ou de lote volta como sucesso da ferramenta com ok=false
    // na saída: o modelo precisa dos erros para orientar o usuário.
    return { ok: true, saida: r.resposta, resumo: resumir(r.resposta) };
  },
};
