import "server-only";

/**
 * Contrato comum dos provedores de armazenamento.
 *
 * REGRA CENTRAL: nenhum adapter retorna `ok: true` sem confirmação real do
 * provedor. "Não configurado" é um estado próprio e explícito — nunca é tratado
 * como sucesso nem mascarado como erro genérico.
 */

export type Provedor = "supabase_storage" | "google_drive" | "local_teste";

export type ResultadoEnvio =
  | {
      ok: true;
      provedor: Provedor;
      caminho: string;
      nomeUtilizado: string;
      bucketOuPasta: string;
      /** ID do arquivo no provedor (ex.: fileId do Drive). */
      identificadorExterno?: string;
      confirmadoEm: Date;
    }
  | {
      ok: false;
      provedor: Provedor;
      erro: string;
      /** true quando faltam credenciais — não é falha de execução. */
      naoConfigurado?: boolean;
    };

export type ResultadoDownload =
  | { ok: true; conteudo: Buffer; mimeType?: string }
  | { ok: false; erro: string; naoConfigurado?: boolean };

export type ResultadoExistencia =
  | { ok: true; existe: boolean; identificadorExterno?: string }
  | { ok: false; erro: string; naoConfigurado?: boolean };

export type ResultadoUrlAssinada =
  | { ok: true; url: string; expiraEm: Date }
  | { ok: false; erro: string; naoConfigurado?: boolean };

export type MetadadosArquivo = {
  nome: string;
  tamanhoBytes?: number;
  mimeType?: string;
  criadoEm?: Date;
  identificadorExterno?: string;
};

export type ResultadoMetadados =
  | { ok: true; metadados: MetadadosArquivo }
  | { ok: false; erro: string; naoConfigurado?: boolean };

export type ResultadoHealthCheck = {
  provedor: Provedor;
  /** `configurado`: credenciais presentes. `disponivel`: respondeu de fato. */
  configurado: boolean;
  disponivel: boolean;
  detalhe: string;
  verificadoEm: Date;
};

export type ParametrosEnvio = {
  caminho: string;
  conteudo: Buffer;
  mimeType: string;
  /** Se false, um arquivo existente no mesmo caminho não é sobrescrito. */
  sobrescrever?: boolean;
};

export interface AdapterArmazenamento {
  readonly provedor: Provedor;
  estaConfigurado(): boolean;
  enviar(params: ParametrosEnvio): Promise<ResultadoEnvio>;
  baixar(caminho: string): Promise<ResultadoDownload>;
  existe(caminho: string): Promise<ResultadoExistencia>;
  copiar(origem: string, destino: string): Promise<ResultadoEnvio>;
  urlAssinada(caminho: string, segundosValidade?: number): Promise<ResultadoUrlAssinada>;
  metadados(caminho: string): Promise<ResultadoMetadados>;
  healthCheck(): Promise<ResultadoHealthCheck>;
}

/** Resposta padronizada para provedor sem credenciais. */
export function naoConfigurado(provedor: Provedor, faltando: string[]): ResultadoEnvio {
  return {
    ok: false,
    provedor,
    naoConfigurado: true,
    erro: `Integração não configurada. Variáveis ausentes: ${faltando.join(", ")}.`,
  };
}
