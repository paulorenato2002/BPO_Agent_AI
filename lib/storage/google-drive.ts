import "server-only";
import { createSign } from "node:crypto";
import type {
  AdapterArmazenamento,
  ParametrosEnvio,
  ResultadoDownload,
  ResultadoEnvio,
  ResultadoExistencia,
  ResultadoHealthCheck,
  ResultadoMetadados,
  ResultadoUrlAssinada,
} from "./tipos";

/**
 * Adapter do Google Drive via conta de serviço.
 *
 * Implementado com `fetch` + `node:crypto` (JWT RS256 assinado localmente),
 * sem a dependência `googleapis` — que traz dezenas de MB e centenas de APIs
 * que não usamos.
 *
 * ESTADO ATUAL: as credenciais NÃO estão configuradas neste ambiente. O adapter
 * está completo e coberto por testes com mock, mas nenhum upload real foi
 * validado. Enquanto faltar credencial, todo método retorna
 * `naoConfigurado: true` — nunca um sucesso simulado.
 *
 * Variáveis necessárias para ativar:
 *   GOOGLE_DRIVE_CLIENT_EMAIL   e-mail da conta de serviço
 *   GOOGLE_DRIVE_PRIVATE_KEY    chave privada PEM (\n escapados são aceitos)
 *   GOOGLE_DRIVE_PASTA_RAIZ_ID  ID da pasta raiz onde os documentos vão
 *   GOOGLE_DRIVE_SUBJECT        (opcional) e-mail para delegação domain-wide
 */

const ESCOPO = "https://www.googleapis.com/auth/drive";
const URL_TOKEN = "https://oauth2.googleapis.com/token";
const URL_API = "https://www.googleapis.com/drive/v3";
const URL_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

type Credenciais = {
  clientEmail: string;
  privateKey: string;
  pastaRaizId: string;
  subject?: string;
};

function lerCredenciais(): Credenciais | { faltando: string[] } {
  const clientEmail = process.env.GOOGLE_DRIVE_CLIENT_EMAIL;
  // A chave costuma vir com \n escapado quando guardada em .env de uma linha.
  const privateKey = process.env.GOOGLE_DRIVE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const pastaRaizId = process.env.GOOGLE_DRIVE_PASTA_RAIZ_ID;

  const faltando: string[] = [];
  if (!clientEmail) faltando.push("GOOGLE_DRIVE_CLIENT_EMAIL");
  if (!privateKey) faltando.push("GOOGLE_DRIVE_PRIVATE_KEY");
  if (!pastaRaizId) faltando.push("GOOGLE_DRIVE_PASTA_RAIZ_ID");
  if (faltando.length > 0) return { faltando };

  return {
    clientEmail: clientEmail!,
    privateKey: privateKey!,
    pastaRaizId: pastaRaizId!,
    subject: process.env.GOOGLE_DRIVE_SUBJECT,
  };
}

function base64url(entrada: Buffer | string): string {
  return Buffer.from(entrada)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Token em cache; renovado com folga antes de expirar. */
let tokenCache: { token: string; expiraEm: number } | null = null;

async function obterAccessToken(cred: Credenciais): Promise<string> {
  if (tokenCache && tokenCache.expiraEm > Date.now() + 60_000) {
    return tokenCache.token;
  }

  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: cred.clientEmail,
      scope: ESCOPO,
      aud: URL_TOKEN,
      iat: agora,
      exp: agora + 3600,
      ...(cred.subject ? { sub: cred.subject } : {}),
    })
  );

  const assinatura = createSign("RSA-SHA256")
    .update(`${cabecalho}.${claims}`)
    .sign(cred.privateKey);

  const jwt = `${cabecalho}.${claims}.${base64url(assinatura)}`;

  const resposta = await fetch(URL_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!resposta.ok) {
    // Nunca registrar o corpo completo: pode conter detalhes da credencial.
    throw new Error(`Falha na autenticação do Google Drive (HTTP ${resposta.status}).`);
  }

  const dados = (await resposta.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    token: dados.access_token,
    expiraEm: Date.now() + dados.expires_in * 1000,
  };
  return dados.access_token;
}

function mensagemErro(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Escapa aspas simples em nomes usados na query do Drive. */
function escaparQuery(valor: string): string {
  return valor.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export class GoogleDriveAdapter implements AdapterArmazenamento {
  readonly provedor = "google_drive" as const;

  estaConfigurado(): boolean {
    return !("faltando" in lerCredenciais());
  }

  /** Falha padronizada de "sem credenciais" — nunca confundida com erro de execução. */
  private naoConfig(): { ok: false; naoConfigurado: true; erro: string } {
    const c = lerCredenciais();
    const faltando = "faltando" in c ? c.faltando : [];
    return {
      ok: false,
      naoConfigurado: true,
      erro: `Google Drive não configurado. Variáveis ausentes: ${faltando.join(", ")}.`,
    };
  }

  private async requisitar(
    cred: Credenciais,
    url: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const token = await obterAccessToken(cred);
    return fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
  }

  /** Localiza uma pasta pelo nome dentro de um pai. */
  async localizarPasta(nome: string, paiId: string): Promise<string | null> {
    const cred = lerCredenciais();
    if ("faltando" in cred) return null;

    const q = [
      `name = '${escaparQuery(nome)}'`,
      `'${escaparQuery(paiId)}' in parents`,
      "mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false",
    ].join(" and ");

    const resposta = await this.requisitar(
      cred,
      `${URL_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`
    );
    if (!resposta.ok) return null;
    const dados = (await resposta.json()) as { files?: { id: string }[] };
    return dados.files?.[0]?.id ?? null;
  }

  /** Cria uma pasta (ou devolve a existente) dentro de um pai. */
  async criarPasta(nome: string, paiId: string): Promise<string> {
    const cred = lerCredenciais();
    if ("faltando" in cred) throw new Error("Google Drive não configurado.");

    const existente = await this.localizarPasta(nome, paiId);
    if (existente) return existente;

    const resposta = await this.requisitar(cred, `${URL_API}/files?supportsAllDrives=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: nome,
        mimeType: "application/vnd.google-apps.folder",
        parents: [paiId],
      }),
    });

    if (!resposta.ok) {
      throw new Error(`Não foi possível criar a pasta "${nome}" (HTTP ${resposta.status}).`);
    }
    const dados = (await resposta.json()) as { id: string };
    return dados.id;
  }

  /** Garante toda a árvore de pastas de um caminho, devolvendo o ID da folha. */
  private async garantirCaminho(cred: Credenciais, pastas: string[]): Promise<string> {
    let paiId = cred.pastaRaizId;
    for (const pasta of pastas) {
      paiId = await this.criarPasta(pasta, paiId);
    }
    return paiId;
  }

  async enviar(params: ParametrosEnvio): Promise<ResultadoEnvio> {
    const cred = lerCredenciais();
    if ("faltando" in cred) {
      return { ...this.naoConfig(), provedor: this.provedor };
    }

    try {
      const partes = params.caminho.split("/").filter(Boolean);
      const nomeArquivo = partes.pop()!;
      const pastaId = await this.garantirCaminho(cred, partes);

      if (!params.sobrescrever) {
        const jaExiste = await this.existe(params.caminho);
        if (jaExiste.ok && jaExiste.existe) {
          return {
            ok: false,
            provedor: this.provedor,
            erro: `Já existe um arquivo "${nomeArquivo}" no destino. Não foi sobrescrito.`,
          };
        }
      }

      // Upload multipart: metadados + conteúdo numa requisição só.
      const limite = `limite_${Date.now().toString(36)}`;
      const metadados = JSON.stringify({ name: nomeArquivo, parents: [pastaId] });
      const corpo = Buffer.concat([
        Buffer.from(
          `--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadados}\r\n` +
            `--${limite}\r\nContent-Type: ${params.mimeType}\r\n\r\n`
        ),
        params.conteudo,
        Buffer.from(`\r\n--${limite}--\r\n`),
      ]);

      const resposta = await this.requisitar(
        cred,
        `${URL_UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name`,
        {
          method: "POST",
          headers: { "Content-Type": `multipart/related; boundary=${limite}` },
          body: new Uint8Array(corpo),
        }
      );

      if (!resposta.ok) {
        return {
          ok: false,
          provedor: this.provedor,
          erro: `Falha no upload para o Google Drive (HTTP ${resposta.status}).`,
        };
      }

      const dados = (await resposta.json()) as { id: string; name: string };
      return {
        ok: true,
        provedor: this.provedor,
        caminho: params.caminho,
        nomeUtilizado: dados.name,
        bucketOuPasta: partes.join(" > ") || "(raiz)",
        identificadorExterno: dados.id,
        confirmadoEm: new Date(),
      };
    } catch (e) {
      return { ok: false, provedor: this.provedor, erro: mensagemErro(e) };
    }
  }

  /** Resolve um caminho lógico até o ID do arquivo, se existir. */
  private async resolverArquivoId(cred: Credenciais, caminho: string): Promise<string | null> {
    const partes = caminho.split("/").filter(Boolean);
    const nomeArquivo = partes.pop();
    if (!nomeArquivo) return null;

    let paiId = cred.pastaRaizId;
    for (const pasta of partes) {
      const id = await this.localizarPasta(pasta, paiId);
      if (!id) return null;
      paiId = id;
    }

    const q = [
      `name = '${escaparQuery(nomeArquivo)}'`,
      `'${escaparQuery(paiId)}' in parents`,
      "trashed = false",
    ].join(" and ");

    const resposta = await this.requisitar(
      cred,
      `${URL_API}/files?q=${encodeURIComponent(q)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`
    );
    if (!resposta.ok) return null;
    const dados = (await resposta.json()) as { files?: { id: string }[] };
    return dados.files?.[0]?.id ?? null;
  }

  async existe(caminho: string): Promise<ResultadoExistencia> {
    const cred = lerCredenciais();
    if ("faltando" in cred) {
      return this.naoConfig();
    }
    try {
      const id = await this.resolverArquivoId(cred, caminho);
      return { ok: true, existe: id !== null, identificadorExterno: id ?? undefined };
    } catch (e) {
      return { ok: false, erro: mensagemErro(e) };
    }
  }

  async baixar(caminho: string): Promise<ResultadoDownload> {
    const cred = lerCredenciais();
    if ("faltando" in cred) {
      return this.naoConfig();
    }
    try {
      const id = await this.resolverArquivoId(cred, caminho);
      if (!id) return { ok: false, erro: "Arquivo não encontrado no Google Drive." };

      const resposta = await this.requisitar(
        cred,
        `${URL_API}/files/${id}?alt=media&supportsAllDrives=true`
      );
      if (!resposta.ok) {
        return { ok: false, erro: `Falha ao baixar do Google Drive (HTTP ${resposta.status}).` };
      }
      return {
        ok: true,
        conteudo: Buffer.from(await resposta.arrayBuffer()),
        mimeType: resposta.headers.get("content-type") ?? undefined,
      };
    } catch (e) {
      return { ok: false, erro: mensagemErro(e) };
    }
  }

  async copiar(origem: string, destino: string): Promise<ResultadoEnvio> {
    const cred = lerCredenciais();
    if ("faltando" in cred) {
      return { ...this.naoConfig(), provedor: this.provedor };
    }
    try {
      const origemId = await this.resolverArquivoId(cred, origem);
      if (!origemId) {
        return { ok: false, provedor: this.provedor, erro: "Arquivo de origem não encontrado." };
      }

      const partes = destino.split("/").filter(Boolean);
      const nomeDestino = partes.pop()!;
      const pastaId = await this.garantirCaminho(cred, partes);

      const resposta = await this.requisitar(
        cred,
        `${URL_API}/files/${origemId}/copy?supportsAllDrives=true&fields=id,name`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: nomeDestino, parents: [pastaId] }),
        }
      );

      if (!resposta.ok) {
        return {
          ok: false,
          provedor: this.provedor,
          erro: `Falha ao copiar no Google Drive (HTTP ${resposta.status}).`,
        };
      }

      const dados = (await resposta.json()) as { id: string; name: string };
      return {
        ok: true,
        provedor: this.provedor,
        caminho: destino,
        nomeUtilizado: dados.name,
        bucketOuPasta: partes.join(" > ") || "(raiz)",
        identificadorExterno: dados.id,
        confirmadoEm: new Date(),
      };
    } catch (e) {
      return { ok: false, provedor: this.provedor, erro: mensagemErro(e) };
    }
  }

  /**
   * O Drive não tem URL assinada como o S3/Supabase. O equivalente seguro é o
   * `webContentLink`, que exige permissão do usuário — não tornamos o arquivo
   * público para gerar link.
   */
  async urlAssinada(caminho: string): Promise<ResultadoUrlAssinada> {
    const cred = lerCredenciais();
    if ("faltando" in cred) {
      return this.naoConfig();
    }
    try {
      const id = await this.resolverArquivoId(cred, caminho);
      if (!id) return { ok: false, erro: "Arquivo não encontrado no Google Drive." };

      const resposta = await this.requisitar(
        cred,
        `${URL_API}/files/${id}?fields=webViewLink&supportsAllDrives=true`
      );
      if (!resposta.ok) {
        return { ok: false, erro: `Falha ao obter link (HTTP ${resposta.status}).` };
      }
      const dados = (await resposta.json()) as { webViewLink?: string };
      if (!dados.webViewLink) {
        return { ok: false, erro: "Arquivo sem link de visualização disponível." };
      }
      // O link do Drive não expira sozinho; o controle é a permissão do arquivo.
      return { ok: true, url: dados.webViewLink, expiraEm: new Date(Date.now() + 3600_000) };
    } catch (e) {
      return { ok: false, erro: mensagemErro(e) };
    }
  }

  async metadados(caminho: string): Promise<ResultadoMetadados> {
    const cred = lerCredenciais();
    if ("faltando" in cred) {
      return this.naoConfig();
    }
    try {
      const id = await this.resolverArquivoId(cred, caminho);
      if (!id) return { ok: false, erro: "Arquivo não encontrado no Google Drive." };

      const resposta = await this.requisitar(
        cred,
        `${URL_API}/files/${id}?fields=id,name,size,mimeType,createdTime&supportsAllDrives=true`
      );
      if (!resposta.ok) {
        return { ok: false, erro: `Falha ao ler metadados (HTTP ${resposta.status}).` };
      }
      const d = (await resposta.json()) as {
        id: string;
        name: string;
        size?: string;
        mimeType?: string;
        createdTime?: string;
      };
      return {
        ok: true,
        metadados: {
          nome: d.name,
          tamanhoBytes: d.size ? Number(d.size) : undefined,
          mimeType: d.mimeType,
          criadoEm: d.createdTime ? new Date(d.createdTime) : undefined,
          identificadorExterno: d.id,
        },
      };
    } catch (e) {
      return { ok: false, erro: mensagemErro(e) };
    }
  }

  async healthCheck(): Promise<ResultadoHealthCheck> {
    const verificadoEm = new Date();
    const cred = lerCredenciais();

    if ("faltando" in cred) {
      return {
        provedor: this.provedor,
        configurado: false,
        disponivel: false,
        detalhe: `Variáveis ausentes: ${cred.faltando.join(", ")}.`,
        verificadoEm,
      };
    }

    try {
      const resposta = await this.requisitar(
        cred,
        `${URL_API}/files/${encodeURIComponent(cred.pastaRaizId)}?fields=id,name&supportsAllDrives=true`
      );
      if (!resposta.ok) {
        return {
          provedor: this.provedor,
          configurado: true,
          disponivel: false,
          detalhe: `Pasta raiz inacessível (HTTP ${resposta.status}).`,
          verificadoEm,
        };
      }
      const d = (await resposta.json()) as { name?: string };
      return {
        provedor: this.provedor,
        configurado: true,
        disponivel: true,
        detalhe: `Pasta raiz "${d.name ?? cred.pastaRaizId}" acessível.`,
        verificadoEm,
      };
    } catch (e) {
      return {
        provedor: this.provedor,
        configurado: true,
        disponivel: false,
        detalhe: mensagemErro(e),
        verificadoEm,
      };
    }
  }
}

export const googleDrive = new GoogleDriveAdapter();

/** Exposto para os testes poderem limpar o cache de token entre casos. */
export function _limparCacheToken(): void {
  tokenCache = null;
}
