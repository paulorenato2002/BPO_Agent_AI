import "server-only";
import {
  obterAccessToken,
  lerConfigOAuth,
  ehConfigFaltando,
  _limparCacheToken as limparCacheOAuth,
} from "../integracoes/google-oauth";
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
 * Adapter do Google Drive.
 *
 * AUTENTICAÇÃO: OAuth 2.0 com conta Google HUMANA e acesso offline. O token é
 * obtido em lib/integracoes/google-oauth.ts a partir do refresh token — este
 * arquivo cuida só das OPERAÇÕES do Drive (pastas, upload, download, cópia).
 *
 * A implementação anterior usava conta de serviço com JWT RS256; as operações
 * foram preservadas e apenas a camada de autenticação mudou.
 *
 * ESCOPO: `drive.file` — o app só acessa o que ele mesmo criou. Todas as
 * operações ficam confinadas a GOOGLE_DRIVE_PASTA_RAIZ_ID.
 *
 * Variáveis (nenhuma NEXT_PUBLIC_):
 *   GOOGLE_DRIVE_CLIENT_ID
 *   GOOGLE_DRIVE_CLIENT_SECRET
 *   GOOGLE_DRIVE_REFRESH_TOKEN
 *   GOOGLE_DRIVE_PASTA_RAIZ_ID
 */

const URL_API = "https://www.googleapis.com/drive/v3";
const URL_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

type Credenciais = { pastaRaizId: string };

function lerCredenciais(): Credenciais | { faltando: string[] } {
  const config = lerConfigOAuth();
  const pastaRaizId = process.env.GOOGLE_DRIVE_PASTA_RAIZ_ID;
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;

  const faltando: string[] = ehConfigFaltando(config) ? [...config.faltando] : [];
  if (!refreshToken) faltando.push("GOOGLE_DRIVE_REFRESH_TOKEN");
  if (!pastaRaizId) faltando.push("GOOGLE_DRIVE_PASTA_RAIZ_ID");
  if (faltando.length > 0) return { faltando };

  return { pastaRaizId: pastaRaizId! };
}

/** Delega a obtenção do token ao módulo OAuth (cache em memória lá). */
async function tokenDeAcesso(): Promise<string> {
  const r = await obterAccessToken();
  if (!r.ok) throw new Error(r.erro);
  return r.accessToken;
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
    const token = await tokenDeAcesso();
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

  /**
   * Lista TODAS as pastas com um dado nome dentro de um pai.
   *
   * `localizarPasta` devolve só a primeira e serve para o caminho feliz. Aqui
   * queremos enxergar duplicatas: o Drive permite duas pastas com o mesmo nome
   * no mesmo pai, então duas execuções concorrentes conseguem criar irmãs
   * idênticas. O resolvedor usa esta lista para convergir sempre na MAIS
   * ANTIGA, sem precisar apagar nada.
   *
   * Ordenada por data de criação (mais antiga primeiro), com o id como
   * desempate para a ordem ser total e determinística.
   */
  async listarPastasPorNome(
    nome: string,
    paiId: string
  ): Promise<{ id: string; createdTime: string }[]> {
    const cred = lerCredenciais();
    if ("faltando" in cred) return [];

    const q = [
      `name = '${escaparQuery(nome)}'`,
      `'${escaparQuery(paiId)}' in parents`,
      "mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false",
    ].join(" and ");

    const resposta = await this.requisitar(
      cred,
      `${URL_API}/files?q=${encodeURIComponent(q)}` +
        `&fields=files(id,name,createdTime)&pageSize=100` +
        `&supportsAllDrives=true&includeItemsFromAllDrives=true`
    );
    if (!resposta.ok) {
      throw new Error(`Falha ao listar a pasta "${nome}" (HTTP ${resposta.status}).`);
    }

    const dados = (await resposta.json()) as {
      files?: { id: string; createdTime?: string }[];
    };

    return (dados.files ?? [])
      .map((f) => ({ id: f.id, createdTime: f.createdTime ?? "" }))
      .sort((a, b) =>
        a.createdTime === b.createdTime
          ? a.id.localeCompare(b.id)
          : a.createdTime.localeCompare(b.createdTime)
      );
  }

  /**
   * Cria uma pasta SEM checar se já existe.
   *
   * Existe separada de `criarPasta` porque o resolvedor faz a própria
   * checagem (e a própria reconciliação de duplicatas) — checar de novo aqui
   * só ampliaria a janela de corrida.
   */
  async criarPastaBruta(nome: string, paiId: string): Promise<string> {
    const cred = lerCredenciais();
    if ("faltando" in cred) throw new Error("Google Drive não configurado.");

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

  /** ID da pasta raiz configurada, ou null se a integração não está pronta. */
  pastaRaizId(): string | null {
    const cred = lerCredenciais();
    return "faltando" in cred ? null : cred.pastaRaizId;
  }

  /** Garante toda a árvore de pastas de um caminho, devolvendo o ID da folha. */
  private async garantirCaminho(cred: Credenciais, pastas: string[]): Promise<string> {
    let paiId = cred.pastaRaizId;
    for (const pasta of pastas) {
      paiId = await this.criarPasta(pasta, paiId);
    }
    return paiId;
  }

  /**
   * Envia um arquivo para uma pasta JÁ RESOLVIDA, pelo id dela.
   *
   * `enviar()` recebe um caminho e cria as pastas pelo caminho ingênuo
   * (procura, não achou, cria), que produz pastas irmãs duplicadas sob
   * concorrência. O arquivador resolve a pasta antes, pelo resolvedor
   * idempotente, e entrega o id aqui — por isso este método existe.
   *
   * Nunca sobrescreve. Se já houver arquivo com o mesmo nome na pasta,
   * devolve o id do existente com `jaExistia: true`, para o chamador decidir
   * se é retentativa (idempotente) ou colisão de verdade.
   */
  async enviarNaPasta(params: {
    paiId: string;
    nome: string;
    conteudo: Buffer;
    mimeType: string;
  }): Promise<
    | { ok: true; identificadorExterno: string; jaExistia: boolean; confirmadoEm: Date }
    | { ok: false; erro: string; naoConfigurado?: boolean }
  > {
    const cred = lerCredenciais();
    if ("faltando" in cred) {
      return {
        ok: false,
        naoConfigurado: true,
        erro: `Google Drive não configurado. Faltam: ${cred.faltando.join(", ")}.`,
      };
    }

    try {
      const q = [
        `name = '${escaparQuery(params.nome)}'`,
        `'${escaparQuery(params.paiId)}' in parents`,
        "trashed = false",
      ].join(" and ");

      const busca = await this.requisitar(
        cred,
        `${URL_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)` +
          `&supportsAllDrives=true&includeItemsFromAllDrives=true`
      );

      if (busca.ok) {
        const dados = (await busca.json()) as { files?: { id: string }[] };
        const existente = dados.files?.[0];
        if (existente) {
          return {
            ok: true,
            identificadorExterno: existente.id,
            jaExistia: true,
            confirmadoEm: new Date(),
          };
        }
      }

      // Upload multipart: metadados + conteúdo numa requisição só.
      const limite = `limite_${Date.now().toString(36)}`;
      const metadados = JSON.stringify({ name: params.nome, parents: [params.paiId] });
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
        return { ok: false, erro: `Falha no upload para o Google Drive (HTTP ${resposta.status}).` };
      }

      const dados = (await resposta.json()) as { id: string };
      return {
        ok: true,
        identificadorExterno: dados.id,
        jaExistia: false,
        confirmadoEm: new Date(),
      };
    } catch (e) {
      return { ok: false, erro: mensagemErro(e) };
    }
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
  limparCacheOAuth();
}
