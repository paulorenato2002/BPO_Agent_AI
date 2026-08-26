"use client";

import { useRef, useState } from "react";
import { Markdown } from "./components/Markdown";

type ToolCall = {
  id: string;
  function: { name: string; arguments: string };
};

type Anexo = { nome: string; resumo: string };

type ChatMessage = {
  role: "user" | "assistant" | "tool" | "system";
  content: string | null;
  textoExibido?: string;
  anexos?: Anexo[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type StreamEvent =
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "done"; messages: ChatMessage[] }
  | { type: "error"; message: string };

type AnexoPendente = Anexo & { blocoParaModelo: string };

const EXTENSOES_ACEITAS = ".csv,.xlsx,.xls,.pdf,.txt";

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  const [anexos, setAnexos] = useState<AnexoPendente[]>([]);
  const [enviandoArquivo, setEnviandoArquivo] = useState(false);
  const [erroArquivo, setErroArquivo] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function enviarUmArquivo(arquivo: globalThis.File): Promise<AnexoPendente | { erro: string }> {
    try {
      const formData = new FormData();
      formData.append("arquivo", arquivo);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) return { erro: `${arquivo.name}: ${data?.erro || "erro ao processar"}` };
      return { nome: data.nome, resumo: data.resumo, blocoParaModelo: data.blocoParaModelo };
    } catch {
      return { erro: `${arquivo.name}: falha de rede` };
    }
  }

  async function selecionarArquivos(e: React.ChangeEvent<HTMLInputElement>) {
    const arquivos = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (arquivos.length === 0) return;

    setErroArquivo(null);
    setEnviandoArquivo(true);
    try {
      const resultados = await Promise.all(arquivos.map(enviarUmArquivo));
      const sucesso = resultados.filter((r): r is AnexoPendente => !("erro" in r));
      const erros = resultados.filter((r): r is { erro: string } => "erro" in r);
      if (sucesso.length > 0) setAnexos((prev) => [...prev, ...sucesso]);
      if (erros.length > 0) setErroArquivo(erros.map((e) => e.erro).join(" · "));
    } finally {
      setEnviandoArquivo(false);
    }
  }

  function removerAnexo(nome: string) {
    setAnexos((prev) => prev.filter((a) => a.nome !== nome));
  }

  async function enviar() {
    const texto = input.trim();
    if ((!texto && anexos.length === 0) || loading || enviandoArquivo) return;

    const conteudoModelo =
      anexos.length > 0
        ? `${anexos.map((a) => a.blocoParaModelo).join("\n\n")}\n\n${texto || "Processe os arquivos anexados."}`
        : texto;

    const novaHistoria: ChatMessage[] = [
      ...messages,
      {
        role: "user",
        content: conteudoModelo,
        textoExibido: texto || undefined,
        anexos: anexos.length > 0 ? anexos.map(({ nome, resumo }) => ({ nome, resumo })) : undefined,
      },
    ];
    setMessages(novaHistoria);
    setInput("");
    setAnexos([]);
    setLoading(true);
    setErro(null);
    setStreamingText("");
    setStatus("Pensando...");

    try {
      // manda só os campos que o backend/OpenAI esperam — textoExibido/anexos
      // são metadado de exibição local, não fazem parte da mensagem "oficial".
      const paraEnviar = novaHistoria.map(({ role, content, tool_calls, tool_call_id }) => ({
        role,
        content,
        tool_calls,
        tool_call_id,
      }));

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: paraEnviar }),
      });

      if (!res.ok || !res.body) {
        setErro("Erro ao chamar o agente.");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const linhas = buffer.split("\n");
        buffer = linhas.pop() ?? "";

        for (const linha of linhas) {
          if (!linha.trim()) continue;
          const evento = JSON.parse(linha) as StreamEvent;

          if (evento.type === "status") {
            setStatus(evento.text);
          } else if (evento.type === "delta") {
            setStatus(null);
            setStreamingText((prev) => prev + evento.text);
          } else if (evento.type === "done") {
            setMessages((prev) => mesclarHistoriaOficial(prev, evento.messages));
            setStreamingText("");
            setStatus(null);
          } else if (evento.type === "error") {
            setErro(evento.message);
            setStatus(null);
          }
        }
      }
    } catch {
      setErro("Falha de rede ao chamar o agente.");
    } finally {
      setLoading(false);
      setStatus(null);
    }
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-2xl flex-col p-4">
      <h1 className="mb-4 text-lg font-semibold">Agente BPO — teste de CRUD</h1>

      <div className="flex-1 space-y-3 overflow-y-auto rounded-lg border border-black/10 p-4 dark:border-white/10">
        {messages.length === 0 && !streamingText && (
          <p className="text-sm text-black/50 dark:text-white/50">
            Pergunte algo como &quot;liste as empresas ativas&quot; ou anexe uma
            ou mais planilhas, PDFs ou txt para importar/analisar dados.
          </p>
        )}
        {messages
          .filter((m) => m.role === "user" || (m.role === "assistant" && m.content))
          .map((m, i) => (
            <MessageBubble key={i} message={m} />
          ))}
        {streamingText && (
          <MessageBubble message={{ role: "assistant", content: streamingText }} />
        )}
        {status && (
          <p className="text-sm text-black/50 dark:text-white/50">{status}</p>
        )}
        {erro && <p className="text-sm text-red-600">{erro}</p>}
      </div>

      {(anexos.length > 0 || enviandoArquivo || erroArquivo) && (
        <div className="mt-3 space-y-1">
          {anexos.map((a) => (
            <div
              key={a.nome}
              className="flex items-center gap-2 rounded-lg border border-black/10 px-3 py-2 text-xs dark:border-white/10"
            >
              <span aria-hidden>📎</span>
              <span className="flex-1 truncate">{a.resumo}</span>
              <button
                onClick={() => removerAnexo(a.nome)}
                className="rounded px-1 text-black/50 hover:bg-black/10 hover:text-black dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white"
                aria-label={`Remover ${a.nome}`}
              >
                ×
              </button>
            </div>
          ))}
          {enviandoArquivo && (
            <div className="flex items-center gap-2 rounded-lg border border-black/10 px-3 py-2 text-xs text-black/50 dark:border-white/10 dark:text-white/50">
              <span aria-hidden>📎</span>
              <span>Processando arquivo(s)...</span>
            </div>
          )}
          {erroArquivo && (
            <div className="flex items-center gap-2 rounded-lg border border-black/10 px-3 py-2 text-xs text-red-600 dark:border-white/10">
              <span aria-hidden>📎</span>
              <span>{erroArquivo}</span>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={EXTENSOES_ACEITAS}
          onChange={selecionarArquivos}
          className="hidden"
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={loading || enviandoArquivo}
          title="Anexar planilhas, PDFs ou txt"
          className="rounded-lg border border-black/10 px-3 py-2 text-black/60 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:text-white/60 dark:hover:bg-white/10"
        >
          📎
        </button>
        <input
          className="flex-1 rounded-lg border border-black/10 px-3 py-2 dark:border-white/10 dark:bg-transparent"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && enviar()}
          placeholder="Digite uma mensagem..."
          disabled={loading}
        />
        <button
          onClick={enviar}
          disabled={loading || enviandoArquivo}
          className="rounded-lg bg-black px-4 py-2 text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          Enviar
        </button>
      </div>
    </div>
  );
}

// O servidor devolve o histórico "oficial" (com tool_calls/tool já embutidos,
// sem textoExibido/anexos). Reaplica os campos só-de-exibição por cima, casando
// pela posição das mensagens de usuário já existentes no client.
function mesclarHistoriaOficial(
  atual: ChatMessage[],
  oficial: ChatMessage[]
): ChatMessage[] {
  const exibicaoPorIndiceUsuario = atual
    .filter((m) => m.role === "user")
    .map((m) => ({ textoExibido: m.textoExibido, anexos: m.anexos }));

  let cursor = 0;
  return oficial.map((m) => {
    if (m.role !== "user") return m;
    const extra = exibicaoPorIndiceUsuario[cursor];
    cursor += 1;
    return extra ? { ...m, ...extra } : m;
  });
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const textoExibido = isUser ? message.textoExibido ?? message.content : message.content;

  if (!textoExibido && !message.anexos?.length) return null;

  if (isUser) {
    return (
      <div className="ml-auto max-w-[85%] space-y-1">
        {message.anexos?.map((a) => (
          <div
            key={a.nome}
            className="ml-auto w-fit rounded-lg bg-black/5 px-2 py-1 text-xs text-black/60 dark:bg-white/10 dark:text-white/60"
          >
            📎 {a.resumo}
          </div>
        ))}
        {textoExibido && (
          <div className="ml-auto w-fit rounded-lg bg-blue-600 px-3 py-2 text-sm whitespace-pre-wrap text-white">
            {textoExibido}
          </div>
        )}
      </div>
    );
  }

  if (!message.content) return null;

  return (
    <div className="max-w-[85%] rounded-lg bg-black/5 px-3 py-2 dark:bg-white/10">
      <Markdown>{message.content}</Markdown>
    </div>
  );
}
