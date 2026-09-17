import "server-only";
import { timingSafeEqual } from "node:crypto";

export const CONTA_EMAIL_EFFECTIVE = "effective.bpo@gmail.com";
export const LIMITE_CORPO_WEBHOOK_BYTES = 512 * 1024;

export type AnexoEmailN8n = {
  id: string | null;
  nome: string;
  mimeType: string;
  tamanhoBytes: number | null;
};

export type EventoEmailN8n = {
  versao: 1;
  eventoId: string;
  threadId: string | null;
  contaEmail: string;
  remetente: string;
  destinatarios: string[];
  cc: string[];
  assunto: string;
  resumo: string;
  corpoTexto: string | null;
  recebidoEm: string;
  anexos: AnexoEmailN8n[];
};

function texto(valor: unknown, limite: number): string | null {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();
  return limpo ? limpo.slice(0, limite) : null;
}

function listaTextos(valor: unknown, limiteItens = 100): string[] {
  if (!Array.isArray(valor)) return [];
  return valor.slice(0, limiteItens).flatMap((item) => {
    const limpo = texto(item, 500);
    return limpo ? [limpo] : [];
  });
}

export function autenticarWebhookN8n(authorization: string | null): boolean {
  const esperado = process.env.N8N_EMAIL_WEBHOOK_SECRET;
  if (!esperado || esperado.length < 32 || !authorization?.startsWith("Bearer ")) return false;
  const recebido = authorization.slice("Bearer ".length);
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validarEventoEmailN8n(valor: unknown):
  | { ok: true; evento: EventoEmailN8n }
  | { ok: false; erro: string } {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) {
    return { ok: false, erro: "payload_invalido" };
  }
  const dado = valor as Record<string, unknown>;
  const eventoId = texto(dado.eventoId, 255);
  const contaEmail = texto(dado.contaEmail, 320)?.toLowerCase();
  const remetente = texto(dado.remetente, 1000);
  const recebidoEm = texto(dado.recebidoEm, 100);

  if (dado.versao !== 1) return { ok: false, erro: "versao_invalida" };
  if (!eventoId || !contaEmail || !remetente || !recebidoEm) {
    return { ok: false, erro: "campos_obrigatorios_ausentes" };
  }
  if (contaEmail !== CONTA_EMAIL_EFFECTIVE) {
    return { ok: false, erro: "conta_nao_autorizada" };
  }
  const data = new Date(recebidoEm);
  if (Number.isNaN(data.getTime())) return { ok: false, erro: "data_invalida" };

  const anexosBrutos = Array.isArray(dado.anexos) ? dado.anexos.slice(0, 100) : [];
  const anexos: AnexoEmailN8n[] = [];
  for (const bruto of anexosBrutos) {
    if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) continue;
    const item = bruto as Record<string, unknown>;
    const nome = texto(item.nome, 500);
    if (!nome) continue;
    anexos.push({
      id: texto(item.id, 500),
      nome,
      mimeType: texto(item.mimeType, 200) ?? "application/octet-stream",
      tamanhoBytes:
        typeof item.tamanhoBytes === "number" && Number.isSafeInteger(item.tamanhoBytes) && item.tamanhoBytes >= 0
          ? item.tamanhoBytes
          : null,
    });
  }

  return {
    ok: true,
    evento: {
      versao: 1,
      eventoId,
      threadId: texto(dado.threadId, 255),
      contaEmail,
      remetente,
      destinatarios: listaTextos(dado.destinatarios),
      cc: listaTextos(dado.cc),
      assunto: texto(dado.assunto, 2000) ?? "",
      resumo: texto(dado.resumo, 5000) ?? "",
      corpoTexto: texto(dado.corpoTexto, 300_000),
      recebidoEm: data.toISOString(),
      anexos,
    },
  };
}
