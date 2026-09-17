import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  autenticarWebhookN8n,
  LIMITE_CORPO_WEBHOOK_BYTES,
  validarEventoEmailN8n,
} from "@/lib/integracoes/n8n-email-webhook";

export const dynamic = "force-dynamic";

const SEM_CACHE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  if (!autenticarWebhookN8n(request.headers.get("authorization"))) {
    return Response.json({ ok: false, erro: "nao_autorizado" }, { status: 401, headers: SEM_CACHE });
  }
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return Response.json({ ok: false, erro: "content_type_invalido" }, { status: 415, headers: SEM_CACHE });
  }
  const tamanhoDeclarado = Number(request.headers.get("content-length") ?? "0");
  if (tamanhoDeclarado > LIMITE_CORPO_WEBHOOK_BYTES) {
    return Response.json({ ok: false, erro: "payload_muito_grande" }, { status: 413, headers: SEM_CACHE });
  }

  let bruto: unknown;
  try {
    const conteudo = await request.text();
    if (Buffer.byteLength(conteudo, "utf8") > LIMITE_CORPO_WEBHOOK_BYTES) {
      return Response.json({ ok: false, erro: "payload_muito_grande" }, { status: 413, headers: SEM_CACHE });
    }
    bruto = JSON.parse(conteudo);
  } catch {
    return Response.json({ ok: false, erro: "json_invalido" }, { status: 400, headers: SEM_CACHE });
  }

  const validacao = validarEventoEmailN8n(bruto);
  if (!validacao.ok) {
    return Response.json({ ok: false, erro: validacao.erro }, { status: 400, headers: SEM_CACHE });
  }
  const evento = validacao.evento;
  const { data, error } = await supabaseAdmin
    .from("email_eventos")
    .upsert(
      {
        provedor: "gmail",
        provedor_evento_id: evento.eventoId,
        provedor_thread_id: evento.threadId,
        conta_email: evento.contaEmail,
        remetente: evento.remetente,
        destinatarios: evento.destinatarios,
        cc: evento.cc,
        assunto: evento.assunto,
        resumo: evento.resumo,
        corpo_texto: evento.corpoTexto,
        recebido_em: evento.recebidoEm,
        tem_anexos: evento.anexos.length > 0,
        anexos: evento.anexos,
      },
      { onConflict: "provedor,provedor_evento_id", ignoreDuplicates: true }
    )
    .select("id")
    .maybeSingle();

  if (error) {
    return Response.json({ ok: false, erro: "persistencia_indisponivel" }, { status: 503, headers: SEM_CACHE });
  }
  return Response.json(
    { ok: true, recebido: Boolean(data), duplicado: !data },
    { status: data ? 201 : 200, headers: SEM_CACHE }
  );
}
