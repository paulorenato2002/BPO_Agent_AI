/**
 * Assinaturas de documento: o que faz um arquivo ser reconhecível no mês
 * seguinte sem passar pelo modelo de novo.
 *
 * Módulo PURO: recebe texto já extraído e devolve identificadores. Não toca
 * banco, disco nem rede.
 *
 * POR QUE DUAS ASSINATURAS, E NÃO UMA
 * -----------------------------------
 * "De quem é" e "o que é" são perguntas diferentes e envelhecem diferente:
 *
 *   CONTA    responde DE QUEM É. A conta 1.136.082-8 do Sicoob é do TL
 *            Academia hoje e continuará sendo. É um fato de cadastro.
 *
 *   LAYOUT   responde O QUE É. O export de vendas da Cielo tem as mesmas
 *            colunas para todos os clientes — o layout diz que é um relatório
 *            de vendas, e não de quem.
 *
 * Misturar as duas numa assinatura só significaria reaprender o tipo do
 * documento a cada cliente novo, e perder o tipo quando o cliente troca de
 * conta.
 *
 * POR QUE A CONTA VALE MAIS QUE O TEXTO
 * -------------------------------------
 * Hoje a empresa é identificada procurando o código do cliente no conteúdo.
 * Num extrato bancário isso dá conflito real: os números "147" e "210" — que
 * são códigos de dois clientes — aparecem como valores no meio dos
 * lançamentos, e o documento é recusado por ambiguidade. A conta não tem esse
 * problema: ela identifica o titular, não coincide com um valor qualquer.
 */

import { createHash } from "node:crypto";

export type ContaIdentificada = {
  /** Só dígitos, sem ponto nem traço: "1.136.082-8" e "1136082-8" viram o mesmo. */
  conta: string;
  /** Agência/cooperativa em dígitos, quando o documento traz. */
  agencia: string | null;
  /** Nome da instituição como apareceu, para exibição. Não entra na chave. */
  instituicao: string | null;
};

export type AssinaturasDoArquivo = {
  conta: ContaIdentificada | null;
  /** Hash curto do layout. `null` quando não há sinal estável. */
  layout: string | null;
};

/** Só os dígitos. É a forma canônica de qualquer número de conta ou agência. */
function digitos(valor: string): string {
  return valor.replace(/\D/g, "");
}

/**
 * Uma conta plausível tem de 4 a 20 dígitos.
 *
 * Abaixo de 4 pega qualquer número solto; acima de 20 já é código de barras
 * ou identificador de transação, não conta.
 */
function contaPlausivel(d: string): boolean {
  return d.length >= 4 && d.length <= 20;
}

/**
 * Rótulos que precedem um número de conta nos documentos que passam por aqui.
 *
 * Deliberadamente ancorados no rótulo: procurar "um número com traço" acharia
 * dezenas por página. `Conta Cartão` vem antes de `Conta` na lista porque a
 * regex mais específica precisa ganhar.
 */
const PADROES_CONTA: RegExp[] = [
  /conta\s*cart(?:ã|a)o\s*[:\s]\s*([\d][\d.\s-]{3,24})/i,
  /(?:^|\n)\s*conta\s*(?:corrente)?\s*[:\s]\s*([\d][\d.\s-]{3,24})/i,
  /\bconta\s+([\d][\d.-]{3,24})\b/i,
];

const PADROES_AGENCIA: RegExp[] = [
  /(?:ag(?:ê|e)ncia|cooperativa)\s*[:\s]\s*([\d][\d.\s-]{2,12})/i,
];

const INSTITUICOES: { nome: string; regex: RegExp }[] = [
  {
    // O OFX se apresenta como "Banco Cooperativo do Brasil"; o PDF do mesmo
    // banco diz "SICOOB". Sem as duas formas, o mesmo extrato em formatos
    // diferentes ficaria com instituições diferentes.
    nome: "SICOOB",
    regex: /\bsicoob\b|cooperativas? de cr(?:é|e)dito do brasil|banco cooperativo do brasil/i,
  },
  { nome: "CIELO", regex: /\bcielo\b/i },
  { nome: "BANCO DO BRASIL", regex: /\bbanco do brasil\b/i },
  { nome: "ITAU", regex: /\bita(?:ú|u)\b/i },
  { nome: "BRADESCO", regex: /\bbradesco\b/i },
  { nome: "SANTANDER", regex: /\bsantander\b/i },
  { nome: "CAIXA", regex: /\bcaixa econ(?:ô|o)mica\b/i },
  { nome: "NUBANK", regex: /\bnubank\b/i },
  { nome: "INTER", regex: /\bbanco inter\b/i },
  { nome: "STONE", regex: /\bstone\b/i },
  { nome: "PAGSEGURO", regex: /\bpagseguro\b|\bpagbank\b/i },
  { nome: "REDE", regex: /\bredecard\b/i },
];

export function identificarInstituicao(texto: string): string | null {
  for (const { nome, regex } of INSTITUICOES) {
    if (regex.test(texto)) return nome;
  }
  return null;
}

/**
 * Extrai a conta do documento.
 *
 * Devolve `null` quando não há rótulo de conta — e é o certo. Chutar um número
 * qualquer como conta criaria uma assinatura errada que, uma vez confirmada,
 * passaria a arquivar documentos de outro cliente sozinha. Um aprendizado
 * errado é pior que aprendizado nenhum.
 */
export function extrairConta(texto: string): ContaIdentificada | null {
  let conta: string | null = null;

  for (const padrao of PADROES_CONTA) {
    const achado = texto.match(padrao)?.[1];
    if (!achado) continue;
    const d = digitos(achado);
    if (contaPlausivel(d)) {
      conta = d;
      break;
    }
  }

  if (!conta) return null;

  let agencia: string | null = null;
  for (const padrao of PADROES_AGENCIA) {
    const achado = texto.match(padrao)?.[1];
    if (!achado) continue;
    const d = digitos(achado);
    if (d.length >= 2 && d.length <= 12) {
      agencia = d;
      break;
    }
  }

  return { conta, agencia, instituicao: identificarInstituicao(texto) };
}

/**
 * Chave da conta, para casar com o cadastro.
 *
 * A AGÊNCIA FICA DE FORA de propósito. O mesmo extrato aparece como
 * "Cooperativa: 5004-0" num relatório e "Cooperativa: 5004" em outro — o
 * dígito verificador entra e sai conforme a tela que gerou o PDF. Incluir a
 * agência criaria duas chaves para a mesma conta e o aprendizado nunca casaria.
 * O número da conta sozinho já é específico o bastante dentro de uma carteira.
 */
export function chaveConta(conta: ContaIdentificada): string {
  return conta.conta;
}

const MAX_LINHAS_NO_ESQUELETO = 12;

/**
 * Assinatura de layout.
 *
 * PLANILHA: o conjunto de cabeçalhos, ordenado e normalizado. O export da
 * Cielo tem as mesmas 40 colunas todo mês; a ordem pode mudar, o conjunto não.
 *
 * TEXTO/PDF: as primeiras linhas com todo número removido — o "esqueleto" do
 * cabeçalho. "EXTRATO DE CONTA CORRENTE 09/09/2026" e a versão de outubro
 * viram a mesma coisa depois que as datas somem.
 *
 * Devolve `null` quando não sobra sinal — um PDF só de números não tem layout
 * reconhecível, e inventar um faria documentos diferentes colidirem.
 */
export function assinaturaLayout(
  entrada: { tipo: "tabular"; colunas: string[] } | { tipo: "texto"; texto: string }
): string | null {
  let base: string;

  if (entrada.tipo === "tabular") {
    const colunas = entrada.colunas
      .map((c) => c.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim())
      .filter(Boolean)
      .sort();
    if (colunas.length < 2) return null;
    base = `colunas:${colunas.join("|")}`;
  } else {
    const esqueleto = entrada.texto
      .split(/\r?\n/)
      .slice(0, MAX_LINHAS_NO_ESQUELETO)
      .map((l) =>
        l
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .toUpperCase()
          .replace(/[0-9]+/g, "")
          .replace(/[^A-Z]+/g, " ")
          .trim()
      )
      .filter((l) => l.length >= 4);
    // Menos de três linhas com letra não é cabeçalho, é ruído de extração.
    if (esqueleto.length < 3) return null;
    base = `texto:${esqueleto.join("|")}`;
  }

  return createHash("sha256").update(base).digest("hex").slice(0, 32);
}

/** As duas assinaturas de um arquivo já extraído. */
export function assinaturasDoArquivo(
  parsed: { tipo: "tabular"; colunas: string[] } | { tipo: "texto"; texto: string },
  textoCompleto: string
): AssinaturasDoArquivo {
  return {
    conta: extrairConta(textoCompleto),
    layout: assinaturaLayout(parsed),
  };
}
