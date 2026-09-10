import "server-only";
import type { DefinicaoFerramenta, ResultadoFerramenta, Validador } from "./tipos";

/**
 * Ferramenta `link_painel_arquivamento`.
 *
 * O chat é ótimo para um ou dois documentos e ruim para vinte: cada arquivo
 * vira uma rodada de conversa, e revisar vinte destinos em texto corrido é
 * pior que uma tabela. Quando o usuário chega com um lote, o agente aponta
 * para a tela feita para isso em vez de tentar conduzir tudo por mensagem.
 *
 * A ferramenta não arquiva, não analisa e não toca em documento nenhum. Ela
 * devolve um endereço. Está aqui, e não numa frase fixa da instrução do
 * agente, porque o endereço muda entre ambientes — e uma URL errada colada
 * pelo modelo manda o usuário para lugar nenhum.
 */

const DESCRICAO = `Devolve o link do painel de arquivamento em lote.

Use quando o usuário tiver MUITOS documentos para arquivar de uma vez, quando
pedir uma tela/painel para organizar arquivos, ou quando quiser revisar vários
destinos lado a lado antes de confirmar.

O painel faz o mesmo que você faz no chat — lê os documentos, identifica a
empresa, monta o destino — mas mostra tudo numa tabela onde o usuário corrige
o que ficou ambíguo e confirma em lote.

NÃO use para um ou dois arquivos: nesse caso resolva na própria conversa com
processar_documentos, que é mais rápido para o usuário.

Esta ferramenta não arquiva nada. Ela só devolve o endereço.`;

export type EntradaLinkPainel = { motivo?: string | null };

const validarEntrada: Validador<EntradaLinkPainel> = (dado) => {
  const d = (dado ?? {}) as Record<string, unknown>;
  const motivo = typeof d.motivo === "string" ? d.motivo.slice(0, 200) : null;
  return { valido: true, dado: { motivo } };
};

/**
 * Endereço público da aplicação.
 *
 * `NEXT_PUBLIC_APP_URL` manda quando existe (é o único jeito de acertar um
 * domínio próprio). Na Vercel, `VERCEL_PROJECT_PRODUCTION_URL` dá o domínio de
 * produção; `VERCEL_URL` é o deploy específico, que serve de última tentativa.
 * Sem nenhum deles — desenvolvimento local — devolvemos o caminho relativo, que
 * funciona no navegador de quem está lendo o chat.
 */
function enderecoDoPainel(): string {
  const base =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "") ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");

  if (!base) return "/painel";
  return `${base.replace(/\/+$/, "")}/painel`;
}

export const ferramentaLinkPainel: DefinicaoFerramenta<EntradaLinkPainel, { url: string }> = {
  codigo: "link_painel_arquivamento",
  nome: "Link do painel de arquivamento",
  descricao: DESCRICAO,
  versao: "1.0.0",
  schemaEntrada: {
    type: "object",
    properties: {
      motivo: {
        type: "string",
        description:
          "Por que o painel é melhor agora (ex.: 'são 18 extratos de clientes diferentes'). Aparece na resposta.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  validarEntrada,
  // Devolver um endereço não muda nada no banco nem no disco.
  nivelRisco: "baixo",
  modo: "sincrono",
  timeoutMs: 5_000,
  tentativas: 1,
  exigeAprovacao: false,
  disponivelParaAgente: true,
  async handler(entrada): Promise<ResultadoFerramenta<{ url: string }>> {
    const url = enderecoDoPainel();
    return {
      ok: true,
      saida: { url },
      resumo:
        `Painel de arquivamento em lote: ${url}` +
        (entrada.motivo ? ` (${entrada.motivo})` : "") +
        ". Lá o usuário solta vários arquivos, revisa o destino de cada um numa tabela e confirma de uma vez.",
    };
  },
};
