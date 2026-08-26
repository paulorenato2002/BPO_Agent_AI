import "server-only";
import { supabaseAdmin } from "../supabase-admin";
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
 * Adapter do Supabase Storage.
 *
 * Bucket PRIVADO por padrão: documentos operacionais nunca são públicos.
 * O acesso de leitura acontece por URL assinada, com validade curta.
 * A `service_role` usada pelo cliente admin permanece exclusivamente no servidor.
 */

const BUCKET = process.env.SUPABASE_BUCKET_DOCUMENTOS ?? "documentos-operacionais";
const VALIDADE_URL_PADRAO_SEGUNDOS = 300; // 5 minutos

let bucketGarantido: Promise<void> | null = null;

async function garantirBucket(): Promise<void> {
  if (!bucketGarantido) {
    bucketGarantido = (async () => {
      const { data } = await supabaseAdmin.storage.getBucket(BUCKET);
      if (data) return;
      const { error } = await supabaseAdmin.storage.createBucket(BUCKET, {
        public: false,
      });
      // Corrida entre requisições concorrentes é esperada e inofensiva.
      if (error && !/already exists/i.test(error.message)) throw error;
    })().catch((e) => {
      // Não deixa o cache guardar uma promise rejeitada.
      bucketGarantido = null;
      throw e;
    });
  }
  await bucketGarantido;
}

function mensagemErro(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class SupabaseStorageAdapter implements AdapterArmazenamento {
  readonly provedor = "supabase_storage" as const;

  estaConfigurado(): boolean {
    return Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }

  private faltando(): string[] {
    const faltando: string[] = [];
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) faltando.push("NEXT_PUBLIC_SUPABASE_URL");
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) faltando.push("SUPABASE_SERVICE_ROLE_KEY");
    return faltando;
  }

  async enviar(params: ParametrosEnvio): Promise<ResultadoEnvio> {
    if (!this.estaConfigurado()) {
      return {
        ok: false,
        provedor: this.provedor,
        naoConfigurado: true,
        erro: `Integração não configurada. Variáveis ausentes: ${this.faltando().join(", ")}.`,
      };
    }

    try {
      await garantirBucket();

      // upsert=false por padrão: nunca sobrescrever silenciosamente.
      const { error } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(params.caminho, params.conteudo, {
          contentType: params.mimeType,
          upsert: params.sobrescrever === true,
        });

      if (error) {
        return { ok: false, provedor: this.provedor, erro: error.message };
      }

      // Só declaramos sucesso depois de confirmar que o objeto existe de fato.
      const confirmacao = await this.existe(params.caminho);
      if (!confirmacao.ok || !confirmacao.existe) {
        return {
          ok: false,
          provedor: this.provedor,
          erro: "Upload aceito mas não confirmado pelo provedor.",
        };
      }

      return {
        ok: true,
        provedor: this.provedor,
        caminho: params.caminho,
        nomeUtilizado: params.caminho.split("/").pop() ?? params.caminho,
        bucketOuPasta: BUCKET,
        confirmadoEm: new Date(),
      };
    } catch (e) {
      return { ok: false, provedor: this.provedor, erro: mensagemErro(e) };
    }
  }

  async baixar(caminho: string): Promise<ResultadoDownload> {
    if (!this.estaConfigurado()) {
      return { ok: false, naoConfigurado: true, erro: "Supabase Storage não configurado." };
    }
    try {
      const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(caminho);
      if (error || !data) {
        return { ok: false, erro: error?.message ?? "Arquivo não encontrado." };
      }
      return { ok: true, conteudo: Buffer.from(await data.arrayBuffer()), mimeType: data.type };
    } catch (e) {
      return { ok: false, erro: mensagemErro(e) };
    }
  }

  async existe(caminho: string): Promise<ResultadoExistencia> {
    if (!this.estaConfigurado()) {
      return { ok: false, naoConfigurado: true, erro: "Supabase Storage não configurado." };
    }
    try {
      const barra = caminho.lastIndexOf("/");
      const pasta = barra >= 0 ? caminho.slice(0, barra) : "";
      const nome = barra >= 0 ? caminho.slice(barra + 1) : caminho;

      const { data, error } = await supabaseAdmin.storage
        .from(BUCKET)
        .list(pasta, { search: nome, limit: 100 });

      if (error) return { ok: false, erro: error.message };
      return { ok: true, existe: (data ?? []).some((a) => a.name === nome) };
    } catch (e) {
      return { ok: false, erro: mensagemErro(e) };
    }
  }

  async copiar(origem: string, destino: string): Promise<ResultadoEnvio> {
    if (!this.estaConfigurado()) {
      return {
        ok: false,
        provedor: this.provedor,
        naoConfigurado: true,
        erro: "Supabase Storage não configurado.",
      };
    }
    try {
      const { error } = await supabaseAdmin.storage.from(BUCKET).copy(origem, destino);
      if (error) return { ok: false, provedor: this.provedor, erro: error.message };

      const confirmacao = await this.existe(destino);
      if (!confirmacao.ok || !confirmacao.existe) {
        return {
          ok: false,
          provedor: this.provedor,
          erro: "Cópia aceita mas não confirmada pelo provedor.",
        };
      }

      return {
        ok: true,
        provedor: this.provedor,
        caminho: destino,
        nomeUtilizado: destino.split("/").pop() ?? destino,
        bucketOuPasta: BUCKET,
        confirmadoEm: new Date(),
      };
    } catch (e) {
      return { ok: false, provedor: this.provedor, erro: mensagemErro(e) };
    }
  }

  async urlAssinada(
    caminho: string,
    segundosValidade = VALIDADE_URL_PADRAO_SEGUNDOS
  ): Promise<ResultadoUrlAssinada> {
    if (!this.estaConfigurado()) {
      return { ok: false, naoConfigurado: true, erro: "Supabase Storage não configurado." };
    }
    try {
      const { data, error } = await supabaseAdmin.storage
        .from(BUCKET)
        .createSignedUrl(caminho, segundosValidade);

      if (error || !data?.signedUrl) {
        return { ok: false, erro: error?.message ?? "Não foi possível gerar a URL." };
      }
      return {
        ok: true,
        url: data.signedUrl,
        expiraEm: new Date(Date.now() + segundosValidade * 1000),
      };
    } catch (e) {
      return { ok: false, erro: mensagemErro(e) };
    }
  }

  async metadados(caminho: string): Promise<ResultadoMetadados> {
    if (!this.estaConfigurado()) {
      return { ok: false, naoConfigurado: true, erro: "Supabase Storage não configurado." };
    }
    try {
      const barra = caminho.lastIndexOf("/");
      const pasta = barra >= 0 ? caminho.slice(0, barra) : "";
      const nome = barra >= 0 ? caminho.slice(barra + 1) : caminho;

      const { data, error } = await supabaseAdmin.storage
        .from(BUCKET)
        .list(pasta, { search: nome, limit: 100 });

      if (error) return { ok: false, erro: error.message };
      const item = (data ?? []).find((a) => a.name === nome);
      if (!item) return { ok: false, erro: "Arquivo não encontrado." };

      const meta = item.metadata as Record<string, unknown> | null;
      return {
        ok: true,
        metadados: {
          nome: item.name,
          tamanhoBytes: typeof meta?.size === "number" ? meta.size : undefined,
          mimeType: typeof meta?.mimetype === "string" ? meta.mimetype : undefined,
          criadoEm: item.created_at ? new Date(item.created_at) : undefined,
        },
      };
    } catch (e) {
      return { ok: false, erro: mensagemErro(e) };
    }
  }

  async healthCheck(): Promise<ResultadoHealthCheck> {
    const verificadoEm = new Date();
    if (!this.estaConfigurado()) {
      return {
        provedor: this.provedor,
        configurado: false,
        disponivel: false,
        detalhe: `Variáveis ausentes: ${this.faltando().join(", ")}.`,
        verificadoEm,
      };
    }
    try {
      const { error } = await supabaseAdmin.storage.getBucket(BUCKET);
      if (error && !/not found/i.test(error.message)) {
        return {
          provedor: this.provedor,
          configurado: true,
          disponivel: false,
          detalhe: error.message,
          verificadoEm,
        };
      }
      return {
        provedor: this.provedor,
        configurado: true,
        disponivel: true,
        detalhe: error ? `Bucket "${BUCKET}" será criado no primeiro envio.` : `Bucket "${BUCKET}" acessível.`,
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

export const supabaseStorage = new SupabaseStorageAdapter();
export const BUCKET_DOCUMENTOS = BUCKET;
