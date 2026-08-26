import "server-only";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { lerArquivo } from "./file-store";
import { parseArquivo, type LinhaTabular } from "./file-extract";

const LIMITE_PADRAO = 50;
const LIMITE_MAXIMO = 500;

async function carregarTabular(arquivoId: string, nomeArquivo: string) {
  const buffer = await lerArquivo(arquivoId, nomeArquivo);
  const parsed = await parseArquivo(nomeArquivo, buffer);
  if (parsed.tipo !== "tabular") {
    throw new Error(`${nomeArquivo} não é um arquivo tabular (planilha/CSV) — use ler_arquivo_texto_anexado.`);
  }
  return parsed;
}

async function carregarTexto(arquivoId: string, nomeArquivo: string) {
  const buffer = await lerArquivo(arquivoId, nomeArquivo);
  const parsed = await parseArquivo(nomeArquivo, buffer);
  if (parsed.tipo !== "texto") {
    throw new Error(`${nomeArquivo} é um arquivo tabular — use consultar_arquivo_anexado ou agregar_arquivo_anexado.`);
  }
  return parsed;
}

function aplicarFiltros(
  linhas: LinhaTabular[],
  filtros?: Record<string, unknown>,
  contem?: { coluna: string; texto: string }
): LinhaTabular[] {
  let resultado = linhas;
  if (filtros) {
    for (const [coluna, valor] of Object.entries(filtros)) {
      resultado = resultado.filter((l) => String(l[coluna] ?? "") === String(valor));
    }
  }
  if (contem) {
    const alvo = contem.texto.toLowerCase();
    resultado = resultado.filter((l) =>
      String(l[contem.coluna] ?? "").toLowerCase().includes(alvo)
    );
  }
  return resultado;
}

function paraNumero(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  if (typeof valor !== "string") return null;
  let s = valor.trim().replace(/[^\d,.-]/g, "");
  if (!s) return null;
  const temVirgula = s.includes(",");
  const temPonto = s.includes(".");
  if (temVirgula && temPonto) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (temVirgula) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export const fileTools: ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "consultar_arquivo_anexado",
      description:
        "Consulta linhas de uma planilha/CSV anexada pelo usuário (identificada por arquivoId), com filtro e paginação. Use pra explorar dados que não vieram na prévia por causa do tamanho do arquivo.",
      parameters: {
        type: "object",
        properties: {
          arquivoId: { type: "string", description: "Id do arquivo, do bloco [Arquivo anexado...]." },
          nomeArquivo: { type: "string", description: "Nome do arquivo, do mesmo bloco." },
          colunas: { type: "array", items: { type: "string" }, description: "Colunas a retornar; se omitido, todas." },
          filtros: {
            type: "object",
            description: "Pares coluna:valor pra igualdade exata.",
            additionalProperties: true,
          },
          contem: {
            type: "object",
            description: "Busca por trecho de texto (case-insensitive) numa coluna, ex: descrição contém 'pix'.",
            properties: {
              coluna: { type: "string" },
              texto: { type: "string" },
            },
            required: ["coluna", "texto"],
          },
          limite: { type: "integer", description: `Linhas por página (padrão ${LIMITE_PADRAO}, máx ${LIMITE_MAXIMO}).` },
          offset: { type: "integer", description: "Quantas linhas pular (paginação, padrão 0)." },
        },
        required: ["arquivoId", "nomeArquivo"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agregar_arquivo_anexado",
      description:
        "Agrupa e soma/conta linhas de uma planilha/CSV anexada, sem precisar ler linha por linha. Ideal pra resumo por categoria, total de receitas/despesas, etc. Aceita os mesmos filtros de consultar_arquivo_anexado.",
      parameters: {
        type: "object",
        properties: {
          arquivoId: { type: "string" },
          nomeArquivo: { type: "string" },
          agruparPor: { type: "string", description: "Coluna usada como chave do agrupamento." },
          somarColuna: {
            type: "string",
            description: "Coluna numérica a somar por grupo (aceita formatos com R$, ponto/vírgula). Se omitido, só conta linhas.",
          },
          filtros: { type: "object", additionalProperties: true },
          contem: {
            type: "object",
            properties: { coluna: { type: "string" }, texto: { type: "string" } },
            required: ["coluna", "texto"],
          },
        },
        required: ["arquivoId", "nomeArquivo", "agruparPor"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ler_arquivo_texto_anexado",
      description:
        "Lê um trecho do texto de um PDF/TXT anexado, por posição de caractere. Use pra continuar lendo além do que veio na prévia.",
      parameters: {
        type: "object",
        properties: {
          arquivoId: { type: "string" },
          nomeArquivo: { type: "string" },
          offset: { type: "integer", description: "Posição inicial em caracteres (padrão 0)." },
          limite: { type: "integer", description: "Quantidade de caracteres a retornar (padrão 4000, máx 20000)." },
        },
        required: ["arquivoId", "nomeArquivo"],
        additionalProperties: false,
      },
    },
  },
];

export async function executeFileTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "consultar_arquivo_anexado": {
      const { arquivoId, nomeArquivo } = args as { arquivoId: string; nomeArquivo: string };
      const parsed = await carregarTabular(arquivoId, nomeArquivo);
      const filtradas = aplicarFiltros(
        parsed.linhas,
        args.filtros as Record<string, unknown> | undefined,
        args.contem as { coluna: string; texto: string } | undefined
      );
      const offset = Math.max(Number(args.offset) || 0, 0);
      const limite = Math.min(Number(args.limite) || LIMITE_PADRAO, LIMITE_MAXIMO);
      const colunasSelecionadas = args.colunas as string[] | undefined;
      let pagina = filtradas.slice(offset, offset + limite);
      if (colunasSelecionadas?.length) {
        pagina = pagina.map((linha) =>
          Object.fromEntries(colunasSelecionadas.map((c) => [c, linha[c]]))
        );
      }
      return {
        linhas: pagina,
        totalFiltrado: filtradas.length,
        totalArquivo: parsed.linhas.length,
        offset,
        limite,
        temMais: offset + limite < filtradas.length,
      };
    }

    case "agregar_arquivo_anexado": {
      const { arquivoId, nomeArquivo, agruparPor, somarColuna } = args as {
        arquivoId: string;
        nomeArquivo: string;
        agruparPor: string;
        somarColuna?: string;
      };
      const parsed = await carregarTabular(arquivoId, nomeArquivo);
      const filtradas = aplicarFiltros(
        parsed.linhas,
        args.filtros as Record<string, unknown> | undefined,
        args.contem as { coluna: string; texto: string } | undefined
      );

      const grupos = new Map<string, { quantidade: number; soma: number; naoNumerico: number }>();
      for (const linha of filtradas) {
        const chave = String(linha[agruparPor] ?? "(vazio)");
        const grupo = grupos.get(chave) ?? { quantidade: 0, soma: 0, naoNumerico: 0 };
        grupo.quantidade += 1;
        if (somarColuna) {
          const numero = paraNumero(linha[somarColuna]);
          if (numero === null) grupo.naoNumerico += 1;
          else grupo.soma += numero;
        }
        grupos.set(chave, grupo);
      }

      const resultado = Array.from(grupos.entries())
        .map(([chave, g]) => ({
          chave,
          quantidade: g.quantidade,
          ...(somarColuna ? { soma: Number(g.soma.toFixed(2)), naoNumerico: g.naoNumerico || undefined } : {}),
        }))
        .sort((a, b) =>
          somarColuna ? Math.abs(b.soma ?? 0) - Math.abs(a.soma ?? 0) : b.quantidade - a.quantidade
        );

      return {
        grupos: resultado,
        totalLinhasConsideradas: filtradas.length,
      };
    }

    case "ler_arquivo_texto_anexado": {
      const { arquivoId, nomeArquivo } = args as { arquivoId: string; nomeArquivo: string };
      const parsed = await carregarTexto(arquivoId, nomeArquivo);
      const offset = Math.max(Number(args.offset) || 0, 0);
      const limite = Math.min(Number(args.limite) || 4000, 20000);
      const trecho = parsed.texto.slice(offset, offset + limite);
      return {
        texto: trecho,
        offset,
        totalCaracteres: parsed.texto.length,
        temMais: offset + limite < parsed.texto.length,
      };
    }

    default:
      throw new Error(`Tool de arquivo desconhecida: ${name}`);
  }
}
