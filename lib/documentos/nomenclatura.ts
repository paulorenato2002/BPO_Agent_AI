import "server-only";
import { sanitizarNomeArquivo } from "./inspecao";

/**
 * Regras CONFIGURÁVEIS de nomenclatura e destino de documentos.
 *
 * Padrões iniciais (ambos sobrescrevíveis por variável de ambiente):
 *   nome   : {empresa_codigo}_{competencia}_{tipo_documento}_v{versao}.{extensao}
 *   destino: /{empresa}/{ano}/{competencia}/{tipo_documento}/
 *
 * O nome ORIGINAL nunca é substituído — ele é preservado em
 * documentos_operacionais.nome_original. O nome padronizado é um campo à parte.
 */

export const PADRAO_NOME_ARQUIVO =
  process.env.PADRAO_NOME_ARQUIVO ??
  "{empresa_codigo}_{competencia}_{tipo_documento}_v{versao}.{extensao}";

export const PADRAO_PASTA =
  process.env.PADRAO_PASTA_DOCUMENTOS ??
  "{empresa_codigo}/{ano}/{competencia}/{tipo_documento}";

export type DadosNomenclatura = {
  empresaCodigo: string;
  ano?: number | null;
  mes?: number | null;
  tipoDocumento: string;
  versao: number;
  extensao: string;
};

/** Normaliza um pedaço de nome: sem acento, sem espaço, seguro para storage. */
export function normalizarSegmento(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove marcas de acentuação
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/** Competência no formato AAAA-MM; `SEM_COMPETENCIA` quando não identificada. */
export function formatarCompetencia(ano?: number | null, mes?: number | null): string {
  if (!ano || !mes) return "SEM_COMPETENCIA";
  return `${ano}-${String(mes).padStart(2, "0")}`;
}

function aplicarPadrao(padrao: string, dados: DadosNomenclatura): string {
  const competencia = formatarCompetencia(dados.ano, dados.mes);
  const substituicoes: Record<string, string> = {
    empresa_codigo: normalizarSegmento(dados.empresaCodigo),
    empresa: normalizarSegmento(dados.empresaCodigo),
    competencia,
    ano: dados.ano ? String(dados.ano) : "SEM_ANO",
    mes: dados.mes ? String(dados.mes).padStart(2, "0") : "SEM_MES",
    tipo_documento: normalizarSegmento(dados.tipoDocumento),
    versao: String(dados.versao),
    extensao: dados.extensao.toLowerCase(),
  };

  return padrao.replace(/\{(\w+)\}/g, (original, chave: string) =>
    chave in substituicoes ? substituicoes[chave] : original
  );
}

/** Gera o nome padronizado do arquivo. */
export function gerarNomePadronizado(dados: DadosNomenclatura): string {
  return sanitizarNomeArquivo(aplicarPadrao(PADRAO_NOME_ARQUIVO, dados));
}

/**
 * Gera o caminho de destino (pasta). Cada segmento é sanitizado
 * individualmente, então nenhum valor consegue injetar `../`.
 */
export function gerarCaminhoPasta(dados: DadosNomenclatura): string {
  return aplicarPadrao(PADRAO_PASTA, dados)
    .split("/")
    .map((s) => sanitizarNomeArquivo(s))
    .filter(Boolean)
    .join("/");
}

/** Caminho completo (pasta + nome) usado no storage. */
export function gerarCaminhoCompleto(dados: DadosNomenclatura): string {
  return `${gerarCaminhoPasta(dados)}/${gerarNomePadronizado(dados)}`;
}
