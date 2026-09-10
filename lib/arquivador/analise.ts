import {
  expandirDestino,
  montarNomeArquivo,
  type ContextoArquivamento,
  type RegraArquivamento,
} from "./caminhos";
import { redigirSegredos, verificarBloqueio } from "./bloqueios";
import { assinaturasDoArquivo, chaveConta } from "./assinatura";
import {
  identificarEmpresa,
  identificarCompetencia,
  extrairCnpjs,
  type EmpresaCandidata,
  type Evidencia,
  type NivelConfianca,
} from "./identificar-empresa";

/**
 * Análise de documentos anexados: extrai, identifica, classifica e PROPÕE.
 *
 * A análise NÃO ARQUIVA. Ela não envia ao Drive, não cria pasta de empresa,
 * não renomeia arquivo e não marca documento como arquivado. O produto é uma
 * proposta que fica esperando confirmação explícita — e resposta ambígua não
 * é confirmação.
 *
 * Três decisões que valem explicar:
 *
 * 1. CADA ARQUIVO É ANALISADO SOZINHO. Um lote de cinco anexos pode ter cinco
 *    empresas. Assumir que o lote é homogêneo arquivaria documento de um
 *    cliente na pasta de outro — e passaria despercebido, porque o usuário
 *    conferiria só o primeiro.
 *
 * 2. O MODELO SÓ ESCOLHE CÓDIGO DE REGRA. Ele nunca devolve caminho, nome de
 *    pasta ou id do Drive. O caminho é calculado aqui pelo núcleo puro, a
 *    partir da regra que veio do banco. Se o modelo alucinar um código, ele
 *    não está na lista de regras ativas e a classificação vira `incompleto`.
 *
 * 3. BLOQUEIO ANTES DE LER. A checagem de nome roda antes da extração, e a de
 *    conteúdo antes de qualquer coisa ir para o modelo.
 *
 * As dependências entram por `portas` para o fluxo ser testável sem banco,
 * sem modelo e sem rede.
 */

export type AnexoRegistrado = {
  id: string;
  arquivo_id: string;
  usuario_id: string;
  conversa_id: string | null;
  nome_original: string;
  extensao: string;
  tamanho_bytes: number;
  hash_sha256: string;
  bloqueado: boolean;
  motivo_bloqueio: string | null;
};

/**
 * O que o modelo pode responder. Repare no que NÃO existe aqui: caminho,
 * pasta, id do Drive. O modelo classifica; quem calcula destino é o código.
 */
export type ClassificacaoModelo = {
  regraCodigo: string | null;
  tipoDocumento: string | null;
  instituicao?: string | null;
  dataDocumento?: string | null;
  competencia?: string | null;
  justificativa?: string | null;
};

export type CampoClassificado<T = string | null> = {
  valor: T;
  confianca: NivelConfianca;
};

export type ItemAnalisado = {
  anexoId: string;
  nomeOriginal: string;
  hashSha256: string;
  status: "analisado" | "bloqueado" | "incompleto";
  bloqueio: { motivo: string; categoria: string } | null;
  empresa: CampoClassificado & { empresaId: string | null; rotulo: string | null };
  competencia: CampoClassificado;
  regra: CampoClassificado & { nome: string | null };
  tipoDocumento: CampoClassificado;
  instituicao: CampoClassificado;
  camposFaltantes: string[];
  conflitos: { campo: string; motivo: string }[];
  evidencias: Evidencia[];
  nomeSugerido: string | null;
  caminhoSugerido: string | null;
  possivelDuplicata: { documentoId: string; nome: string; motivo: string } | null;
  /**
   * O que torna este documento reconhecível no mês que vem.
   *
   * Fica no item porque quem aprende é a CONFIRMAÇÃO, não a análise: só depois
   * de uma pessoa aprovar é que a conta e o layout viram cadastro. Guardar aqui
   * é o que liga os dois momentos.
   *
   * OPCIONAL de propósito: propostas gravadas antes desta versão não têm o
   * campo, e continuam sendo confirmáveis. Elas só não ensinam nada.
   */
  assinaturas?: { conta: string | null; agencia: string | null; layout: string | null };
};

export type PropostaGerada = {
  propostaId: string;
  status: "aguardando";
  expiraEm: string;
  itens: ItemAnalisado[];
  resumo: {
    total: number;
    prontos: number;
    incompletos: number;
    bloqueados: number;
    empresasDistintas: number;
  };
};

export type ResultadoAnalise =
  | { ok: true; proposta: PropostaGerada; reaproveitada: boolean }
  | { ok: false; erro: string; codigo: string };

/**
 * O que o usuário informou à mão, por anexo.
 *
 * Existe porque documento de verdade é ambíguo o tempo todo: fatura de cartão
 * cita dois meses, nota vem sem CNPJ, cliente novo ainda não está cadastrado.
 * Sem um jeito de completar, a proposta empacava e a conversa não tinha saída.
 *
 * O que vem daqui entra como `confirmado` — foi um humano que disse — e a
 * evidência registra que veio do usuário, não do documento.
 */
export type CorrecaoUsuario = {
  empresaId?: string | null;
  competencia?: string | null;
  tipoDocumento?: string | null;
  instituicao?: string | null;
  regraCodigo?: string | null;
};

export type EntradaAnalise = {
  anexoIds: string[];
  /** Correções informadas pelo usuário, por anexoId. */
  correcoes?: Record<string, CorrecaoUsuario>;
  conversaId?: string | null;
  mensagemId?: string | null;
  /** Empresa já em uso na conversa. Pista fraca, nunca decisão. */
  empresaContextoId?: string | null;
  chaveIdempotencia?: string | null;
};

export type PortasAnalise = {
  /** Devolve SÓ os anexos que pertencem a este usuário. */
  buscarAnexosDoUsuario(ids: string[], usuarioId: string): Promise<AnexoRegistrado[]>;
  conversaPertenceAoUsuario(conversaId: string, usuarioId: string): Promise<boolean>;
  mensagemPertenceAConversa(mensagemId: string, conversaId: string): Promise<boolean>;
  /**
   * Conteúdo atual + hash atual. O hash é RECALCULADO, não lido do registro.
   *
   * `parsed` acompanha o texto porque a assinatura de layout de uma planilha é
   * o conjunto de COLUNAS, que se perde quando as linhas viram texto corrido.
   */
  lerConteudo(anexo: AnexoRegistrado): Promise<{
    texto: string;
    hashAtual: string;
    parsed?: { tipo: "tabular"; colunas: string[] } | { tipo: "texto"; texto: string };
  }>;
  /**
   * O que já foi confirmado antes, para não perguntar de novo.
   *
   * Opcional: sem esta porta o sistema continua funcionando, só volta a
   * perguntar todo mês. É o que permite testar a análise sem banco.
   */
  buscarAprendizado?(chaves: { contas: string[]; layouts: string[] }): Promise<{
    contas: Map<string, { empresaId: string; conta: string; instituicao: string | null }>;
    layouts: Map<string, { tipoDocumento: string; instituicao: string | null; regraCodigo: string | null }>;
  }>;
  /** Só as empresas que este usuário pode enxergar. */
  listarEmpresasVisiveis(usuarioId: string): Promise<EmpresaCandidata[]>;
  listarRegrasAtivas(): Promise<RegraArquivamento[]>;
  nomePastaClientes(empresaAtiva: boolean): Promise<string>;
  nomePastaEmpresa?(container: string, codigo: string): Promise<string>;
  buscarDocumentoPorHash(
    empresaId: string,
    hash: string
  ): Promise<{ id: string; nome: string } | null>;
  propostaPorChaveIdempotencia(chave: string): Promise<PropostaGerada | null>;
  salvarProposta(dados: {
    usuarioId: string;
    conversaId: string | null;
    mensagemId: string | null;
    anexoIds: string[];
    itens: ItemAnalisado[];
    hashes: { anexoId: string; hash: string }[];
    chaveIdempotencia: string | null;
  }): Promise<{ id: string; expiraEm: string }>;
  classificar(pedido: {
    nomeArquivo: string;
    texto: string;
    regrasDisponiveis: { codigo: string; nome: string; escopo: string }[];
  }): Promise<ClassificacaoModelo>;
};

/** Quanto do texto vai ao modelo. Classificar não precisa do arquivo inteiro. */
const CARACTERES_PARA_O_MODELO = 4000;

function vazio(): CampoClassificado {
  return { valor: null, confianca: "ausente" };
}

/**
 * Confere se a regra é compatível com o que foi identificado.
 *
 * Uma regra mensal pedida para um arquivo sem competência não é "quase certa":
 * é incompatível, e o usuário precisa completar antes de confirmar.
 */
function conferirCompatibilidade(
  regra: RegraArquivamento,
  ctx: ContextoArquivamento
): string[] {
  const faltantes: string[] = [];
  if (regra.exige_empresa && !ctx.empresaId) faltantes.push("empresa");
  if (regra.exige_competencia && !ctx.competencia) faltantes.push("competencia");
  if (regra.exige_instituicao && !ctx.instituicao) faltantes.push("instituicao");
  if (!ctx.tipoDocumento) faltantes.push("tipoDocumento");
  return faltantes;
}

/** Analisa UM anexo. Não decide nada sobre os outros do lote. */
async function analisarUm(
  portas: PortasAnalise,
  anexo: AnexoRegistrado,
  empresas: EmpresaCandidata[],
  regras: RegraArquivamento[],
  empresaContextoId: string | null,
  correcao: CorrecaoUsuario = {}
): Promise<{ item: ItemAnalisado; hashAtual: string }> {
  const base: ItemAnalisado = {
    anexoId: anexo.id,
    nomeOriginal: anexo.nome_original,
    hashSha256: anexo.hash_sha256,
    status: "incompleto",
    bloqueio: null,
    empresa: { valor: null, confianca: "ausente", empresaId: null, rotulo: null },
    competencia: vazio(),
    regra: { valor: null, confianca: "ausente", nome: null },
    tipoDocumento: vazio(),
    instituicao: vazio(),
    camposFaltantes: [],
    conflitos: [],
    evidencias: [],
    nomeSugerido: null,
    caminhoSugerido: null,
    possivelDuplicata: null,
    // Preenchidas depois da extração; um item bloqueado antes de ler não tem.
    assinaturas: { conta: null, agencia: null, layout: null },
  };

  // 1. Bloqueio pelo NOME — antes de ler o arquivo.
  const porNome = verificarBloqueio(anexo.nome_original);
  if (porNome.bloqueado) {
    return {
      hashAtual: anexo.hash_sha256,
      item: {
        ...base,
        status: "bloqueado",
        bloqueio: { motivo: porNome.motivo, categoria: porNome.categoria },
      },
    };
  }

  // 2. Extração + hash recalculado. Não confiamos no hash do registro: o
  //    arquivo no Storage pode ter sido substituído desde o upload.
  //
  //    A falha de leitura é tratada AQUI, por item. Antes ela subia e derrubava
  //    `analisarDocumentos` inteiro: um PDF corrompido no meio de um lote de
  //    trinta fazia o usuário perder a análise dos outros vinte e nove e
  //    recomeçar sem saber qual era o culpado. Agora o arquivo ilegível vira um
  //    item bloqueado, com o motivo, e o lote segue.
  let texto: string;
  let hashAtual: string;
  let parsed: { tipo: "tabular"; colunas: string[] } | { tipo: "texto"; texto: string } | undefined;
  try {
    ({ texto, hashAtual, parsed } = await portas.lerConteudo(anexo));
  } catch (e) {
    return {
      hashAtual: anexo.hash_sha256,
      item: {
        ...base,
        status: "bloqueado",
        bloqueio: {
          motivo: e instanceof Error ? e.message : "Não foi possível ler o arquivo.",
          categoria: "ilegivel",
        },
      },
    };
  }

  // 3. Bloqueio pelo CONTEÚDO — antes de qualquer byte ir ao modelo.
  const porConteudo = verificarBloqueio(anexo.nome_original, texto);
  if (porConteudo.bloqueado) {
    return {
      hashAtual,
      item: {
        ...base,
        hashSha256: hashAtual,
        status: "bloqueado",
        bloqueio: { motivo: porConteudo.motivo, categoria: porConteudo.categoria },
      },
    };
  }

  // 4. Tarja o que passou pelo bloqueio mas não deve chegar ao modelo.
  //    Um extrato legítimo traz "SENHA : 50936" (senha de boleto) na coluna de
  //    observações; recusar o documento por isso perdia o arquivo inteiro.
  //    Daqui para baixo, `texto` já está sem os valores.
  const { texto: textoSeguro } = redigirSegredos(texto);
  texto = textoSeguro;

  const evidencias: Evidencia[] = [];
  const conflitos: { campo: string; motivo: string }[] = [];

  // 4a. Assinaturas: a conta do titular e o layout do documento.
  //
  //     A consulta ao aprendizado acontece por item, e não uma vez para o lote,
  //     porque a assinatura só existe DEPOIS de ler o arquivo — e ler acontece
  //     aqui dentro. São duas leituras pequenas por documento, indexadas por
  //     chave primária.
  const assinaturas = assinaturasDoArquivo(
    parsed ?? { tipo: "texto", texto },
    texto
  );
  const aprendizado = portas.buscarAprendizado
    ? await portas.buscarAprendizado({
        contas: assinaturas.conta ? [chaveConta(assinaturas.conta)] : [],
        layouts: assinaturas.layout ? [assinaturas.layout] : [],
      })
    : { contas: new Map(), layouts: new Map() };

  const layoutConhecido = assinaturas.layout
    ? aprendizado.layouts.get(assinaturas.layout) ?? null
    : null;

  // 4. Empresa — só entre as que este usuário enxerga.
  const idEmpresa = identificarEmpresa(
    empresas,
    { texto, nomeArquivo: anexo.nome_original, cnpjs: extrairCnpjs(`${texto} ${anexo.nome_original}`) },
    empresaContextoId
  );

  // 4b. A CONTA BANCÁRIA, quando já foi confirmada por alguém, decide.
  //
  // Casar o código do cliente com o texto funciona mal em extrato: os números
  // "147" e "210" — códigos de dois clientes reais — aparecem como valores no
  // meio dos lançamentos, e o documento é recusado por ambiguidade. Foi o que
  // aconteceu num teste com um extrato de verdade.
  //
  // A conta não tem esse problema: ela identifica o titular. Quando ela já
  // está cadastrada, vale mais que a busca por texto — inclusive para desfazer
  // um conflito que a busca por texto criou.
  const contaConhecida =
    assinaturas.conta && aprendizado.contas.get(chaveConta(assinaturas.conta));
  const empresaDaConta = contaConhecida
    ? empresas.find((e) => e.id === contaConhecida.empresaId) ?? null
    : null;

  let empresaIdentificada = idEmpresa.empresa;
  let confiancaEmpresa = idEmpresa.confianca;

  if (empresaDaConta) {
    const forteEDiferente =
      idEmpresa.confianca === "confirmado" && idEmpresa.empresa?.id !== empresaDaConta.id;

    if (forteEDiferente) {
      // Dois sinais fortes discordando. Escolher um dos dois em silêncio é a
      // pior saída possível: um deles está errado e ninguém vai conferir.
      conflitos.push({
        campo: "empresa",
        motivo:
          `A conta ${contaConhecida.conta} está cadastrada para ` +
          `${empresaDaConta.codigo ?? empresaDaConta.razao_social}, mas o conteúdo aponta ` +
          `${idEmpresa.empresa?.codigo ?? idEmpresa.empresa?.razao_social}. Confirme qual é.`,
      });
      empresaIdentificada = null;
      confiancaEmpresa = "conflitante";
    } else {
      empresaIdentificada = empresaDaConta;
      confiancaEmpresa = "confirmado";
      evidencias.push({
        campo: "empresa",
        valor: empresaDaConta.codigo ?? empresaDaConta.razao_social ?? empresaDaConta.id,
        origem: "conteudo",
        detalhe:
          `Conta ${contaConhecida.conta}` +
          (contaConhecida.instituicao ? ` (${contaConhecida.instituicao})` : "") +
          " já confirmada para esta empresa em arquivamento anterior.",
      });
    }
  } else {
    evidencias.push(...idEmpresa.evidencias);
    for (const c of idEmpresa.conflitos) {
      conflitos.push({ campo: "empresa", motivo: `${c.rotulo}: ${c.motivo}` });
    }
  }

  // 5. Competência.
  const idComp = identificarCompetencia(texto, anexo.nome_original);
  evidencias.push(...idComp.evidencias);
  if (idComp.confianca === "conflitante") {
    conflitos.push({
      campo: "competencia",
      motivo: `Mais de uma competência no documento: ${idComp.evidencias
        .map((e) => e.valor)
        .join(", ")}.`,
    });
  }

  // 6. Classificação pelo modelo. Ele vê só nome, trecho do texto e a lista de
  //    CÓDIGOS de regra ativos — nunca caminho nem id do Drive.
  const classificacao = await portas.classificar({
    nomeArquivo: anexo.nome_original,
    texto: texto.slice(0, CARACTERES_PARA_O_MODELO),
    regrasDisponiveis: regras.map((r) => ({ codigo: r.codigo, nome: r.nome, escopo: r.escopo })),
  });

  // Código fora da lista de regras ativas é alucinação. Não vira destino.
  const regra = regras.find((r) => r.codigo === classificacao.regraCodigo) ?? null;
  if (classificacao.regraCodigo && !regra) {
    conflitos.push({
      campo: "regra",
      motivo: `A regra "${classificacao.regraCodigo}" não existe entre as regras ativas.`,
    });
  }

  // 6b. O que o USUÁRIO informou vence tudo.
  //
  // Documento de verdade é ambíguo o tempo todo — fatura de cartão cita dois
  // meses, nota vem sem CNPJ. Sem isto a proposta empacava e a conversa não
  // tinha saída. Um humano dizendo qual é vale mais que qualquer heurística.
  const registrarInformado = (campo: string, valor: string) => {
    evidencias.push({
      campo,
      valor,
      origem: "contexto",
      detalhe: `Informado pelo usuário na conversa (não foi lido do documento).`,
    });
  };

  const empresaCorrigida = correcao.empresaId
    ? (empresas.find((e) => e.id === correcao.empresaId) ?? null)
    : null;

  // Empresa corrigida que não está na carteira visível é recusada em silêncio:
  // aceitar um id solto seria arquivar em cliente que o usuário nem enxerga.
  const empresaFinal = empresaCorrigida ?? empresaIdentificada;
  if (empresaCorrigida) {
    registrarInformado("empresa", empresaCorrigida.codigo ?? empresaCorrigida.id);
  }

  const competenciaFinal =
    correcao.competencia ?? idComp.competencia ?? classificacao.competencia ?? null;
  if (correcao.competencia) registrarInformado("competencia", correcao.competencia);

  // Ordem: o usuário vence o layout aprendido, e o layout aprendido vence o
  // modelo. O layout só entra no mapa depois que uma pessoa confirmou aquele
  // documento — então ele é uma decisão humana antiga, e vale mais que um
  // palpite novo do classificador.
  const tipoFinal =
    correcao.tipoDocumento ?? layoutConhecido?.tipoDocumento ?? classificacao.tipoDocumento ?? null;
  if (correcao.tipoDocumento) registrarInformado("tipoDocumento", correcao.tipoDocumento);
  else if (layoutConhecido) {
    evidencias.push({
      campo: "tipoDocumento",
      valor: layoutConhecido.tipoDocumento,
      origem: "conteudo",
      detalhe:
        "Documento com o mesmo layout já foi classificado e confirmado antes " +
        "(mesmo conjunto de colunas/cabeçalho).",
    });
  }

  const instituicaoFinal =
    correcao.instituicao ??
    layoutConhecido?.instituicao ??
    classificacao.instituicao ??
    assinaturas.conta?.instituicao ??
    null;
  if (correcao.instituicao) registrarInformado("instituicao", correcao.instituicao);

  const regraCorrigida = correcao.regraCodigo
    ? (regras.find((r) => r.codigo === correcao.regraCodigo) ?? null)
    : null;
  const regraFinal = regraCorrigida ?? regra;
  if (regraCorrigida) registrarInformado("regra", regraCorrigida.codigo);

  // O que o usuário resolveu deixa de ser conflito.
  const conflitosAbertos = conflitos.filter((c) => {
    if (c.campo === "empresa" && empresaCorrigida) return false;
    if (c.campo === "competencia" && correcao.competencia) return false;
    if (c.campo === "regra" && regraCorrigida) return false;
    return true;
  });

  const competencia = competenciaFinal;
  const item: ItemAnalisado = {
    ...base,
    hashSha256: hashAtual,
    // Vai junto para a proposta: é o que a confirmação vai gravar como
    // aprendizado, e sem isto o mês seguinte começaria do zero de novo.
    assinaturas: {
      conta: assinaturas.conta ? chaveConta(assinaturas.conta) : null,
      agencia: assinaturas.conta?.agencia ?? null,
      layout: assinaturas.layout,
    },
    empresa: {
      valor: empresaFinal ? (empresaFinal.codigo ?? empresaFinal.id) : null,
      confianca: empresaCorrigida ? "confirmado" : confiancaEmpresa,
      empresaId: empresaFinal?.id ?? null,
      rotulo: empresaFinal?.nome_fantasia ?? empresaFinal?.razao_social ?? null,
    },
    competencia: {
      valor: competencia,
      confianca: correcao.competencia ? "confirmado" : idComp.confianca,
    },
    regra: {
      valor: regraFinal?.codigo ?? null,
      nome: regraFinal?.nome ?? null,
      confianca: regraCorrigida
        ? "confirmado"
        : regraFinal
          ? "provavel"
          : classificacao.regraCodigo
            ? "conflitante"
            : "ausente",
    },
    tipoDocumento: {
      valor: tipoFinal,
      // Layout já confirmado por uma pessoa vale "confirmado": não é palpite do
      // modelo, é a decisão de alguém sobre este mesmo documento.
      confianca:
        correcao.tipoDocumento || (layoutConhecido && !correcao.tipoDocumento)
          ? "confirmado"
          : tipoFinal
            ? "provavel"
            : "ausente",
    },
    instituicao: {
      valor: instituicaoFinal,
      confianca: correcao.instituicao ? "confirmado" : instituicaoFinal ? "provavel" : "ausente",
    },
    evidencias,
    conflitos: conflitosAbertos,
  };

  if (!regraFinal) {
    item.camposFaltantes = ["regra"];
    return { item, hashAtual };
  }

  // 7. Nome e caminho — calculados AQUI, pelo núcleo puro, nunca pelo modelo.
  const contexto: ContextoArquivamento = {
    empresaId: empresaFinal?.id ?? null,
    empresaCodigo: empresaFinal?.codigo ?? null,
    empresaNome: empresaFinal?.nome_fantasia ?? empresaFinal?.razao_social ?? null,
    competencia,
    instituicao: instituicaoFinal,
    tipoDocumento: tipoFinal,
    dataDocumento: classificacao.dataDocumento ?? null,
    versao: 1,
    extensao: anexo.extensao,
  };

  const faltantes = conferirCompatibilidade(regraFinal, contexto);
  item.camposFaltantes = faltantes;

  // Empresa exigida mas não resolvida: nada de caminho. Não inventamos.
  if (regraFinal.exige_empresa && empresaFinal) {
    contexto.pastaClientes = await portas.nomePastaClientes(empresaFinal.ativo);
    if (regraFinal.caminho_modelo.includes("{COMPETENCIA_PASTA}")) {
      if (!portas.nomePastaEmpresa || !empresaFinal.codigo) {
        item.camposFaltantes.push("pastaEmpresa");
      } else {
        try {
          contexto.pastaEmpresa = await portas.nomePastaEmpresa(contexto.pastaClientes, empresaFinal.codigo);
        } catch (e) {
          item.camposFaltantes.push("pastaEmpresa");
          conflitosAbertos.push({ campo: "empresa", motivo: e instanceof Error ? e.message : "Pasta do cliente não encontrada." });
        }
      }
    }
  }

  if (faltantes.length === 0 && conflitosAbertos.length === 0) {
    const destino = expandirDestino(regraFinal, contexto);
    const nome = montarNomeArquivo(regraFinal, contexto);

    if (destino.ok && nome.ok) {
      item.caminhoSugerido = `${destino.caminhoLogico}/${nome.nome}`;
      item.nomeSugerido = nome.nome;
      item.status = "analisado";
    } else {
      item.camposFaltantes = [
        ...new Set([
          ...(destino.ok ? [] : destino.faltando),
          ...(nome.ok ? [] : nome.faltando),
        ]),
      ];
    }
  }

  // 8. Duplicidade por (empresa, hash). Só faz sentido com empresa resolvida:
  //    o mesmo hash em clientes diferentes não é duplicata.
  if (empresaFinal) {
    const jaExiste = await portas.buscarDocumentoPorHash(empresaFinal.id, hashAtual);
    if (jaExiste) {
      item.possivelDuplicata = {
        documentoId: jaExiste.id,
        nome: jaExiste.nome,
        motivo: "Já existe documento com este conteúdo (mesmo SHA-256) para esta empresa.",
      };
    }
  }

  return { item, hashAtual };
}

/**
 * Analisa um lote de anexos e persiste UMA proposta aguardando confirmação.
 */
export async function analisarDocumentos(
  entrada: EntradaAnalise,
  usuarioId: string,
  portas: PortasAnalise
): Promise<ResultadoAnalise> {
  if (!usuarioId) {
    return { ok: false, codigo: "sem_usuario", erro: "Análise exige usuário autenticado." };
  }
  if (entrada.anexoIds.length === 0) {
    return { ok: false, codigo: "sem_anexos", erro: "Nenhum anexo informado para análise." };
  }

  // Repetir a mesma chave devolve a proposta anterior em vez de criar outra.
  if (entrada.chaveIdempotencia) {
    const anterior = await portas.propostaPorChaveIdempotencia(entrada.chaveIdempotencia);
    if (anterior) return { ok: true, proposta: anterior, reaproveitada: true };
  }

  // Propriedade da conversa e da mensagem, antes de tocar em qualquer arquivo.
  if (entrada.conversaId) {
    const daConversa = await portas.conversaPertenceAoUsuario(entrada.conversaId, usuarioId);
    if (!daConversa) {
      return {
        ok: false,
        codigo: "conversa_de_outro",
        erro: "Esta conversa não pertence ao usuário.",
      };
    }

    if (entrada.mensagemId) {
      const daMensagem = await portas.mensagemPertenceAConversa(
        entrada.mensagemId,
        entrada.conversaId
      );
      if (!daMensagem) {
        return {
          ok: false,
          codigo: "mensagem_de_outra_conversa",
          erro: "A mensagem informada não pertence a esta conversa.",
        };
      }
    }
  }

  // A porta já filtra por dono; aqui conferimos que veio TUDO que foi pedido.
  const anexos = await portas.buscarAnexosDoUsuario(entrada.anexoIds, usuarioId);
  if (anexos.length !== entrada.anexoIds.length) {
    const encontrados = new Set(anexos.map((a) => a.id));
    const faltando = entrada.anexoIds.filter((id) => !encontrados.has(id));
    return {
      ok: false,
      codigo: "anexo_inacessivel",
      erro:
        `Anexo(s) não encontrado(s) ou de outro usuário: ${faltando.join(", ")}. ` +
        "Nenhuma análise foi feita.",
    };
  }

  const [empresas, regras] = await Promise.all([
    portas.listarEmpresasVisiveis(usuarioId),
    portas.listarRegrasAtivas(),
  ]);

  const itens: ItemAnalisado[] = [];
  const hashes: { anexoId: string; hash: string }[] = [];

  for (const anexo of anexos) {
    const { item, hashAtual } = await analisarUm(
      portas,
      anexo,
      empresas,
      regras,
      entrada.empresaContextoId ?? null,
      entrada.correcoes?.[anexo.id] ?? {}
    );
    itens.push(item);
    hashes.push({ anexoId: anexo.id, hash: hashAtual });
  }

  const salva = await portas.salvarProposta({
    usuarioId,
    conversaId: entrada.conversaId ?? null,
    mensagemId: entrada.mensagemId ?? null,
    anexoIds: anexos.map((a) => a.id),
    itens,
    hashes,
    chaveIdempotencia: entrada.chaveIdempotencia ?? null,
  });

  const empresasDistintas = new Set(
    itens.map((i) => i.empresa.empresaId).filter((id): id is string => Boolean(id))
  );

  return {
    ok: true,
    reaproveitada: false,
    proposta: {
      propostaId: salva.id,
      status: "aguardando",
      expiraEm: salva.expiraEm,
      itens,
      resumo: {
        total: itens.length,
        prontos: itens.filter((i) => i.status === "analisado").length,
        incompletos: itens.filter((i) => i.status === "incompleto").length,
        bloqueados: itens.filter((i) => i.status === "bloqueado").length,
        empresasDistintas: empresasDistintas.size,
      },
    },
  };
}

/**
 * Uma proposta só continua válida enquanto os arquivos não mudarem.
 *
 * Usada na confirmação (bloco seguinte), mas mora aqui porque a regra é da
 * análise: o que foi proposto valia para AQUELE conteúdo. Se o arquivo mudou,
 * a proposta descreve outra coisa.
 */
export function propostaAindaValida(
  hashesDaProposta: { anexoId: string; hash: string }[],
  hashesAtuais: { anexoId: string; hash: string }[]
): { valida: true } | { valida: false; motivo: string; anexosAlterados: string[] } {
  const atuais = new Map(hashesAtuais.map((h) => [h.anexoId, h.hash]));
  const alterados: string[] = [];

  for (const { anexoId, hash } of hashesDaProposta) {
    const agora = atuais.get(anexoId);
    if (agora === undefined || agora !== hash) alterados.push(anexoId);
  }

  if (alterados.length === 0) return { valida: true };

  return {
    valida: false,
    anexosAlterados: alterados,
    motivo:
      `${alterados.length} anexo(s) mudaram desde a análise. ` +
      "A proposta descreve outro conteúdo e foi invalidada — refaça a análise.",
  };
}

/** Proposta vencida não pode ser confirmada, mesmo que nada tenha mudado. */
export function propostaExpirada(expiraEm: string, agora: Date = new Date()): boolean {
  return new Date(expiraEm).getTime() <= agora.getTime();
}
