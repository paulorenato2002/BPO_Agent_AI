import "server-only";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { PDFParse } from "pdf-parse";

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB
// Tetos de segurança (não são limites "normais" — servem só pra não estourar
// memória com um arquivo patológico). Um extrato com milhares de linhas passa
// bem longe disso.
const MAX_LINHAS_SEGURANCA = 200_000;
const MAX_TEXTO_CHARS_SEGURANCA = 500_000;

export type LinhaTabular = Record<string, unknown>;

export type ArquivoParsed =
  | { tipo: "tabular"; colunas: string[]; linhas: LinhaTabular[]; truncado: boolean }
  | { tipo: "texto"; texto: string; descricaoTipo: string; truncado: boolean };

const EXTENSOES_SUPORTADAS = ["csv", "xlsx", "xls", "pdf", "txt"] as const;
const EXTENSOES_TABULARES = ["csv", "xlsx", "xls"] as const;

export function extensaoSuportada(nomeArquivo: string): boolean {
  const ext = nomeArquivo.split(".").pop()?.toLowerCase();
  return !!ext && (EXTENSOES_SUPORTADAS as readonly string[]).includes(ext);
}

export function tipoArquivo(nomeArquivo: string): "tabular" | "texto" {
  const ext = nomeArquivo.split(".").pop()?.toLowerCase();
  return (EXTENSOES_TABULARES as readonly string[]).includes(ext ?? "") ? "tabular" : "texto";
}

async function parseCsv(buffer: Buffer): Promise<ArquivoParsed> {
  const texto = buffer.toString("utf-8");
  const resultado = Papa.parse(texto, { header: true, skipEmptyLines: true });
  const todas = resultado.data as LinhaTabular[];
  const truncado = todas.length > MAX_LINHAS_SEGURANCA;
  const linhas = truncado ? todas.slice(0, MAX_LINHAS_SEGURANCA) : todas;
  const colunas = linhas.length > 0 ? Object.keys(linhas[0]) : [];
  return { tipo: "tabular", colunas, linhas, truncado };
}

async function parseXlsx(buffer: Buffer): Promise<ArquivoParsed> {
  const workbook = new ExcelJS.Workbook();
  // @types/node e o .d.ts embutido do exceljs divergem na assinatura genérica de Buffer;
  // é o mesmo tipo em runtime, então o cast aqui só destrava o typecheck.
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const worksheet = workbook.worksheets[0];
  if (!worksheet || worksheet.rowCount === 0) {
    throw new Error("Planilha vazia ou sem abas.");
  }

  const colunas: string[] = [];
  worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    colunas[colNumber - 1] = String(cell.value ?? `coluna_${colNumber}`);
  });

  const linhas: LinhaTabular[] = [];
  const ultimaLinha = Math.min(worksheet.rowCount, MAX_LINHAS_SEGURANCA + 1);
  for (let r = 2; r <= ultimaLinha; r++) {
    const row = worksheet.getRow(r);
    if (row.cellCount === 0) continue;
    const obj: LinhaTabular = {};
    let temValor = false;
    colunas.forEach((coluna, idx) => {
      const valor = row.getCell(idx + 1).value;
      if (valor !== null && valor !== undefined && valor !== "") temValor = true;
      obj[coluna] = valor instanceof Date ? valor.toISOString() : valor;
    });
    if (temValor) linhas.push(obj);
  }

  const truncado = worksheet.rowCount - 1 > MAX_LINHAS_SEGURANCA;
  return { tipo: "tabular", colunas, linhas, truncado };
}

async function parsePdf(buffer: Buffer): Promise<ArquivoParsed> {
  const parser = new PDFParse({ data: buffer });
  try {
    const resultado = await parser.getText();
    const truncado = resultado.text.length > MAX_TEXTO_CHARS_SEGURANCA;
    const texto = truncado ? resultado.text.slice(0, MAX_TEXTO_CHARS_SEGURANCA) : resultado.text;
    return { tipo: "texto", texto, descricaoTipo: `PDF, ${resultado.total} página(s)`, truncado };
  } finally {
    await parser.destroy();
  }
}

async function parseTxt(buffer: Buffer): Promise<ArquivoParsed> {
  const bruto = buffer.toString("utf-8");
  const truncado = bruto.length > MAX_TEXTO_CHARS_SEGURANCA;
  const texto = truncado ? bruto.slice(0, MAX_TEXTO_CHARS_SEGURANCA) : bruto;
  return { tipo: "texto", texto, descricaoTipo: "arquivo de texto", truncado };
}

/** Faz o parse completo do arquivo (sem paginar) — usado tanto no upload
 * (pra montar o resumo/prévia) quanto pelas tools de consulta (que buscam o
 * arquivo original de novo no storage e reparseiam sob demanda). */
export async function parseArquivo(nomeArquivo: string, buffer: Buffer): Promise<ArquivoParsed> {
  const ext = nomeArquivo.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "csv":
      return parseCsv(buffer);
    case "xlsx":
    case "xls":
      return parseXlsx(buffer);
    case "pdf":
      return parsePdf(buffer);
    case "txt":
      return parseTxt(buffer);
    default:
      throw new Error(
        `Tipo de arquivo não suportado: .${ext}. Tipos aceitos: ${EXTENSOES_SUPORTADAS.join(", ")}.`
      );
  }
}
