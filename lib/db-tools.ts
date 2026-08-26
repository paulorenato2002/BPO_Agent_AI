import "server-only";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import { supabaseAdmin } from "./supabase-admin";
import schema from "./db-schema.json";

type SchemaColumn = {
  nome: string;
  tipo: string;
  obrigatorio: boolean;
  pk?: boolean;
  fk?: { tabela: string; coluna: string };
};

const TABLE_SCHEMA = schema as Record<string, SchemaColumn[]>;
const TABLE_NAMES = Object.keys(TABLE_SCHEMA);
const MAX_ROWS = 100;

function assertTabelaValida(tabela: string): void {
  if (!TABLE_NAMES.includes(tabela)) {
    throw new Error(
      `Tabela "${tabela}" não existe. Tabelas disponíveis: ${TABLE_NAMES.join(", ")}`
    );
  }
}

export const dbTools: ChatCompletionFunctionTool[] = [
  {
    type: "function",
    function: {
      name: "listar_tabelas",
      description:
        "Lista todas as tabelas disponíveis no banco de dados do BPO.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "descrever_tabela",
      description:
        "Retorna as colunas de uma tabela (nome, tipo, se é obrigatória, chave primária e chaves estrangeiras).",
      parameters: {
        type: "object",
        properties: {
          tabela: { type: "string", description: "Nome exato da tabela." },
        },
        required: ["tabela"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "consultar_dados",
      description:
        "Consulta linhas de uma tabela, com filtros de igualdade opcionais.",
      parameters: {
        type: "object",
        properties: {
          tabela: { type: "string", description: "Nome exato da tabela." },
          colunas: {
            type: "array",
            items: { type: "string" },
            description: "Colunas a retornar. Se omitido, retorna todas.",
          },
          filtros: {
            type: "object",
            description:
              "Pares coluna:valor para filtrar por igualdade exata (ex: {\"ativo\": true}).",
            additionalProperties: true,
          },
          limite: {
            type: "integer",
            description: `Máximo de linhas a retornar (padrão 20, máximo ${MAX_ROWS}).`,
          },
        },
        required: ["tabela"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inserir_dado",
      description: "Insere uma nova linha em uma tabela.",
      parameters: {
        type: "object",
        properties: {
          tabela: { type: "string", description: "Nome exato da tabela." },
          dados: {
            type: "object",
            description: "Pares coluna:valor a inserir.",
            additionalProperties: true,
          },
        },
        required: ["tabela", "dados"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inserir_varios_dados",
      description:
        "Insere várias linhas de uma vez na mesma tabela (import em lote, ex: vindo de uma planilha anexada). Mais eficiente que chamar inserir_dado repetidas vezes.",
      parameters: {
        type: "object",
        properties: {
          tabela: { type: "string", description: "Nome exato da tabela." },
          linhas: {
            type: "array",
            items: { type: "object", additionalProperties: true },
            description: "Lista de objetos coluna:valor, um por linha a inserir.",
          },
        },
        required: ["tabela", "linhas"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "atualizar_dado",
      description: "Atualiza a linha de uma tabela pelo id (uuid).",
      parameters: {
        type: "object",
        properties: {
          tabela: { type: "string", description: "Nome exato da tabela." },
          id: { type: "string", description: "uuid da linha (coluna id)." },
          dados: {
            type: "object",
            description: "Pares coluna:valor a atualizar.",
            additionalProperties: true,
          },
        },
        required: ["tabela", "id", "dados"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deletar_dado",
      description:
        "Apaga (delete físico) a linha de uma tabela pelo id. Só chame depois de o usuário confirmar explicitamente na conversa.",
      parameters: {
        type: "object",
        properties: {
          tabela: { type: "string", description: "Nome exato da tabela." },
          id: { type: "string", description: "uuid da linha (coluna id)." },
        },
        required: ["tabela", "id"],
        additionalProperties: false,
      },
    },
  },
];

export async function executeDbTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case "listar_tabelas": {
      return { tabelas: TABLE_NAMES };
    }

    case "descrever_tabela": {
      const tabela = String(args.tabela);
      assertTabelaValida(tabela);
      return { tabela, colunas: TABLE_SCHEMA[tabela] };
    }

    case "consultar_dados": {
      const tabela = String(args.tabela);
      assertTabelaValida(tabela);
      const colunas = (args.colunas as string[] | undefined)?.join(",") || "*";
      const limite = Math.min(
        Number(args.limite) || 20,
        MAX_ROWS
      );
      let query = supabaseAdmin.from(tabela).select(colunas).limit(limite);
      const filtros = (args.filtros as Record<string, unknown>) || {};
      for (const [coluna, valor] of Object.entries(filtros)) {
        query = query.eq(coluna, valor);
      }
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return { linhas: data, total: data?.length ?? 0 };
    }

    case "inserir_dado": {
      const tabela = String(args.tabela);
      assertTabelaValida(tabela);
      const dados = args.dados as Record<string, unknown>;
      const { data, error } = await supabaseAdmin
        .from(tabela)
        .insert(dados)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return { inserido: data };
    }

    case "inserir_varios_dados": {
      const tabela = String(args.tabela);
      assertTabelaValida(tabela);
      const linhas = args.linhas as Record<string, unknown>[];
      if (!Array.isArray(linhas) || linhas.length === 0) {
        throw new Error("`linhas` precisa ser uma lista não-vazia de objetos.");
      }
      const { data, error } = await supabaseAdmin.from(tabela).insert(linhas).select();
      if (error) throw new Error(error.message);
      return { inseridos: data, total: data?.length ?? 0 };
    }

    case "atualizar_dado": {
      const tabela = String(args.tabela);
      assertTabelaValida(tabela);
      const id = String(args.id);
      const dados = args.dados as Record<string, unknown>;
      const { data, error } = await supabaseAdmin
        .from(tabela)
        .update(dados)
        .eq("id", id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return { atualizado: data };
    }

    case "deletar_dado": {
      const tabela = String(args.tabela);
      assertTabelaValida(tabela);
      const id = String(args.id);
      const { data, error } = await supabaseAdmin
        .from(tabela)
        .delete()
        .eq("id", id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return { deletado: data };
    }

    default:
      throw new Error(`Tool desconhecida: ${name}`);
  }
}
