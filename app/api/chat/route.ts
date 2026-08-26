import type {
  ChatCompletionMessageParam,
  ChatCompletionChunk,
} from "openai/resources/chat/completions";
import { openai, CHAT_MODEL, REASONING_EFFORT } from "@/lib/openai-client";
import { dbTools, executeDbTool } from "@/lib/db-tools";
import { fileTools, executeFileTool } from "@/lib/file-tools";

export const dynamic = "force-dynamic";

const TOOLS = [...dbTools, ...fileTools];
const NOMES_FILE_TOOLS = new Set(fileTools.map((t) => t.function.name));

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  return NOMES_FILE_TOOLS.has(name) ? executeFileTool(name, args) : executeDbTool(name, args);
}

const SYSTEM_PROMPT = `Você é o assistente de dados do BPO financeiro. Você tem acesso de leitura e
escrita ao banco de dados via tools (listar_tabelas, descrever_tabela, consultar_dados,
inserir_dado, inserir_varios_dados, atualizar_dado, deletar_dado).

Regras:
- Antes de inserir ou atualizar, confira com descrever_tabela quais colunas existem.
- Nunca invente ids, nomes de tabela ou de coluna: sempre confirme via tool.
- Antes de chamar deletar_dado, explique o que vai ser apagado e peça confirmação
  explícita do usuário na conversa. Só chame a tool depois que o usuário confirmar.
- Responda sempre em português, de forma direta.

Arquivos anexados:
- Quando a mensagem do usuário contiver um ou mais blocos "[Arquivo anexado pelo usuário:
  nome]\\nid: <arquivoId>", cada bloco traz um resumo e uma PRÉVIA (não o arquivo inteiro —
  arquivos grandes são truncados na prévia de propósito). Não peça o arquivo de novo.
- Para ver mais do que veio na prévia, use as tools de arquivo, sempre passando o arquivoId
  e nomeArquivo exatos do bloco:
  - consultar_arquivo_anexado: pra listar/filtrar linhas de planilha/CSV além da prévia.
  - agregar_arquivo_anexado: pra somar ou contar por categoria (ex: total por tipo de
    lançamento) sem precisar ler linha por linha — prefira essa tool a somar manualmente
    quando o pedido for "quanto foi gasto com X" ou parecido.
  - ler_arquivo_texto_anexado: pra continuar lendo um PDF/TXT além da prévia, paginando
    por offset de caracteres.
- Para importar dados de uma planilha/CSV pro banco: confira as colunas reais da tabela de
  destino com descrever_tabela, mapeie as colunas do arquivo pra elas (os nomes quase nunca
  batem exatamente), busque as linhas completas com consultar_arquivo_anexado (paginando se
  for muita linha) e importe em lotes com inserir_varios_dados. Mostre um resumo do que vai
  importar e peça confirmação antes, especialmente se forem muitas linhas.
- Se o resumo do arquivo avisar que ele passou do teto de segurança e foi cortado, avise o
  usuário antes de prosseguir com qualquer análise ou importação.`;

const MAX_TOOL_ITERATIONS = 8;

// Textos amigáveis por tool, exibidos como indicador efêmero no chat
// enquanto o payload real (args/resultado) fica só no servidor e nos logs.
const STATUS_POR_TOOL: Record<string, string> = {
  listar_tabelas: "Consultando o banco...",
  descrever_tabela: "Consultando o banco...",
  consultar_dados: "Consultando o banco...",
  inserir_dado: "Registrando no banco...",
  inserir_varios_dados: "Importando dados...",
  atualizar_dado: "Atualizando registro...",
  deletar_dado: "Removendo registro...",
  consultar_arquivo_anexado: "Lendo arquivo anexado...",
  agregar_arquivo_anexado: "Somarizando arquivo anexado...",
  ler_arquivo_texto_anexado: "Lendo arquivo anexado...",
};

type AccTool = { id: string; function: { name: string; arguments: string } };

function sseLine(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

export async function POST(request: Request) {
  const body = await request.json();
  const clientMessages = (body?.messages ?? []) as ChatCompletionMessageParam[];

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...clientMessages,
  ];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(sseLine(obj));

      try {
        for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
          send({ type: "status", text: "Pensando..." });

          const completion = await openai.chat.completions.create({
            model: CHAT_MODEL,
            messages,
            tools: TOOLS,
            stream: true,
            ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT } : {}),
          });

          let content = "";
          const toolCallsAcc: Record<number, AccTool> = {};
          let announcedTool = false;

          for await (const chunk of completion as AsyncIterable<ChatCompletionChunk>) {
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              content += delta.content;
              send({ type: "delta", text: delta.content });
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const acc = (toolCallsAcc[tc.index] ??= {
                  id: "",
                  function: { name: "", arguments: "" },
                });
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.function.name += tc.function.name;
                if (tc.function?.arguments)
                  acc.function.arguments += tc.function.arguments;

                if (!announcedTool && acc.function.name) {
                  announcedTool = true;
                  send({
                    type: "status",
                    text: STATUS_POR_TOOL[acc.function.name] ?? "Processando...",
                  });
                }
              }
            }
          }

          const toolCalls = Object.values(toolCallsAcc).map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: tc.function,
          }));

          messages.push({
            role: "assistant",
            content: content || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });

          if (toolCalls.length === 0) {
            send({ type: "done", messages: messages.slice(1) });
            controller.close();
            return;
          }

          for (const call of toolCalls) {
            let result: unknown;
            try {
              const args = JSON.parse(call.function.arguments || "{}");
              result = await executeTool(call.function.name, args);
            } catch (err) {
              result = { erro: err instanceof Error ? err.message : String(err) };
            }
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(result),
            });
          }
        }

        send({
          type: "error",
          message: "Número máximo de chamadas de ferramentas atingido.",
        });
        controller.close();
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
