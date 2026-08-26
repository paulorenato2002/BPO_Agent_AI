import "server-only";
import { supabaseAdmin } from "./supabase-admin";

const BUCKET = "anexos-agente";
let bucketGarantido: Promise<void> | null = null;

async function garantirBucket(): Promise<void> {
  if (!bucketGarantido) {
    bucketGarantido = (async () => {
      const { data } = await supabaseAdmin.storage.getBucket(BUCKET);
      if (!data) {
        const { error } = await supabaseAdmin.storage.createBucket(BUCKET, { public: false });
        // ignora erro de "já existe" (corrida entre requisições concorrentes)
        if (error && !/already exists/i.test(error.message)) throw error;
      }
    })();
  }
  await bucketGarantido;
}

function caminho(arquivoId: string, nomeArquivo: string): string {
  return `${arquivoId}/${nomeArquivo}`;
}

export async function salvarArquivo(
  arquivoId: string,
  nomeArquivo: string,
  buffer: Buffer,
  contentType: string
): Promise<void> {
  await garantirBucket();
  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(caminho(arquivoId, nomeArquivo), buffer, { contentType, upsert: true });
  if (error) throw new Error(`Falha ao salvar arquivo no storage: ${error.message}`);
}

export async function lerArquivo(arquivoId: string, nomeArquivo: string): Promise<Buffer> {
  await garantirBucket();
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .download(caminho(arquivoId, nomeArquivo));
  if (error || !data) {
    throw new Error(
      `Arquivo anexado não encontrado (id ${arquivoId}, nome ${nomeArquivo}). Peça pro usuário reenviar.`
    );
  }
  return Buffer.from(await data.arrayBuffer());
}
