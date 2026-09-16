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
 * nada. O papel dele é juntar os anexos e as observações, chamar, e repassar
 * o relatório e a mensagem SEM reescrever os números.
 */

const DESCRICAO = `Confere o contas a pagar com os agendamentos do banco e/ou o extrato da folha.

Use quando o usuário anexar os PDFs de uma empresa e pedir conferência de
agendamentos, conferência do contas a pagar, conferência da folha ou a
mensagem de envio dos agendamentos ao cliente.

Entrada:
- anexoIds: os anexoIds reais dos PDFs do MESMO cliente (máximo ${MAX_ANEXOS_CONFERENCIA}):
  um contas a pagar do Conta Azul e os agendamentos (Itaú ou Sicoob), o
  extrato mensal da folha, ou os dois. A ferramenta identifica cada um.
- cliente: como o cliente é chamado/marcado no WhatsApp (ex.: "@Maria").
  Se o usuário não disse, passe vazio e pergunte depois, junto com o resultado.
- observacoes: as observações que o usuário quer levar ao cliente, uma por
  linha, com as palavras dele. Não resuma nem corrija.
- relacoes: pares já confirmados "nome no contas a pagar = nome no banco",
  um por linha. Só use o que o usuário disse.

Ao receber o resultado com ok=true, responda nesta ordem:
1. O relatorio_markdown EXATAMENTE como veio (valores, nomes e tabelas sem
   alteração, sem recalcular e sem acrescentar divergências).
2. Os avisos, se houver.
3. Se houver pendencias_antes_de_enviar, liste-as como "Antes de enviar ao cliente".
4. A mensagem_whatsapp num bloco de código (\`\`\`text), idêntica à recebida,
   para o usuário copiar.

Com ok=false, mostre os erros e o que corrigir (arquivo faltando, CNPJ
diferente, layout não reconhecido, total que não fecha). Não invente
resultado. Se o usuário mudar observações ou relações, chame de novo com os
mesmos anexoIds.`;

const LIMITE_TEXTO = 4000;

function texto(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.slice(0, LIMITE_TEXTO).trim();
}

/** Aceita lista ou texto: o modelo às vezes manda observações como array. */
function linhas(v: unknown): string {
  if (Array.isArray(v)) return texto(v.filter((x) => typeof x === "string").join("\n"));
  return texto(v);
}

const validarEntrada: Validador<EntradaConferimento> = (dado) => {
  const d = (dado ?? {}) as Record<string, unknown>;
  const bruto = d.anexoIds ?? d.anexoId;
  const lista = Array.isArray(bruto) ? bruto : [bruto];
  const anexoIds = [...new Set(lista.filter((v): v is string => typeof v === "string" && v.trim().length > 0))];

  const problemas: string[] = [];
  if (anexoIds.length === 0) problemas.push("Informe os anexoIds dos PDFs.");
  if (anexoIds.length > MAX_ANEXOS_CONFERENCIA) {
    problemas.push(`Máximo de ${MAX_ANEXOS_CONFERENCIA} anexos por conferência (um cliente por vez).`);
  }
  if (problemas.length) return { valido: false, problemas };

  return {
    valido: true,
    dado: {
      anexoIds,
      cliente: texto(d.cliente).slice(0, 120),
      observacoes: linhas(d.observacoes),
      relacoes: linhas(d.relacoes),
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
  versao: "1.0.0",
  schemaEntrada: {
    type: "object",
    properties: {
      anexoIds: {
        type: "array",
        items: { type: "string" },
        description: "anexoIds dos PDFs do mesmo cliente: contas a pagar + agendamentos e/ou extrato da folha.",
      },
      cliente: { type: "string", description: "Como marcar o cliente no WhatsApp. Vazio se não informado." },
      observacoes: {
        type: "string",
        description: "Observações para o cliente, uma por linha, nas palavras do usuário. Vazio se não houver.",
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
