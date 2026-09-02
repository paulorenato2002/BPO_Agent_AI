import "server-only";
import { analisarDocumentos, type EntradaAnalise, type PropostaGerada } from "../arquivador/analise";
import type { DefinicaoFerramenta, ResultadoFerramenta, Validador } from "./tipos";

/**
 * Ferramenta `analisar_documentos`.
 *
 * ANALISA E PROPÕE — não arquiva. Não envia ao Drive, não cria pasta de
 * empresa, não renomeia arquivo, não marca documento como arquivado. O produto
 * é uma proposta aguardando confirmação explícita.
 *
 * A descrição abaixo é lida pelo MODELO. Ela precisa deixar claro o que a
 * ferramenta NÃO faz, senão o agente promete arquivamento ao usuário e o
 * usuário acha que acabou.
 */

const DESCRICAO = `Analisa arquivos que o usuário anexou e PROPÕE onde cada um deve ser arquivado.

NÃO arquiva nada. Não envia ao Google Drive, não cria pastas e não renomeia arquivos.
Gera uma proposta que o usuário precisa confirmar depois, item por item.

Use quando o usuário anexar documentos e pedir para arquivar, organizar, guardar ou
classificar. Cada arquivo é analisado por si — um lote pode ter empresas diferentes.

Passe o anexoId que veio no bloco do arquivo anexado. Se algum campo não for
identificado, a proposta dirá o que falta em vez de chutar.`;

export type EntradaFerramentaAnalise = {
  anexoIds: string[];
  conversaId?: string | null;
  mensagemId?: string | null;
  empresaContextoId?: string | null;
};

const validarEntrada: Validador<EntradaFerramentaAnalise> = (dado) => {
  const problemas: string[] = [];
  const d = (dado ?? {}) as Record<string, unknown>;

  // Aceita `anexoId` avulso porque é assim que o modelo tende a chamar quando
  // há um arquivo só; normalizamos para lista.
  const bruto = d.anexoIds ?? d.anexoId;
  const lista = Array.isArray(bruto) ? bruto : bruto ? [bruto] : [];

  const anexoIds = lista.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (anexoIds.length === 0) problemas.push("Informe ao menos um anexoId.");
  if (anexoIds.length > 20) problemas.push("Máximo de 20 anexos por análise.");

  const opcional = (chave: string): string | null => {
    const v = d[chave];
    return typeof v === "string" && v ? v : null;
  };

  if (problemas.length > 0) return { valido: false, problemas };

  return {
    valido: true,
    dado: {
      anexoIds,
      conversaId: opcional("conversaId"),
      mensagemId: opcional("mensagemId"),
      empresaContextoId: opcional("empresaContextoId"),
    },
  };
};

/** Resumo em texto para o agente contar ao usuário sem inventar. */
function resumir(proposta: PropostaGerada, reaproveitada: boolean): string {
  const { resumo } = proposta;
  const partes = [
    `${resumo.total} arquivo(s) analisado(s)`,
    `${resumo.prontos} pronto(s) para confirmar`,
  ];
  if (resumo.incompletos > 0) partes.push(`${resumo.incompletos} com campo faltando`);
  if (resumo.bloqueados > 0) partes.push(`${resumo.bloqueados} bloqueado(s)`);
  if (resumo.empresasDistintas > 1) {
    partes.push(`${resumo.empresasDistintas} empresas diferentes no lote`);
  }

  const duplicatas = proposta.itens.filter((i) => i.possivelDuplicata).length;
  if (duplicatas > 0) partes.push(`${duplicatas} possível(is) duplicata(s)`);

  return (
    `${partes.join(", ")}. ` +
    (reaproveitada ? "Proposta já existente reaproveitada. " : "") +
    "Nada foi arquivado: a proposta aguarda confirmação."
  );
}

export const ferramentaAnalisarDocumentos: DefinicaoFerramenta<
  EntradaFerramentaAnalise,
  PropostaGerada
> = {
  codigo: "analisar_documentos",
  nome: "Analisar documentos anexados",
  descricao: DESCRICAO,
  versao: "1.0.0",
  schemaEntrada: {
    type: "object",
    properties: {
      anexoIds: {
        type: "array",
        items: { type: "string" },
        description: "ids dos anexos (campo anexoId do bloco do arquivo anexado).",
      },
      conversaId: { type: "string", description: "Conversa atual, quando conhecida." },
      mensagemId: { type: "string", description: "Mensagem que trouxe os anexos." },
      empresaContextoId: {
        type: "string",
        description:
          "Empresa já em uso na conversa. Serve de pista fraca; o conteúdo do arquivo prevalece.",
      },
    },
    required: ["anexoIds"],
    additionalProperties: false,
  },
  validarEntrada,
  // Lê arquivo do usuário e grava proposta, mas não altera nada fora do
  // próprio registro e não toca no Drive.
  nivelRisco: "medio",
  modo: "sincrono",
  timeoutMs: 120_000,
  tentativas: 1,
  // A aprovação humana acontece na CONFIRMAÇÃO da proposta, não aqui: analisar
  // é reversível e não produz efeito externo.
  exigeAprovacao: false,
  disponivelParaAgente: true,

  async handler(entrada, contexto): Promise<ResultadoFerramenta<PropostaGerada>> {
    if (!contexto.usuarioId) {
      return {
        ok: false,
        erro: "Análise exige usuário autenticado.",
        codigoErro: "sem_usuario",
      };
    }

    const pedido: EntradaAnalise = {
      anexoIds: entrada.anexoIds,
      conversaId: entrada.conversaId ?? null,
      mensagemId: entrada.mensagemId ?? null,
      empresaContextoId: entrada.empresaContextoId ?? contexto.empresaId ?? null,
      chaveIdempotencia: contexto.chaveIdempotencia ?? null,
    };

    // Import preguiçoso: as portas carregam supabase-admin, que exige
    // credenciais já na carga do módulo. Assim o contrato de entrada da
    // ferramenta pode ser testado sem .env.
    const { portasAnalisePadrao } = await import("../arquivador/portas-analise");

    const r = await analisarDocumentos(pedido, contexto.usuarioId, portasAnalisePadrao());

    if (!r.ok) return { ok: false, erro: r.erro, codigoErro: r.codigo };

    return {
      ok: true,
      saida: r.proposta,
      resumo: resumir(r.proposta, r.reaproveitada),
    };
  },
};
