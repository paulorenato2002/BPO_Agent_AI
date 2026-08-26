import "server-only";
import OpenAI from "openai";
import type { ReasoningEffort } from "openai/resources/shared";

const apiKey = process.env.GPT_API_KEY;

if (!apiKey) {
  throw new Error("Falta GPT_API_KEY no .env");
}

export const openai = new OpenAI({ apiKey });

export const CHAT_MODEL = process.env.OPENAI_MODEL || "gpt-5.5";

// Alguns modelos (ex: gpt-5.6-sol) só aceitam function tools em
// /v1/chat/completions se reasoning_effort vier explícito (senão dão 400).
// Fica opt-in via env pra não afetar modelos que já funcionam sem isso.
const VALORES_REASONING_EFFORT = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function validarReasoningEffort(valor: string | undefined): ReasoningEffort | undefined {
  if (!valor) return undefined;
  if ((VALORES_REASONING_EFFORT as readonly string[]).includes(valor)) {
    return valor as ReasoningEffort;
  }
  throw new Error(
    `OPENAI_REASONING_EFFORT="${valor}" inválido. Valores aceitos: ${VALORES_REASONING_EFFORT.join(", ")}.`
  );
}

export const REASONING_EFFORT = validarReasoningEffort(process.env.OPENAI_REASONING_EFFORT);
