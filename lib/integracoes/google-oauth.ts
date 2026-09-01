import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * OAuth 2.0 do Google Drive — fluxo server-side com acesso offline.
 *
 * A conta autorizadora é uma conta Google HUMANA de um colaborador. Não há
 * conta de serviço nem chave de API: o app age em nome dessa pessoa, usando um
 * refresh token de longa duração guardado apenas em variável de ambiente.
 *
 * SEGURANÇA — regras que valem para o arquivo inteiro:
 *   - `import "server-only"` garante erro de build se algum componente de
 *     cliente importar este módulo;
 *   - nenhuma variável aqui é `NEXT_PUBLIC_`;
 *   - client_secret, código de autorização e tokens NUNCA vão para log,
 *     resposta JSON ou mensagem de erro;
 *   - o access token vive só em memória, é renovado a partir do refresh token
 *     e nunca é persistido.
 */

/** Escopo mínimo: só os arquivos que o próprio app criar ou abrir. */
export const ESCOPO_DRIVE = "https://www.googleapis.com/auth/drive.file";

const URL_AUTORIZACAO = "https://accounts.google.com/o/oauth2/v2/auth";
const URL_TOKEN = "https://oauth2.googleapis.com/token";

export const NOME_COOKIE_STATE = "gd_oauth_state";
export const NOME_PASTA_RAIZ = "BPO_FINANCEIRO";

export type ConfigOAuth = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type ConfigFaltando = { faltando: string[] };

/** Lê a configuração sem nunca expor os valores. */
export function lerConfigOAuth(): ConfigOAuth | ConfigFaltando {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI;

  const faltando: string[] = [];
  if (!clientId) faltando.push("GOOGLE_DRIVE_CLIENT_ID");
  if (!clientSecret) faltando.push("GOOGLE_DRIVE_CLIENT_SECRET");
  if (!redirectUri) faltando.push("GOOGLE_DRIVE_REDIRECT_URI");
  if (faltando.length) return { faltando };

  return { clientId: clientId!, clientSecret: clientSecret!, redirectUri: redirectUri! };
}

export function ehConfigFaltando(c: ConfigOAuth | ConfigFaltando): c is ConfigFaltando {
  return "faltando" in c;
}

export function temRefreshToken(): boolean {
  return Boolean(process.env.GOOGLE_DRIVE_REFRESH_TOKEN);
}

/** `state` imprevisível, para amarrar o retorno do Google a esta sessão. */
export function gerarState(): string {
  return randomBytes(32).toString("base64url");
}

/** Comparação em tempo constante — evita vazar informação por timing. */
export function stateConfere(recebido: string | undefined, esperado: string | undefined): boolean {
  if (!recebido || !esperado) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function montarUrlAutorizacao(config: ConfigOAuth, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: ESCOPO_DRIVE,
    // offline + consent: sem os dois, o Google só devolve refresh_token na
    // PRIMEIRA autorização daquela conta — reautorizar viria sem ele.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${URL_AUTORIZACAO}?${params.toString()}`;
}

export type ResultadoTroca =
  | { ok: true; refreshToken: string; escopo: string; email: string | null }
  | { ok: false; erro: string; semRefreshToken?: boolean };

/**
 * Troca o código de autorização por tokens.
 *
 * O corpo da resposta do Google contém segredos, então NADA dele é registrado
 * ou repassado — só extraímos o que precisamos.
 */
export async function trocarCodigoPorTokens(
  config: ConfigOAuth,
  codigo: string
): Promise<ResultadoTroca> {
  try {
    const resposta = await fetch(URL_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: codigo,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!resposta.ok) {
      // Só o status: o corpo pode ecoar o código de autorização.
      return { ok: false, erro: `O Google recusou a troca (HTTP ${resposta.status}).` };
    }

    const dados = (await resposta.json()) as {
      refresh_token?: string;
      access_token?: string;
      scope?: string;
    };

    if (!dados.refresh_token) {
      return {
        ok: false,
        semRefreshToken: true,
        erro:
          "O Google não devolveu refresh_token. Isso acontece quando a conta já " +
          "havia autorizado este app. Remova o acesso em " +
          "myaccount.google.com/permissions e conecte de novo.",
      };
    }

    // Descobre de qual conta é a autorização — ajuda a confirmar que a pessoa
    // certa autorizou. Falha aqui não invalida o token.
    let email: string | null = null;
    if (dados.access_token) {
      email = await descobrirEmail(dados.access_token).catch(() => null);
    }

    return {
      ok: true,
      refreshToken: dados.refresh_token,
      escopo: dados.scope ?? ESCOPO_DRIVE,
      email,
    };
  } catch {
    return { ok: false, erro: "Falha de rede ao falar com o Google." };
  }
}

async function descobrirEmail(accessToken: string): Promise<string | null> {
  const r = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return null;
  const d = (await r.json()) as { user?: { emailAddress?: string } };
  return d.user?.emailAddress ?? null;
}

// ---------------------------------------------------------------------------
// Access token de trabalho
// ---------------------------------------------------------------------------

/**
 * Cache em MEMÓRIA do access token.
 *
 * Deliberadamente não persistido: um access token vazado vale por ~1h, e
 * guardá-lo em disco ou banco só aumenta a superfície. Sempre renovado a
 * partir do refresh token.
 */
let cacheToken: { token: string; expiraEm: number } | null = null;

export type ResultadoToken =
  | { ok: true; accessToken: string }
  | { ok: false; erro: string; naoConfigurado?: boolean };

export async function obterAccessToken(): Promise<ResultadoToken> {
  if (cacheToken && cacheToken.expiraEm > Date.now() + 60_000) {
    return { ok: true, accessToken: cacheToken.token };
  }

  const config = lerConfigOAuth();
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

  if (ehConfigFaltando(config) || !refreshToken) {
    const faltando = ehConfigFaltando(config) ? [...config.faltando] : [];
    if (!refreshToken) faltando.push("GOOGLE_DRIVE_REFRESH_TOKEN");
    return {
      ok: false,
      naoConfigurado: true,
      erro: `Google Drive não configurado. Variáveis ausentes: ${faltando.join(", ")}.`,
    };
  }

  try {
    const resposta = await fetch(URL_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!resposta.ok) {
      const dica =
        resposta.status === 400 || resposta.status === 401
          ? " O refresh token pode ter sido revogado — refaça a conexão."
          : "";
      return { ok: false, erro: `Falha ao renovar o acesso (HTTP ${resposta.status}).${dica}` };
    }

    const dados = (await resposta.json()) as { access_token: string; expires_in: number };
    cacheToken = {
      token: dados.access_token,
      expiraEm: Date.now() + dados.expires_in * 1000,
    };
    return { ok: true, accessToken: dados.access_token };
  } catch {
    return { ok: false, erro: "Falha de rede ao renovar o acesso." };
  }
}

/** Usado pelos testes para forçar renovação. */
export function _limparCacheToken(): void {
  cacheToken = null;
}

// ---------------------------------------------------------------------------
// Confinamento à pasta raiz
// ---------------------------------------------------------------------------

/**
 * Confirma que um item está DENTRO de `GOOGLE_DRIVE_PASTA_RAIZ_ID`.
 *
 * O escopo `drive.file` já limita o app aos arquivos que ele criou, mas isso
 * não impede gravar solto na raiz do Drive da pessoa. Esta checagem sobe a
 * cadeia de pais até achar a raiz do BPO — se não achar, a operação é recusada.
 */
export async function estaDentroDaRaiz(
  accessToken: string,
  itemId: string,
  raizId: string,
  profundidadeMaxima = 12
): Promise<boolean> {
  if (itemId === raizId) return true;

  let atual = itemId;
  for (let i = 0; i < profundidadeMaxima; i++) {
    const r = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(atual)}?fields=id,parents&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!r.ok) return false;

    const d = (await r.json()) as { parents?: string[] };
    const pais = d.parents ?? [];
    if (pais.length === 0) return false; // chegou na raiz do Drive sem passar pela nossa
    if (pais.includes(raizId)) return true;
    atual = pais[0];
  }
  return false;
}
