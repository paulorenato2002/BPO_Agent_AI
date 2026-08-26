import "server-only";
import { createHash } from "node:crypto";

/**
 * Inspeção de arquivos recebidos: metadados, hash e validação.
 *
 * Regras de segurança aplicadas aqui:
 *   - nunca executar o arquivo recebido;
 *   - validar extensão, MIME type e tamanho antes de qualquer coisa;
 *   - normalizar o nome para evitar path traversal (`../`, separadores, etc.).
 */

export const TAMANHO_MAXIMO_BYTES = 20 * 1024 * 1024; // 20 MB

/** Extensões aceitas e o MIME type esperado para cada uma. */
const EXTENSOES_PERMITIDAS: Record<string, string[]> = {
  csv: ["text/csv", "application/csv", "text/plain"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  xls: ["application/vnd.ms-excel"],
  pdf: ["application/pdf"],
  txt: ["text/plain"],
  json: ["application/json", "text/plain"],
  xml: ["application/xml", "text/xml"],
  ofx: ["application/x-ofx", "text/plain", "application/octet-stream"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
};

export type ArquivoInspecionado = {
  nomeOriginal: string;
  nomeSeguro: string;
  extensao: string;
  mimeType: string;
  tamanhoBytes: number;
  hashSha256: string;
};

export type FalhaInspecao = {
  erro: string;
  codigo:
    | "extensao_nao_permitida"
    | "tamanho_excedido"
    | "arquivo_vazio"
    | "nome_invalido"
    | "mime_incompativel";
};

export function extensoesPermitidas(): string[] {
  return Object.keys(EXTENSOES_PERMITIDAS);
}

/**
 * Remove qualquer componente de caminho do nome recebido.
 *
 * Um nome como `../../etc/passwd` ou `C:\Windows\system32\x.txt` vira apenas
 * `passwd` / `x.txt`. Isso impede que o nome enviado pelo usuário escape do
 * diretório de destino ao ser concatenado num caminho de storage.
 */
export function sanitizarNomeArquivo(nome: string): string {
  const semCaminho = nome.split(/[/\\]/).pop() ?? "";
  return semCaminho
    .replace(/\0/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .replace(/[<>:"|?*]/g, "_")
    .trim()
    .slice(0, 200);
}

export function extrairExtensao(nome: string): string {
  const partes = sanitizarNomeArquivo(nome).split(".");
  if (partes.length < 2) return "";
  return partes.pop()!.toLowerCase();
}

export function calcularHashSha256(conteudo: Buffer): string {
  return createHash("sha256").update(conteudo).digest("hex");
}

/**
 * Inspeciona um arquivo recebido. Retorna os metadados ou uma falha explícita —
 * nunca lança para erro de validação previsível.
 */
export function inspecionarArquivo(
  nomeOriginal: string,
  conteudo: Buffer,
  mimeTypeInformado?: string
): ArquivoInspecionado | FalhaInspecao {
  const nomeSeguro = sanitizarNomeArquivo(nomeOriginal);
  if (!nomeSeguro) {
    return { erro: "Nome de arquivo inválido.", codigo: "nome_invalido" };
  }

  if (conteudo.length === 0) {
    return { erro: "Arquivo vazio.", codigo: "arquivo_vazio" };
  }

  if (conteudo.length > TAMANHO_MAXIMO_BYTES) {
    const limiteMb = Math.round(TAMANHO_MAXIMO_BYTES / 1024 / 1024);
    return {
      erro: `Arquivo maior que o limite de ${limiteMb}MB.`,
      codigo: "tamanho_excedido",
    };
  }

  const extensao = extrairExtensao(nomeSeguro);
  if (!extensao || !(extensao in EXTENSOES_PERMITIDAS)) {
    return {
      erro: `Extensão ".${extensao || "?"}" não é aceita. Aceitas: ${extensoesPermitidas().join(", ")}.`,
      codigo: "extensao_nao_permitida",
    };
  }

  // O MIME informado pelo navegador não é confiável, mas se vier claramente
  // incompatível com a extensão vale registrar. Preferimos o MIME canônico da
  // extensão para evitar que um `Content-Type` forjado influencie o destino.
  const mimesEsperados = EXTENSOES_PERMITIDAS[extensao];
  const mimeType =
    mimeTypeInformado && mimesEsperados.includes(mimeTypeInformado)
      ? mimeTypeInformado
      : mimesEsperados[0];

  return {
    nomeOriginal,
    nomeSeguro,
    extensao,
    mimeType,
    tamanhoBytes: conteudo.length,
    hashSha256: calcularHashSha256(conteudo),
  };
}

export function ehFalhaInspecao(
  r: ArquivoInspecionado | FalhaInspecao
): r is FalhaInspecao {
  return "erro" in r;
}
