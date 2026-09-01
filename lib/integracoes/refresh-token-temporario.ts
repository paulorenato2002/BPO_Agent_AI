import "server-only";
import { randomBytes } from "node:crypto";

/**
 * Guarda temporário do refresh token, para exibição ÚNICA no ambiente local.
 *
 * Por que existe: o refresh token só aparece uma vez, no retorno do OAuth. Sem
 * um lugar para mostrá-lo, seria preciso copiá-lo de um log — que é justamente
 * onde ele nunca pode estar.
 *
 * Travas:
 *   - só em memória, some ao reiniciar o servidor;
 *   - expira em 5 minutos;
 *   - leitura única: some ao ser lido;
 *   - amarrado ao usuário que autorizou;
 *   - TOTALMENTE DESABILITADO fora de desenvolvimento (ver `exibicaoPermitida`).
 */

const VALIDADE_MS = 5 * 60_000;

type Guardado = {
  usuarioId: string;
  refreshToken: string;
  email: string | null;
  expiraEm: number;
};

const guardados = new Map<string, Guardado>();

/**
 * A exibição só é permitida em desenvolvimento.
 *
 * Em produção o refresh token nunca é mostrado: ele é configurado por quem
 * tem acesso ao ambiente, não pela interface.
 */
export function exibicaoPermitida(): boolean {
  return process.env.NODE_ENV !== "production";
}

function limparExpirados(): void {
  const agora = Date.now();
  for (const [chave, item] of guardados) {
    if (item.expiraEm <= agora) guardados.delete(chave);
  }
}

export function guardarRefreshTokenParaExibicao(
  usuarioId: string,
  refreshToken: string,
  email: string | null
): string {
  limparExpirados();
  const chave = randomBytes(16).toString("base64url");
  guardados.set(chave, {
    usuarioId,
    refreshToken,
    email,
    expiraEm: Date.now() + VALIDADE_MS,
  });
  return chave;
}

export type TokenParaExibir =
  | { ok: true; refreshToken: string; email: string | null }
  | { ok: false; motivo: "desabilitado" | "nao_encontrado" | "expirado" | "outro_usuario" };

/** Lê e DESCARTA — a mesma chave não serve duas vezes. */
export function consumirRefreshToken(chave: string, usuarioId: string): TokenParaExibir {
  if (!exibicaoPermitida()) return { ok: false, motivo: "desabilitado" };

  limparExpirados();
  const item = guardados.get(chave);
  if (!item) return { ok: false, motivo: "nao_encontrado" };

  if (item.usuarioId !== usuarioId) {
    // Não apaga: o dono legítimo ainda pode buscar.
    return { ok: false, motivo: "outro_usuario" };
  }

  guardados.delete(chave);

  if (item.expiraEm <= Date.now()) return { ok: false, motivo: "expirado" };
  return { ok: true, refreshToken: item.refreshToken, email: item.email };
}
