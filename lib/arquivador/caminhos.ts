import "server-only";
import { normalizarSegmento } from "../documentos/nomenclatura";
import { sanitizarNomeArquivo } from "../documentos/inspecao";

/**
 * Expansão de uma REGRA de arquivamento em caminho e nome concretos.
 *
 * Este módulo é PURO: não fala com o banco nem com o Drive. Só transforma
 * (regra + contexto) em (segmentos, chaves lógicas, nome do arquivo). É onde
 * mora a decisão de "onde isso vai e como se chama" — e por ser puro, é a
 * parte que dá para testar exaustivamente sem rede.
 *
 * Nenhum caminho é hardcoded: tudo vem de `regras_arquivamento.caminho_modelo`
 * e `padrao_nome`, carregados do banco.
 *
 * PLACEHOLDERS DE CAMINHO: {ANO} {COMPETENCIA} {PROJETO}
 * PLACEHOLDERS DE NOME:    {CODIGO} {EMPRESA} {COMPETENCIA} {TIPO_DOCUMENTO}
 *                          {INSTITUICAO} {PROJETO} {DATA_DOCUMENTO} {VERSAO}
 *                          {EXTENSAO}
 *
 * {CODIGO}  = código curto da empresa (ex.: TL)
 * {EMPRESA} = nome normalizado da empresa; cai para o código se não houver.
 *
 * Placeholder opcional que não tem valor é REMOVIDO, e os separadores que
 * sobram são colapsados — nunca sai um `{INSTITUICAO}` literal nem um `__`
 * no meio do nome.
 */

export type EscopoRegra = "interno" | "fixo" | "mensal" | "projeto";

/** Escopo de uma pasta, espelhando o CHECK de pastas_drive.escopo. */
export type EscopoPasta =
  | "raiz"
  | "estrutural"
  | "empresa"
  | "periodo"
  | "categoria"
  | "projeto";

export type RegraArquivamento = {
  id: string;
  codigo: string;
  nome: string;
  escopo: EscopoRegra;
  caminho_modelo: string[];
  padrao_nome: string;
  exige_empresa: boolean;
  exige_competencia: boolean;
  exige_instituicao: boolean;
  projeto: string | null;
  subcategoria: string | null;
};

export type ContextoArquivamento = {
  empresaId?: string | null;
  empresaCodigo?: string | null;
  empresaNome?: string | null;
  /** Nome exato da pasta já existente, resolvido por código da empresa. */
  pastaEmpresa?: string | null;
  /**
   * Nome do contêiner onde a pasta da empresa vive
   * (01_CLIENTES_ATIVOS ou 02_CLIENTES_INATIVOS).
   *
   * Vem de `estrutura_fixa_drive`, escolhido pelo chamador conforme
   * `empresas.ativo`. Não tem valor padrão de propósito: chutar "ativos"
   * arquivaria documento de cliente inativo no lugar errado, em silêncio.
   */
  pastaClientes?: string | null;
  /** Competência no formato AAAA-MM. */
  competencia?: string | null;
  instituicao?: string | null;
  tipoDocumento?: string | null;
  /** Data do documento no formato AAAA-MM-DD. */
  dataDocumento?: string | null;
  versao?: number | null;
  extensao?: string | null;
  projeto?: string | null;
};

/** Um nível da árvore de pastas, já com a identidade que vai para o banco. */
export type SegmentoDestino = {
  nome: string;
  escopo: EscopoPasta;
  /** Identidade estável da pasta. Renomear a empresa não quebra o vínculo. */
  chaveLogica: string;
  /** Caminho acumulado até este nível, para leitura humana. */
  caminhoLogico: string;
};

export type DestinoResolvido = {
  ok: true;
  segmentos: SegmentoDestino[];
  /** Caminho completo da pasta final, relativo à raiz do Drive. */
  caminhoLogico: string;
  /** Chave lógica da pasta final — a que o resolvedor usa. */
  chaveLogica: string;
};

export type FalhaDestino = {
  ok: false;
  erro: string;
  /** Campos do contexto que faltaram, para o agente saber o que perguntar. */
  faltando: string[];
};

const FORMATO_COMPETENCIA = /^\d{4}-(0[1-9]|1[0-2])$/;
const FORMATO_DATA = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Nome da pasta da empresa. Prefere o código curto; cai para o nome. */
function nomePastaEmpresa(ctx: ContextoArquivamento): string {
  if (ctx.pastaEmpresa) return sanitizarNomeArquivo(ctx.pastaEmpresa);
  return normalizarSegmento(ctx.empresaCodigo ?? ctx.empresaNome ?? "");
}

/**
 * Valida o contexto contra o que a regra exige.
 *
 * Devolve a LISTA do que falta em vez de lançar: o agente precisa saber
 * exatamente o que perguntar ao usuário, não só que deu errado.
 */
function conferirExigencias(
  regra: RegraArquivamento,
  ctx: ContextoArquivamento
): string[] {
  const faltando: string[] = [];

  if (regra.exige_empresa) {
    if (!ctx.empresaId) faltando.push("empresaId");
    if (!ctx.empresaCodigo && !ctx.empresaNome) faltando.push("empresaCodigo");
    // Sem o contêiner não dá para montar o caminho: a pasta da empresa cairia
    // solta na raiz do Drive, ao lado de 00_INTERNO.
    if (!ctx.pastaClientes) faltando.push("pastaClientes");
  }

  if (regra.exige_competencia && !ctx.competencia) faltando.push("competencia");
  if (regra.exige_instituicao && !ctx.instituicao) faltando.push("instituicao");

  // Só exigimos projeto se o modelo realmente usar o placeholder — as regras
  // de projeto atuais trazem o nome do projeto literal no caminho.
  const usaProjeto = regra.caminho_modelo.some((s) => s.includes("{PROJETO}"));
  if (usaProjeto && !(ctx.projeto ?? regra.projeto)) faltando.push("projeto");

  return faltando;
}

/** Descobre o escopo de uma pasta a partir do que gerou aquele segmento. */
function escopoDoSegmento(
  modeloOriginal: string,
  regra: RegraArquivamento,
  indice: number
): EscopoPasta {
  if (modeloOriginal.includes("{ANO}") || modeloOriginal.includes("{COMPETENCIA}") || modeloOriginal.includes("{COMPETENCIA_PASTA}")) {
    return "periodo";
  }
  if (modeloOriginal.includes("{PROJETO}")) return "projeto";

  // Regra de projeto: o segundo segmento do modelo é o nome do projeto,
  // escrito literalmente (ex.: CONFERENCIA_DE_CARTOES).
  if (regra.escopo === "projeto" && indice === 1) return "projeto";

  return regra.escopo === "interno" ? "estrutural" : "categoria";
}

/**
 * Expande a regra numa árvore de pastas concreta.
 *
 * Para regras com empresa, o primeiro nível é a pasta da EMPRESA e o
 * `caminho_modelo` começa logo abaixo dela. Para regras internas, o modelo
 * começa direto na raiz.
 */
export function expandirDestino(
  regra: RegraArquivamento,
  ctx: ContextoArquivamento
): DestinoResolvido | FalhaDestino {
  const faltando = conferirExigencias(regra, ctx);
  if (faltando.length > 0) {
    return {
      ok: false,
      erro: `A regra ${regra.codigo} exige: ${faltando.join(", ")}.`,
      faltando,
    };
  }

  if (ctx.competencia && !FORMATO_COMPETENCIA.test(ctx.competencia)) {
    return {
      ok: false,
      erro: `Competência "${ctx.competencia}" fora do formato AAAA-MM.`,
      faltando: ["competencia"],
    };
  }

  const ano = ctx.competencia ? ctx.competencia.slice(0, 4) : null;
  const projeto = normalizarSegmento(ctx.projeto ?? regra.projeto ?? "");

  const substituicoes: Record<string, string | null> = {
    ANO: ano,
    COMPETENCIA: ctx.competencia ?? null,
    COMPETENCIA_PASTA: ctx.competencia ? `${ctx.competencia.slice(5, 7)}.${ano}` : null,
    PROJETO: projeto || null,
  };

  const segmentos: SegmentoDestino[] = [];

  // A empresa entra na chave pelo UUID, não pelo nome: renomear a empresa
  // não pode quebrar o vínculo com a pasta já criada no Drive.
  const usaEmpresa = regra.exige_empresa;
  let prefixoChave = usaEmpresa ? `empresa:${ctx.empresaId}` : "estrutural";
  let caminhoAcumulado = "";

  if (usaEmpresa) {
    // 1º nível: o contêiner de clientes. A pasta de empresa NUNCA fica solta
    // na raiz — lá em cima só existem 00_INTERNO e os dois contêineres.
    const container = sanitizarNomeArquivo(ctx.pastaClientes ?? "").replace(/[/\\]/g, "_");
    if (!container) {
      return {
        ok: false,
        erro: "O contêiner de clientes ficou vazio após sanitização.",
        faltando: ["pastaClientes"],
      };
    }

    caminhoAcumulado = container;
    segmentos.push({
      nome: container,
      escopo: "estrutural",
      chaveLogica: `estrutural:${container}`,
      caminhoLogico: caminhoAcumulado,
    });

    // 2º nível: a empresa. A chave é SÓ `empresa:<uuid>`, sem o contêiner —
    // se o cliente vira inativo, o caminho desejado muda mas a chave não, e o
    // resolvedor reencontra a pasta existente em vez de criar uma segunda.
    // Mover a pasta é decisão humana, não efeito colateral de um upload.
    const nome = nomePastaEmpresa(ctx);
    if (!nome) {
      return {
        ok: false,
        erro: "Não foi possível montar o nome da pasta da empresa.",
        faltando: ["empresaCodigo"],
      };
    }

    caminhoAcumulado = `${caminhoAcumulado}/${nome}`;
    segmentos.push({
      nome,
      escopo: "empresa",
      chaveLogica: prefixoChave,
      caminhoLogico: caminhoAcumulado,
    });
  }

  for (const [indice, modelo] of regra.caminho_modelo.entries()) {
    let faltouPlaceholder: string | null = null;

    const expandido = modelo.replace(/\{([A-Z_]+)\}/g, (original, chave: string) => {
      if (!(chave in substituicoes)) return original;
      const valor = substituicoes[chave];
      if (valor === null) {
        faltouPlaceholder = chave;
        return original;
      }
      return valor;
    });

    if (faltouPlaceholder !== null) {
      const nomePlaceholder: string = faltouPlaceholder;
      return {
        ok: false,
        erro: `A regra ${regra.codigo} usa {${nomePlaceholder}} no caminho, mas o valor não foi informado.`,
        faltando: [nomePlaceholder.toLowerCase()],
      };
    }

    // Cada segmento é sanitizado isoladamente: nenhum valor consegue injetar
    // barra, `..` ou caractere de controle no caminho.
    const nome = sanitizarNomeArquivo(expandido).replace(/[/\\]/g, "_");
    if (!nome) {
      return {
        ok: false,
        erro: `O segmento "${modelo}" da regra ${regra.codigo} ficou vazio após sanitização.`,
        faltando: [],
      };
    }

    caminhoAcumulado = caminhoAcumulado ? `${caminhoAcumulado}/${nome}` : nome;
    prefixoChave = `${prefixoChave}:${nome}`;

    segmentos.push({
      nome,
      escopo: escopoDoSegmento(modelo, regra, indice),
      chaveLogica: prefixoChave,
      caminhoLogico: caminhoAcumulado,
    });
  }

  if (segmentos.length === 0) {
    return {
      ok: false,
      erro: `A regra ${regra.codigo} não produziu nenhuma pasta.`,
      faltando: [],
    };
  }

  const folha = segmentos[segmentos.length - 1];
  return {
    ok: true,
    segmentos,
    caminhoLogico: folha.caminhoLogico,
    chaveLogica: folha.chaveLogica,
  };
}

/**
 * Constrói segmentos para um caminho ESTRUTURAL literal, sem placeholder.
 *
 * Usado pela estrutura fixa (00_INTERNO, contêineres de clientes). Gera as
 * mesmas chaves que `expandirDestino` gera para regras internas, então a
 * pasta criada pelo bootstrap é exatamente a mesma que o arquivamento
 * reencontra depois — não são duas pastas com o mesmo nome.
 */
export function segmentosEstruturais(caminho: string[]): SegmentoDestino[] {
  const segmentos: SegmentoDestino[] = [];
  let chave = "estrutural";
  let acumulado = "";

  for (const bruto of caminho) {
    const nome = sanitizarNomeArquivo(bruto).replace(/[/\\]/g, "_");
    if (!nome) continue;

    chave = `${chave}:${nome}`;
    acumulado = acumulado ? `${acumulado}/${nome}` : nome;
    segmentos.push({ nome, escopo: "estrutural", chaveLogica: chave, caminhoLogico: acumulado });
  }

  return segmentos;
}

/**
 * Monta o nome final do arquivo a partir de `padrao_nome`.
 *
 * O nome ORIGINAL nunca é sobrescrito — ele continua em
 * documentos_operacionais.nome_original. Este é o nome do DESTINO.
 */
export function montarNomeArquivo(
  regra: RegraArquivamento,
  ctx: ContextoArquivamento
): { ok: true; nome: string } | FalhaDestino {
  const faltando = conferirExigencias(regra, ctx);
  if (!ctx.extensao) faltando.push("extensao");
  if (!ctx.tipoDocumento && regra.padrao_nome.includes("{TIPO_DOCUMENTO}")) {
    faltando.push("tipoDocumento");
  }
  if (faltando.length > 0) {
    return {
      ok: false,
      erro: `Para nomear pela regra ${regra.codigo} faltam: ${faltando.join(", ")}.`,
      faltando,
    };
  }

  if (ctx.dataDocumento && !FORMATO_DATA.test(ctx.dataDocumento)) {
    return {
      ok: false,
      erro: `Data do documento "${ctx.dataDocumento}" fora do formato AAAA-MM-DD.`,
      faltando: ["dataDocumento"],
    };
  }

  const empresaNome = ctx.empresaNome ?? ctx.empresaCodigo ?? "";

  // null = placeholder opcional sem valor: sai do nome em vez de virar lixo.
  const substituicoes: Record<string, string | null> = {
    CODIGO: normalizarSegmento(ctx.empresaCodigo ?? "") || null,
    EMPRESA: normalizarSegmento(empresaNome) || null,
    COMPETENCIA: ctx.competencia ?? null,
    TIPO_DOCUMENTO: normalizarSegmento(ctx.tipoDocumento ?? "") || null,
    INSTITUICAO: normalizarSegmento(ctx.instituicao ?? "") || null,
    PROJETO: normalizarSegmento(ctx.projeto ?? regra.projeto ?? "") || null,
    DATA_DOCUMENTO: ctx.dataDocumento ?? null,
    VERSAO: String(ctx.versao ?? 1),
    EXTENSAO: (ctx.extensao ?? "").toLowerCase().replace(/^\.+/, ""),
  };

  const bruto = regra.padrao_nome.replace(
    /\{([A-Z_]+)\}/g,
    (original, chave: string) => {
      if (!(chave in substituicoes)) return original;
      return substituicoes[chave] ?? "";
    }
  );

  // Colapsa o rastro dos placeholders removidos: "A__B" -> "A_B",
  // "A_.pdf" -> "A.pdf", "_A" -> "A".
  const limpo = bruto
    .replace(/_{2,}/g, "_")
    .replace(/_+\./g, ".")
    .replace(/^_+|_+$/g, "");

  const nome = sanitizarNomeArquivo(limpo);
  if (!nome) {
    return {
      ok: false,
      erro: `O nome gerado pela regra ${regra.codigo} ficou vazio.`,
      faltando: [],
    };
  }

  return { ok: true, nome };
}
