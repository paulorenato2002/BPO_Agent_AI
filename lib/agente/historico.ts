import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/** Recupera conversas antigas que descartavam resultados de ferramentas.
 * Nunca envia um tool_call órfão à API nem repete instruções de sistema do cliente. */
export function sanearHistorico(entrada: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const saida: ChatCompletionMessageParam[] = [];
  for (let i = 0; i < entrada.length; i++) {
    const mensagem = entrada[i];
    if (mensagem.role === "user") { saida.push(mensagem); continue; }
    if (mensagem.role !== "assistant") continue;
    if (!mensagem.tool_calls?.length) { saida.push(mensagem); continue; }
    const respostas: Extract<ChatCompletionMessageParam, { role: "tool" }>[] = [];
    let fim = i + 1;
    while (fim < entrada.length && entrada[fim].role === "tool") {
      respostas.push(entrada[fim] as Extract<ChatCompletionMessageParam, { role: "tool" }>);
      fim++;
    }
    const chamadas = mensagem.tool_calls.filter(c => respostas.some(r => r.tool_call_id === c.id));
    if (chamadas.length) {
      saida.push({ ...mensagem, tool_calls: chamadas });
      for (const chamada of chamadas) saida.push(respostas.find(r => r.tool_call_id === chamada.id)!);
    } else if (mensagem.content) {
      const texto = { ...mensagem };
      delete texto.tool_calls;
      saida.push(texto);
    }
    i = fim - 1;
  }
  return saida;
}
