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

const EXTENSOES_SUPORTADAS = ["csv", "xlsx", "xls", "pdf", "txt", "ofx"] as const;
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

/**
 * Onde começa a tabela de verdade.
 *
 * Assumir que o cabeçalho é a linha 1 quebra em todo relatório que sai de
 * portal de banco ou adquirente: eles abrem com um bloco decorativo — logo,
 * telefone da ouvidoria, dados de quem exportou. O export da Cielo é assim, e
 * o resultado era ler quatro "colunas" de texto institucional e nenhuma das
 * colunas reais. O documento chegava ao classificador praticamente vazio.
 *
 * O CABEÇALHO É A LINHA QUE PARECE CABEÇALHO: muitas células preenchidas e
 * todas curtas. Célula de banner tem parágrafo com quebra de linha dentro;
 * cabeçalho tem "Data da venda", "Valor bruto".
 *
 * Empate vai para a primeira linha, e quando nada se destaca fica a 1 — o
 * comportamento antigo, que serve para a planilha comum.
 */
const MAX_LINHAS_PROCURANDO_CABECALHO = 25;
const MAX_CHARS_CELULA_DE_CABECALHO = 60;

function acharLinhaDeCabecalho(worksheet: ExcelJS.Worksheet): number {
  const limite = Math.min(worksheet.rowCount, MAX_LINHAS_PROCURANDO_CABECALHO);

  let melhorLinha = 1;
  let melhorPontuacao = -1;

  for (let r = 1; r <= limite; r++) {
    const row = worksheet.getRow(r);
    let preenchidas = 0;
    let curtas = 0;
    const distintas = new Set<string>();

    row.eachCell({ includeEmpty: false }, (cell) => {
      const texto = String(cell.value ?? "").trim();
      if (!texto) return;
      preenchidas += 1;
      distintas.add(texto);
      // Quebra de linha é a marca do banner: nenhum cabeçalho de coluna tem.
      if (texto.length <= MAX_CHARS_CELULA_DE_CABECALHO && !texto.includes("\n")) curtas += 1;
    });

    // Uma linha só vale como cabeçalho se a maioria das células for curta.
    if (preenchidas < 2 || curtas * 2 < preenchidas) continue;

    // Célula mesclada aparece repetida em cada coluna que ela cobre. Uma linha
    // com um valor só é o TÍTULO da planilha ("EXTRATO CONTA CORRENTE"), não o
    // cabeçalho — que vem logo abaixo com DATA, DOCUMENTO, VALOR.
    if (distintas.size === 1 && preenchidas > 1) continue;

    const pontuacao = curtas;
    if (pontuacao > melhorPontuacao) {
      melhorPontuacao = pontuacao;
      melhorLinha = r;
    }
  }

  return melhorLinha;
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

  const linhaCabecalho = acharLinhaDeCabecalho(worksheet);

  const colunas: string[] = [];
  worksheet.getRow(linhaCabecalho).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    colunas[colNumber - 1] = String(cell.value ?? `coluna_${colNumber}`);
  });

  const linhas: LinhaTabular[] = [];
  const ultimaLinha = Math.min(worksheet.rowCount, MAX_LINHAS_SEGURANCA + 1);
  for (let r = linhaCabecalho + 1; r <= ultimaLinha; r++) {
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

/**
 * OFX — extrato bancário eletrônico.
 *
 * É SGML, não XML: as tags de valor não fecham (`<ACCTID>1136082-8` e ponto).
 * Por isso a leitura é por expressão regular sobre o texto, e não por um
 * parser de árvore — que engasgaria no primeiro elemento sem fechamento.
 *
 * O QUE SAI DAQUI, E POR QUÊ
 * --------------------------
 * Não devolvemos o arquivo inteiro. Um extrato mensal tem centenas de
 * lançamentos e o classificador não precisa de nenhum deles para saber que
 * isso é um extrato de conta corrente do Sicoob referente a agosto.
 *
 * O que importa é o CABEÇALHO: banco, agência, conta e período. E a conta é o
 * sinal mais forte que existe para saber de quem é o documento — melhor que
 * qualquer número solto no meio do texto, que é o que hoje causa falso
 * conflito entre clientes.
 *
 * AS DATAS DOS LANÇAMENTOS SAEM SEM SEPARADOR (`20260815`), de propósito. No
 * formato `2026-08-15` cada lançamento viraria um candidato a competência, e
 * um extrato com movimento em dois meses seria marcado como "competência
 * conflitante" — que é exatamente o defeito que queremos evitar. O período do
 * extrato é declarado uma vez, com separador, e é ele que vale.
 */
const MAX_LANCAMENTOS_NA_AMOSTRA = 40;

function dataOfx(bruto: string | undefined, comSeparador: boolean): string | null {
  if (!bruto) return null;
  const m = bruto.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  return comSeparador ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}${m[2]}${m[3]}`;
}

async function parseOfx(buffer: Buffer): Promise<ArquivoParsed> {
  // O cabeçalho declara a codificação. Banco brasileiro costuma mandar
  // CHARSET:1252; ler como UTF-8 estragaria todo acento de "Descrição".
  const amostra = buffer.subarray(0, 512).toString("latin1");
  const latin = /CHARSET\s*:\s*1252/i.test(amostra) || /ENCODING\s*:\s*USASCII/i.test(amostra);
  const bruto = buffer.toString(latin ? "latin1" : "utf-8");

  const valor = (tag: string): string | undefined =>
    bruto.match(new RegExp(`<${tag}>\\s*([^<\\r\\n]+)`, "i"))?.[1]?.trim();

  const linhas: string[] = ["Extrato bancário eletrônico (OFX)"];

  const banco = valor("ORG");
  const bankId = valor("BANKID") ?? valor("FID");
  if (banco || bankId) {
    linhas.push(`Instituição: ${[banco, bankId && `código ${bankId}`].filter(Boolean).join(" — ")}`);
  }

  const agencia = valor("BRANCHID");
  const conta = valor("ACCTID");
  const tipoConta = valor("ACCTTYPE");
  if (conta) {
    linhas.push(
      `Conta: ${[agencia && `agência ${agencia}`, `conta ${conta}`, tipoConta]
        .filter(Boolean)
        .join(" / ")}`
    );
  }

  const inicio = dataOfx(valor("DTSTART"), true);
  const fim = dataOfx(valor("DTEND"), true);
  if (inicio && fim) linhas.push(`Período do extrato: ${inicio} a ${fim}`);

  const moeda = valor("CURDEF");
  const saldo = valor("BALAMT");
  if (saldo) linhas.push(`Saldo final: ${saldo}${moeda ? ` ${moeda}` : ""}`);

  const lancamentos = [...bruto.matchAll(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi)];
  linhas.push(`Lançamentos no arquivo: ${lancamentos.length}`);

  if (lancamentos.length) {
    linhas.push("", "Amostra de lançamentos (data sem separador, valor, descrição):");
    for (const [, corpo] of lancamentos.slice(0, MAX_LANCAMENTOS_NA_AMOSTRA)) {
      const campo = (tag: string) =>
        corpo.match(new RegExp(`<${tag}>\\s*([^<\\r\\n]+)`, "i"))?.[1]?.trim() ?? "";
      const partes = [
        dataOfx(campo("DTPOSTED"), false) ?? "",
        campo("TRNAMT"),
        campo("MEMO") || campo("NAME"),
      ].filter(Boolean);
      if (partes.length) linhas.push(`  ${partes.join("  ")}`);
    }
    if (lancamentos.length > MAX_LANCAMENTOS_NA_AMOSTRA) {
      linhas.push(`  ... e mais ${lancamentos.length - MAX_LANCAMENTOS_NA_AMOSTRA}`);
    }
  }

  const texto = linhas.join("\n");
  const truncado = texto.length > MAX_TEXTO_CHARS_SEGURANCA;

  return {
    tipo: "texto",
    texto: truncado ? texto.slice(0, MAX_TEXTO_CHARS_SEGURANCA) : texto,
    descricaoTipo: "extrato bancário OFX",
    // Amostrar não é truncar por limite de segurança: a contagem total dos
    // lançamentos está no texto, então nada foi escondido de quem lê.
    truncado,
  };
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
    case "ofx":
      return parseOfx(buffer);
    default:
      throw new Error(
        `Tipo de arquivo não suportado: .${ext}. Tipos aceitos: ${EXTENSOES_SUPORTADAS.join(", ")}.`
      );
  }
}
