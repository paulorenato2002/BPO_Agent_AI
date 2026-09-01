import { cookies } from "next/headers";
import { usuarioAtual, PAPEIS_ADMINISTRATIVOS } from "@/lib/auth/usuario";
import { registrarEvento } from "@/lib/ferramentas/registro";
import {
  lerConfigOAuth,
  ehConfigFaltando,
  stateConfere,
  trocarCodigoPorTokens,
  NOME_COOKIE_STATE,
} from "@/lib/integracoes/google-oauth";
import { guardarRefreshTokenParaExibicao } from "@/lib/integracoes/refresh-token-temporario";

export const dynamic = "force-dynamic";

const SEM_CACHE = { "Cache-Control": "no-store" };

/** Volta para a página de integração com um motivo legível na URL. */
function redirecionar(origem: string, params: Record<string, string>) {
  const url = new URL("/integracoes/google-drive", origem);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return Response.redirect(url.toString(), 302);
}

/**
 * Retorno da autorização do Google.
 *
 * O `state` é validado ANTES de qualquer troca de código. O cookie é apagado
 * logo em seguida, em qualquer desfecho — assim um `state` não é reutilizável.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const origem = url.origin;
  const armazem = await cookies();

  const stateSalvo = armazem.get(NOME_COOKIE_STATE)?.value;
  // Consome o state imediatamente: sucesso ou falha, ele não serve mais.
  armazem.delete({ name: NOME_COOKIE_STATE, path: "/api/integracoes/google-drive" });

  const usuario = await usuarioAtual();
  if (!usuario || !PAPEIS_ADMINISTRATIVOS.includes(usuario.papel)) {
    return redirecionar(origem, { erro: "sem_permissao" });
  }

  const erroDoGoogle = url.searchParams.get("error");
  if (erroDoGoogle) {
    // `access_denied` = a pessoa clicou em cancelar. Não é falha do sistema.
    return redirecionar(origem, {
      erro: erroDoGoogle === "access_denied" ? "cancelado" : "google",
    });
  }

  const stateRecebido = url.searchParams.get("state") ?? undefined;
  if (!stateConfere(stateRecebido, stateSalvo)) {
    await registrarEvento({
      tipoEvento: "integracao_autorizacao_rejeitada",
      descricao: "Callback do Google Drive com state ausente, inválido ou reutilizado.",
      severidade: "aviso",
      usuarioId: usuario.id,
      origem: "sistema",
      dados: { integracao: "google_drive", motivo: "state_invalido" },
    });
    return redirecionar(origem, { erro: "state_invalido" });
  }

  const codigo = url.searchParams.get("code");
  if (!codigo) return redirecionar(origem, { erro: "sem_codigo" });

  const config = lerConfigOAuth();
  if (ehConfigFaltando(config)) return redirecionar(origem, { erro: "config" });

  const resultado = await trocarCodigoPorTokens(config, codigo);

  if (!resultado.ok) {
    await registrarEvento({
      tipoEvento: "integracao_autorizacao_falhou",
      descricao: "Falha ao trocar o código do Google Drive por tokens.",
      severidade: "erro",
      usuarioId: usuario.id,
      origem: "integracao",
      // Só o motivo — nunca o código nem o corpo da resposta.
      dados: {
        integracao: "google_drive",
        motivo: resultado.semRefreshToken ? "sem_refresh_token" : "troca_recusada",
      },
    });
    return redirecionar(origem, {
      erro: resultado.semRefreshToken ? "sem_refresh_token" : "troca",
    });
  }

  // O token fica só em memória do servidor, por poucos minutos, para ser
  // copiado uma única vez no ambiente local. Nunca vai para banco nem log.
  const chave = guardarRefreshTokenParaExibicao(
    usuario.id,
    resultado.refreshToken,
    resultado.email
  );

  await registrarEvento({
    tipoEvento: "integracao_autorizada",
    descricao: `Google Drive autorizado por ${usuario.nome}.`,
    usuarioId: usuario.id,
    origem: "integracao",
    dados: {
      integracao: "google_drive",
      conta: resultado.email ?? "(não identificada)",
      escopo: resultado.escopo,
    },
  });

  return redirecionar(origem, { ok: "1", chave });
}

export const headers = SEM_CACHE;
