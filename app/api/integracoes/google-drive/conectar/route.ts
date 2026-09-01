import { cookies } from "next/headers";
import { usuarioAtual, PAPEIS_ADMINISTRATIVOS } from "@/lib/auth/usuario";
import { registrarEvento } from "@/lib/ferramentas/registro";
import {
  lerConfigOAuth,
  ehConfigFaltando,
  gerarState,
  montarUrlAutorizacao,
  NOME_COOKIE_STATE,
} from "@/lib/integracoes/google-oauth";

export const dynamic = "force-dynamic";

/**
 * Inicia a autorização do Google Drive.
 *
 * Só administrador ou sócio pode conectar: a integração vale para a empresa
 * inteira, então não é decisão de qualquer colaborador.
 */
export async function GET() {
  const usuario = await usuarioAtual();

  if (!usuario) {
    return Response.json(
      { ok: false, erro: "Faça login para conectar o Google Drive." },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  if (!PAPEIS_ADMINISTRATIVOS.includes(usuario.papel)) {
    await registrarEvento({
      tipoEvento: "acesso_negado",
      descricao: "Tentativa de conectar o Google Drive sem papel autorizado.",
      severidade: "aviso",
      usuarioId: usuario.id,
      origem: "usuario",
      dados: { papel: usuario.papel, recurso: "google_drive_conectar" },
    });
    return Response.json(
      { ok: false, erro: "Apenas administrador ou sócio pode conectar integrações." },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    );
  }

  const config = lerConfigOAuth();
  if (ehConfigFaltando(config)) {
    return Response.json(
      {
        ok: false,
        erro: `Configuração incompleta. Defina no .env.local: ${config.faltando.join(", ")}.`,
      },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  // `state` amarra o retorno do Google a esta sessão. Fica em cookie httpOnly
  // — o navegador devolve, mas o JavaScript da página não consegue ler.
  const state = gerarState();
  const armazem = await cookies();
  armazem.set(NOME_COOKIE_STATE, state, {
    httpOnly: true,
    sameSite: "lax", // precisa sobreviver ao redirect de volta do Google
    secure: process.env.NODE_ENV === "production",
    path: "/api/integracoes/google-drive",
    maxAge: 600, // 10 min: tempo de autorizar, não mais que isso
  });

  await registrarEvento({
    tipoEvento: "integracao_autorizacao_iniciada",
    descricao: `${usuario.nome} iniciou a conexão com o Google Drive.`,
    usuarioId: usuario.id,
    origem: "usuario",
    dados: { integracao: "google_drive" },
  });

  return Response.redirect(montarUrlAutorizacao(config, state), 302);
}
