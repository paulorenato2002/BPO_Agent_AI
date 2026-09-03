import type {
  ChatCompletionMessageParam,
  ChatCompletionChunk,
} from "openai/resources/chat/completions";
import { openai, CHAT_MODEL, REASONING_EFFORT } from "@/lib/openai-client";
import { dbTools, executeDbTool } from "@/lib/db-tools";
import { fileTools, executeFileTool } from "@/lib/file-tools";
import { registrarFerramentasDeNegocio } from "@/lib/ferramentas/catalogo";
import { executarFerramenta } from "@/lib/ferramentas/registro";
import type { ContextoExecucao } from "@/lib/ferramentas/tipos";
import { usuarioAtual } from "@/lib/auth/usuario";
import {
  conversaPertenceAoUsuario,
  salvarMensagem,
  atualizarMensagem,
  definirTituloSeNecessario,
} from "@/lib/repositorios/conversas";

export const dynamic = "force-dynamic";

// As ferramentas de negocio (arquivador) vivem no registro, que valida
// entrada, exige contexto de usuario e grava a execucao. As de banco e de
// arquivo sao anteriores a ele e continuam com o despacho proprio.
const registro = registrarFerramentasDeNegocio();
const ferramentasDeNegocio = registro.comoToolsOpenAI();
const NOMES_NEGOCIO = new Set(ferramentasDeNegocio.map((t) => t.function.name));

const TOOLS = [...dbTools, ...fileTools, ...ferramentasDeNegocio];
const NOMES_FILE_TOOLS = new Set(fileTools.map((t) => t.function.name));

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  contexto: ContextoExecucao
): Promise<unknown> {
  if (NOMES_NEGOCIO.has(name)) {
    // O registro devolve { ok, saida, resumo } — o modelo le esse objeto
    // inteiro, entao o resumo em texto vai junto de proposito: e o que ele
    // usa para contar ao usuario sem inventar.
    return executarFerramenta(name, args, contexto);
  }
  return NOMES_FILE_TOOLS.has(name) ? executeFileTool(name, args) : executeDbTool(name, args);
}

const SYSTEM_PROMPT = `Você é o assistente de dados do BPO financeiro. Você tem acesso de leitura e
escrita ao banco de dados via tools (listar_tabelas, descrever_tabela, consultar_dados,
inserir_dado, inserir_varios_dados, atualizar_dado, deletar_dado).

Regras:
- Antes de inserir ou atualizar, confira com descrever_tabela quais colunas existem.
- Nunca invente ids, nomes de tabela ou de coluna: sempre confirme via tool.
- Quando descrever_tabela trouxer "valoresPermitidos" para uma coluna, use
  EXATAMENTE um daqueles valores, respeitando maiúsculas e minúsculas. Não
  traduza nem "melhore" o valor: o banco aceita 'matriz', e não 'MATRIZ'.
  Se o usuário pedir algo que não está na lista, mostre as opções e pergunte.
- Quando houver "formato" (regex), normalize o valor antes de gravar — por
  exemplo, CNPJ vai só com os 14 dígitos, sem pontuação.
- Respeite também "regrasAdicionais": são regras que envolvem mais de uma
  coluna (ex.: onboarding cancelado exige motivo_cancelamento preenchido).
- Antes de chamar deletar_dado, explique o que vai ser apagado e peça confirmação
  explícita do usuário na conversa. Só chame a tool depois que o usuário confirmar.
- Responda sempre em português, de forma direta.

Arquivar documentos na pasta da empresa:
- Quando o usuário anexar documentos e pedir para ARQUIVAR, organizar, guardar
  ou salvar na pasta, use analisar_documentos passando o anexoId que veio no
  bloco do arquivo (campo "anexoId", não confunda com "arquivoId").
- analisar_documentos NÃO arquiva nada. Ela devolve uma PROPOSTA. Mostre ao
  usuário, para cada arquivo: a empresa identificada, a competência, o destino
  e as evidências (por que você concluiu aquilo). Se vier campo faltando ou
  conflito, pergunte — não escolha por conta própria.
- Cada arquivo é analisado sozinho. Um lote pode ter empresas diferentes, e
  isso precisa aparecer na sua resposta.
- Só chame arquivar_documentos DEPOIS que o usuário disser claramente quais
  arquivos quer arquivar. "ok", "pode", "isso", "beleza" ou silêncio NÃO são
  confirmação de itens específicos: se houver qualquer dúvida sobre QUAIS
  arquivos, pergunte antes. Arquivar é irreversível na prática.
- Ao chamar arquivar_documentos, passe o propostaId, confirmar=true e a lista
  exata dos anexoIds que o usuário confirmou. Item fora da lista não é
  arquivado.
- Depois, conte o que aconteceu com cada arquivo: onde ficou, se já existia,
  ou por que falhou. Não diga que arquivou algo que voltou com erro.

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
  analisar_documentos: "Analisando os documentos...",
  arquivar_documentos: "Arquivando na pasta...",
};

type AccTool = { id: string; function: { name: string; arguments: string } };

function sseLine(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

export async function POST(request: Request) {
  const usuario = await usuarioAtual();
  if (!usuario) {
    return Response.json(
      { erro: "Sessão expirada. Entre novamente." },
      { status: 401 }
    );
  }

  const body = await request.json();
  const clientMessages = (body?.messages ?? []) as ChatCompletionMessageParam[];
  const conversaId =
    typeof body?.conversaId === "string" ? body.conversaId : null;

  // A conversa precisa ser do próprio usuário. Sem isso, um id de outra pessoa
  // no corpo da requisição gravaria mensagem na conversa alheia.
  let persistir = false;
  if (conversaId) {
    persistir = await conversaPertenceAoUsuario(usuario.id, conversaId);
    if (!persistir) {
      return Response.json({ erro: "Conversa não encontrada." }, { status: 404 });
    }
  }

  const ultimaDoUsuario = [...clientMessages]
    .reverse()
    .find((m) => m.role === "user");
  const textoUsuario =
    typeof ultimaDoUsuario?.content === "string" ? ultimaDoUsuario.content : "";

  // A mensagem do usuário é gravada como CONCLUÍDA antes de chamar o modelo.
  // Se a geração falhar depois, o que a pessoa escreveu não se perde.
  let tituloNovo: string | null = null;
  if (persistir && conversaId && textoUsuario) {
    await salvarMensagem(conversaId, {
      papel: "usuario",
      conteudo: textoUsuario,
      status: "concluida",
    });
    tituloNovo = await definirTituloSeNecessario(conversaId, textoUsuario);
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...clientMessages,
  ];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(sseLine(obj));

      // Reserva a resposta do agente já como "processando", para que uma falha
      // no meio do caminho deixe rastro em vez de sumir.
      let mensagemAgenteId: string | null = null;
      if (persistir && conversaId) {
        const r = await salvarMensagem(conversaId, {
          papel: "agente",
          conteudo: null,
          status: "processando",
        });
        if (r.ok) mensagemAgenteId = r.dados;
      }

      if (tituloNovo) send({ type: "titulo", titulo: tituloNovo });

      let textoFinal = "";

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
              textoFinal += delta.content;
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
            if (mensagemAgenteId) {
              await atualizarMensagem(mensagemAgenteId, {
                conteudo: textoFinal,
                status: "concluida",
              });
            }
            send({ type: "done", messages: messages.slice(1) });
            controller.close();
            return;
          }

          for (const call of toolCalls) {
            let result: unknown;
            try {
              const args = JSON.parse(call.function.arguments || "{}");
              result = await executeTool(call.function.name, args, {
                usuarioId: usuario.id,
                // Só entra no contexto se a conversa for mesmo do usuário:
                // `persistir` já carrega essa checagem.
                conversaId: persistir ? conversaId : null,
                mensagemId: mensagemAgenteId,
                chaveIdempotencia: null,
              });
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

        if (mensagemAgenteId) {
          await atualizarMensagem(mensagemAgenteId, {
            conteudo: textoFinal || null,
            status: "erro",
            tipoMensagem: "erro",
          });
        }
        send({
          type: "error",
          message: "Número máximo de chamadas de ferramentas atingido.",
        });
        controller.close();
      } catch (err) {
        // A mensagem do usuário já está gravada; aqui só registramos que a
        // resposta falhou, sem apagar nada.
        if (mensagemAgenteId) {
          await atualizarMensagem(mensagemAgenteId, {
            conteudo: textoFinal || null,
            status: "erro",
            tipoMensagem: "erro",
            metadados: { erro: err instanceof Error ? err.message : String(err) },
          });
        }
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
