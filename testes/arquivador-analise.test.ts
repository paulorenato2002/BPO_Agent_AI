import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  analisarDocumentos,
  propostaAindaValida,
  propostaExpirada,
  type AnexoRegistrado,
  type PortasAnalise,
  type ClassificacaoModelo,
  type PropostaGerada,
} from "../lib/arquivador/analise";
import type { RegraArquivamento } from "../lib/arquivador/caminhos";
import type { EmpresaCandidata } from "../lib/arquivador/identificar-empresa";

/**
 * Tudo fictício: empresas inventadas, CNPJs com dígito válido que não
 * pertencem a ninguém, e "documentos" que são texto escrito aqui.
 */

const USUARIO = "11111111-1111-1111-1111-111111111111";
const OUTRO_USUARIO = "22222222-2222-2222-2222-222222222222";

const CNPJ_ALFA = "11.222.333/0001-81";
const CNPJ_BETA = "44.555.666/0001-81";

const ALFA: EmpresaCandidata = {
  id: "aaaa1111-0000-0000-0000-000000000001",
  codigo: "ALF",
  razao_social: "Alfa Panificadora Ltda",
  nome_fantasia: "Panificadora Alfa",
  cnpj: CNPJ_ALFA,
  ativo: true,
};

const BETA: EmpresaCandidata = {
  id: "bbbb2222-0000-0000-0000-000000000002",
  codigo: "BET",
  razao_social: "Beta Transportes e Logistica Ltda",
  nome_fantasia: "Beta Log",
  cnpj: CNPJ_BETA,
  ativo: false,
};

const REGRA_NOTAS: RegraArquivamento = {
  id: "r-notas",
  codigo: "MENSAL_NOTAS_FISCAIS",
  nome: "Notas fiscais",
  escopo: "mensal",
  caminho_modelo: ["01_DOCUMENTOS_MENSAIS", "{ANO}", "{COMPETENCIA}", "05_NOTAS_FISCAIS"],
  padrao_nome:
    "{CODIGO}_{EMPRESA}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}",
  exige_empresa: true,
  exige_competencia: true,
  exige_instituicao: false,
  projeto: null,
  subcategoria: null,
};

const REGRA_EXTRATOS: RegraArquivamento = {
  ...REGRA_NOTAS,
  id: "r-extratos",
  codigo: "MENSAL_EXTRATOS_INVESTIMENTOS",
  nome: "Extratos e investimentos",
  caminho_modelo: [
    "01_DOCUMENTOS_MENSAIS",
    "{ANO}",
    "{COMPETENCIA}",
    "03_EXTRATOS_E_INVESTIMENTOS",
  ],
  exige_instituicao: true,
};

const REGRAS = [REGRA_NOTAS, REGRA_EXTRATOS];

function anexo(over: Partial<AnexoRegistrado> = {}): AnexoRegistrado {
  return {
    id: "anexo-1",
    arquivo_id: "arq-1",
    usuario_id: USUARIO,
    conversa_id: "conv-1",
    nome_original: "documento.pdf",
    extensao: "pdf",
    tamanho_bytes: 1000,
    hash_sha256: "a".repeat(64),
    bloqueado: false,
    motivo_bloqueio: null,
    ...over,
  };
}

type Cenario = {
  portas: PortasAnalise;
  salvas: { itens: unknown[]; anexoIds: string[]; chaveIdempotencia: string | null }[];
  vistosPeloModelo: { nomeArquivo: string; texto: string }[];
};

function montar(opcoes: {
  anexos?: AnexoRegistrado[];
  conteudos?: Record<string, string>;
  hashesAtuais?: Record<string, string>;
  empresas?: EmpresaCandidata[];
  classificacao?: (nome: string) => ClassificacaoModelo;
  documentoExistente?: { id: string; nome: string } | null;
  propostaAnterior?: PropostaGerada | null;
  donoDaConversa?: boolean;
  mensagemDaConversa?: boolean;
} = {}): Cenario {
  const {
    anexos = [anexo()],
    conteudos = {},
    hashesAtuais = {},
    empresas = [ALFA, BETA],
    classificacao = () => ({ regraCodigo: "MENSAL_NOTAS_FISCAIS", tipoDocumento: "NOTA_FISCAL" }),
    documentoExistente = null,
    propostaAnterior = null,
    donoDaConversa = true,
    mensagemDaConversa = true,
  } = opcoes;

  const salvas: Cenario["salvas"] = [];
  const vistosPeloModelo: Cenario["vistosPeloModelo"] = [];
  let sequencia = 0;

  const portas: PortasAnalise = {
    async buscarAnexosDoUsuario(ids, usuarioId) {
      return anexos.filter((a) => ids.includes(a.id) && a.usuario_id === usuarioId);
    },
    async conversaPertenceAoUsuario() {
      return donoDaConversa;
    },
    async mensagemPertenceAConversa() {
      return mensagemDaConversa;
    },
    async lerConteudo(a) {
      return {
        texto: conteudos[a.id] ?? "",
        hashAtual: hashesAtuais[a.id] ?? a.hash_sha256,
      };
    },
    async listarEmpresasVisiveis() {
      return empresas;
    },
    async listarRegrasAtivas() {
      return REGRAS;
    },
    async nomePastaClientes(ativa) {
      return ativa ? "01_CLIENTES_ATIVOS" : "02_CLIENTES_INATIVOS";
    },
    async buscarDocumentoPorHash() {
      return documentoExistente;
    },
    async propostaPorChaveIdempotencia() {
      return propostaAnterior;
    },
    async salvarProposta(dados) {
      salvas.push({
        itens: dados.itens,
        anexoIds: dados.anexoIds,
        chaveIdempotencia: dados.chaveIdempotencia,
      });
      return {
        id: `prop-${++sequencia}`,
        expiraEm: new Date(Date.now() + 2 * 3600_000).toISOString(),
      };
    },
    async classificar(pedido) {
      vistosPeloModelo.push({ nomeArquivo: pedido.nomeArquivo, texto: pedido.texto });
      return classificacao(pedido.nomeArquivo);
    },
  };

  return { portas, salvas, vistosPeloModelo };
}

const NOTA_ALFA = `NOTA FISCAL DE SERVICO
Tomador: Panificadora Alfa
CNPJ: ${CNPJ_ALFA}
Competencia: 09/2026
Valor total: 1.234,56`;

const NOTA_BETA = `NOTA FISCAL
Cliente CNPJ ${CNPJ_BETA}
Referente a 09/2026`;

describe("análise — caminho feliz", () => {
  test("gera proposta com nome e caminho sugeridos", async () => {
    const c = montar({ conteudos: { "anexo-1": NOTA_ALFA } });
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.ok(r.ok, r.ok ? "" : r.erro);
    const item = r.proposta.itens[0];

    assert.equal(item.status, "analisado");
    assert.equal(item.empresa.confianca, "confirmado");
    assert.equal(item.empresa.empresaId, ALFA.id);
    assert.equal(item.competencia.valor, "2026-09");
    assert.equal(item.regra.valor, "MENSAL_NOTAS_FISCAIS");
    assert.equal(
      item.caminhoSugerido,
      "01_CLIENTES_ATIVOS/ALF/01_DOCUMENTOS_MENSAIS/2026/2026-09/05_NOTAS_FISCAIS/" +
        "ALF_PANIFICADORA_ALFA_2026-09_NOTA_FISCAL_v1.pdf"
    );
  });

  test("a proposta nasce aguardando confirmação, nunca arquivada", async () => {
    const c = montar({ conteudos: { "anexo-1": NOTA_ALFA } });
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    assert.equal(r.proposta.status, "aguardando");
    assert.ok(r.proposta.expiraEm, "proposta sem expiração nunca envelhece");
  });

  test("cliente inativo cai no contêiner de inativos", async () => {
    const c = montar({ conteudos: { "anexo-1": NOTA_BETA } });
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    assert.match(r.proposta.itens[0].caminhoSugerido ?? "", /^02_CLIENTES_INATIVOS\/BET\//);
  });

  test("evidências são concretas, não 'achei a empresa'", async () => {
    const c = montar({ conteudos: { "anexo-1": NOTA_ALFA } });
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    const evidencias = r.proposta.itens[0].evidencias;
    assert.ok(evidencias.length >= 2, "empresa e competência precisam de evidência");
    assert.ok(evidencias.some((e) => /CNPJ/.test(e.detalhe)));
    for (const e of evidencias) {
      assert.ok(e.origem && e.detalhe.length > 0, `evidência vazia: ${JSON.stringify(e)}`);
    }
  });
});

describe("empresa", () => {
  test("empresa ausente deixa o item incompleto, sem caminho", async () => {
    const c = montar({ conteudos: { "anexo-1": "relatorio sem identificacao" } });
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    const item = r.proposta.itens[0];
    assert.equal(item.status, "incompleto");
    assert.equal(item.empresa.empresaId, null);
    assert.equal(item.caminhoSugerido, null, "sem empresa não se inventa caminho");
    assert.ok(item.camposFaltantes.includes("empresa"));
  });

  test("empresa conflitante não escolhe nenhuma", async () => {
    const c = montar({
      conteudos: { "anexo-1": `Transferencia de ${CNPJ_ALFA} para ${CNPJ_BETA}` },
    });
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    const item = r.proposta.itens[0];
    assert.equal(item.empresa.confianca, "conflitante");
    assert.equal(item.empresa.empresaId, null);
    assert.equal(item.caminhoSugerido, null);
    assert.ok(item.conflitos.some((x) => x.campo === "empresa"));
  });

  test("dois arquivos de empresas diferentes no mesmo lote", async () => {
    const c = montar({
      anexos: [anexo({ id: "a1", nome_original: "n1.pdf" }), anexo({ id: "a2", nome_original: "n2.pdf" })],
      conteudos: { a1: NOTA_ALFA, a2: NOTA_BETA },
    });
    const r = await analisarDocumentos({ anexoIds: ["a1", "a2"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    assert.equal(r.proposta.itens[0].empresa.empresaId, ALFA.id);
    assert.equal(r.proposta.itens[1].empresa.empresaId, BETA.id);
    assert.equal(r.proposta.resumo.empresasDistintas, 2, "o lote não é homogêneo");
  });

  test("só empresas visíveis ao usuário entram na busca", async () => {
    // A Alfa não está na carteira deste usuário; o CNPJ dela não pode resolver.
    const c = montar({ conteudos: { "anexo-1": NOTA_ALFA }, empresas: [BETA] });
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    assert.equal(r.proposta.itens[0].empresa.empresaId, null);
  });
});

describe("competência e regra", () => {
  test("competência ausente deixa a regra mensal incompleta", async () => {
    const c = montar({ conteudos: { "anexo-1": `Nota da Panificadora Alfa CNPJ ${CNPJ_ALFA}` } });
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    const item = r.proposta.itens[0];
    assert.ok(item.camposFaltantes.includes("competencia"));
    assert.equal(item.caminhoSugerido, null);
  });

  test("regra inexistente é tratada como alucinação, não como destino", async () => {
    const c = montar({
      conteudos: { "anexo-1": NOTA_ALFA },
      classificacao: () => ({ regraCodigo: "REGRA_QUE_NAO_EXISTE", tipoDocumento: "X" }),
    });
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    const item = r.proposta.itens[0];
    assert.equal(item.regra.confianca, "conflitante");
    assert.equal(item.caminhoSugerido, null);
    assert.ok(item.conflitos.some((x) => /não existe entre as regras ativas/.test(x.motivo)));
  });

  test("o modelo recebe apenas códigos de regra — nunca caminho ou id do Drive", async () => {
    const c = montar({ conteudos: { "anexo-1": NOTA_ALFA } });
    let recebido: { regrasDisponiveis: unknown } | null = null;
    const original = c.portas.classificar;
    c.portas.classificar = async (pedido) => {
      recebido = pedido;
      return original(pedido);
    };

    await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    const texto = JSON.stringify(recebido);
    assert.ok(!/01_CLIENTES_ATIVOS/.test(texto), "o modelo não pode ver caminho");
    assert.ok(!/external_id|driveId/i.test(texto), "o modelo não pode ver id do Drive");
    assert.match(texto, /MENSAL_NOTAS_FISCAIS/, "mas precisa ver os códigos de regra");
  });

  test("instituição opcional ausente não impede o caminho, e some do nome", async () => {
    const c = montar({ conteudos: { "anexo-1": NOTA_ALFA } });
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    const nome = r.proposta.itens[0].nomeSugerido ?? "";
    assert.equal(r.proposta.itens[0].status, "analisado");
    assert.ok(!nome.includes("{INSTITUICAO}"), `sobrou placeholder: ${nome}`);
    assert.ok(!nome.includes("__"), `sobrou separador duplo: ${nome}`);
  });

  test("instituição obrigatória ausente é cobrada", async () => {
    const c = montar({
      conteudos: { "anexo-1": NOTA_ALFA },
      classificacao: () => ({
        regraCodigo: "MENSAL_EXTRATOS_INVESTIMENTOS",
        tipoDocumento: "EXTRATO",
      }),
    });
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    assert.ok(r.proposta.itens[0].camposFaltantes.includes("instituicao"));
    assert.equal(r.proposta.itens[0].caminhoSugerido, null);
  });
});

describe("bloqueios", () => {
  test(".pfx é bloqueado sem o conteúdo ser lido", async () => {
    const c = montar({ anexos: [anexo({ nome_original: "CERT_A1.pfx", extensao: "pfx" })] });
    let leu = false;
    c.portas.lerConteudo = async () => {
      leu = true;
      return { texto: "", hashAtual: "a".repeat(64) };
    };

    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    assert.equal(r.proposta.itens[0].status, "bloqueado");
    assert.equal(leu, false, "o conteúdo não podia nem ser lido");
    assert.equal(c.vistosPeloModelo.length, 0, "nada podia ir ao modelo");
  });

  test("segredo no conteúdo bloqueia ANTES de o modelo ver", async () => {
    const c = montar({
      anexos: [anexo({ nome_original: "acessos.txt", extensao: "txt" })],
      conteudos: { "anexo-1": "portal do cliente\nsenha: fake-123" },
    });
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    assert.equal(r.proposta.itens[0].status, "bloqueado");
    assert.equal(c.vistosPeloModelo.length, 0, "o texto com segredo chegou ao modelo");
  });

  test("um arquivo bloqueado não derruba o lote inteiro", async () => {
    const c = montar({
      anexos: [
        anexo({ id: "a1", nome_original: "chave.pem", extensao: "pem" }),
        anexo({ id: "a2", nome_original: "nota.pdf" }),
      ],
      conteudos: { a2: NOTA_ALFA },
    });
    const r = await analisarDocumentos({ anexoIds: ["a1", "a2"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    assert.equal(r.proposta.resumo.bloqueados, 1);
    assert.equal(r.proposta.resumo.prontos, 1);
  });
});

describe("propriedade e acesso", () => {
  test("anexo de outro usuário é recusado, sem analisar nada", async () => {
    const c = montar({ anexos: [anexo({ usuario_id: OUTRO_USUARIO })] });
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.codigo, "anexo_inacessivel");
    assert.equal(c.salvas.length, 0, "não podia gravar proposta");
  });

  test("lote com um anexo alheio é recusado INTEIRO", async () => {
    const c = montar({
      anexos: [anexo({ id: "a1" }), anexo({ id: "a2", usuario_id: OUTRO_USUARIO })],
      conteudos: { a1: NOTA_ALFA },
    });
    const r = await analisarDocumentos({ anexoIds: ["a1", "a2"] }, USUARIO, c.portas);

    assert.equal(r.ok, false, "analisar só a parte permitida esconderia o problema");
    assert.equal(c.vistosPeloModelo.length, 0);
  });

  test("conversa de outro usuário é recusada antes de tocar em arquivo", async () => {
    const c = montar({ donoDaConversa: false });
    const r = await analisarDocumentos(
      { anexoIds: ["anexo-1"], conversaId: "conv-alheia" },
      USUARIO,
      c.portas
    );

    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.codigo, "conversa_de_outro");
    assert.equal(c.vistosPeloModelo.length, 0);
  });

  test("mensagem de outra conversa é recusada", async () => {
    const c = montar({ mensagemDaConversa: false });
    const r = await analisarDocumentos(
      { anexoIds: ["anexo-1"], conversaId: "conv-1", mensagemId: "msg-alheia" },
      USUARIO,
      c.portas
    );

    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.codigo, "mensagem_de_outra_conversa");
  });

  test("sem usuário não analisa", async () => {
    const c = montar();
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, "", c.portas);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.codigo, "sem_usuario");
  });
});

describe("duplicidade", () => {
  test("mesmo hash na mesma empresa vira aviso, não bloqueio", async () => {
    const c = montar({
      conteudos: { "anexo-1": NOTA_ALFA },
      documentoExistente: { id: "doc-antigo", nome: "ALF_2026-09_NOTA_FISCAL_v1.pdf" },
    });
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    const dup = r.proposta.itens[0].possivelDuplicata;
    assert.ok(dup, "duplicata não foi detectada");
    assert.equal(dup.documentoId, "doc-antigo");
    assert.equal(r.proposta.itens[0].status, "analisado", "é aviso, quem decide é o humano");
  });

  test("sem empresa resolvida não há checagem de duplicidade", async () => {
    const c = montar({
      conteudos: { "anexo-1": "sem identificacao" },
      documentoExistente: { id: "doc-x", nome: "x.pdf" },
    });
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    assert.equal(r.proposta.itens[0].possivelDuplicata, null,
      "mesmo hash em clientes diferentes não é duplicata");
  });
});

describe("idempotência", () => {
  test("mesma chave devolve a proposta anterior sem reanalisar", async () => {
    const anterior: PropostaGerada = {
      propostaId: "prop-antiga",
      status: "aguardando",
      expiraEm: new Date(Date.now() + 3600_000).toISOString(),
      itens: [],
      resumo: { total: 0, prontos: 0, incompletos: 0, bloqueados: 0, empresasDistintas: 0 },
    };
    const c = montar({ conteudos: { "anexo-1": NOTA_ALFA }, propostaAnterior: anterior });

    const r = await analisarDocumentos(
      { anexoIds: ["anexo-1"], chaveIdempotencia: "chave-1" },
      USUARIO,
      c.portas
    );

    assert.ok(r.ok);
    assert.equal(r.reaproveitada, true);
    assert.equal(r.proposta.propostaId, "prop-antiga");
    assert.equal(c.salvas.length, 0, "não podia criar segunda proposta");
    assert.equal(c.vistosPeloModelo.length, 0, "nem chamar o modelo de novo");
  });

  test("sem chave, cada chamada cria uma proposta", async () => {
    const c = montar({ conteudos: { "anexo-1": NOTA_ALFA } });
    await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);
    await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);
    assert.equal(c.salvas.length, 2);
  });
});

describe("hash e validade da proposta", () => {
  test("o hash é RECALCULADO, não copiado do registro", async () => {
    const c = montar({
      conteudos: { "anexo-1": NOTA_ALFA },
      hashesAtuais: { "anexo-1": "b".repeat(64) },
    });
    const r = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);

    assert.ok(r.ok);
    assert.equal(r.proposta.itens[0].hashSha256, "b".repeat(64),
      "usou o hash antigo do registro em vez do conteúdo atual");
  });

  test("arquivo alterado invalida a proposta", () => {
    const daProposta = [{ anexoId: "a1", hash: "a".repeat(64) }];
    const agora = [{ anexoId: "a1", hash: "b".repeat(64) }];

    const r = propostaAindaValida(daProposta, agora);
    assert.equal(r.valida, false);
    assert.deepEqual(r.valida === false ? r.anexosAlterados : [], ["a1"]);
    assert.match(r.valida === false ? r.motivo : "", /mudaram desde a análise/);
  });

  test("anexo sumido também invalida", () => {
    const r = propostaAindaValida([{ anexoId: "a1", hash: "a".repeat(64) }], []);
    assert.equal(r.valida, false);
  });

  test("nada mudou, proposta continua válida", () => {
    const hashes = [{ anexoId: "a1", hash: "a".repeat(64) }];
    assert.equal(propostaAindaValida(hashes, hashes).valida, true);
  });

  test("proposta vencida é detectada", () => {
    const ontem = new Date(Date.now() - 3600_000).toISOString();
    const amanha = new Date(Date.now() + 3600_000).toISOString();
    assert.equal(propostaExpirada(ontem), true);
    assert.equal(propostaExpirada(amanha), false);
  });
});

describe("correções do usuário", () => {
  test("competência informada resolve o conflito e libera o caminho", async () => {
    // Caso real: fatura de cartão cita dois meses. A análise trava, o usuário
    // diz qual é, e a proposta precisa sair.
    const c = montar({
      conteudos: { "anexo-1": `Fatura ${CNPJ_ALFA}\nPeriodo de 07/2026 a 08/2026` },
    });

    const semCorrecao = await analisarDocumentos({ anexoIds: ["anexo-1"] }, USUARIO, c.portas);
    assert.ok(semCorrecao.ok);
    assert.equal(semCorrecao.proposta.itens[0].competencia.confianca, "conflitante");
    assert.equal(semCorrecao.proposta.itens[0].caminhoSugerido, null);

    const comCorrecao = await analisarDocumentos(
      { anexoIds: ["anexo-1"], correcoes: { "anexo-1": { competencia: "2026-08" } } },
      USUARIO,
      c.portas
    );

    assert.ok(comCorrecao.ok);
    const item = comCorrecao.proposta.itens[0];
    assert.equal(item.competencia.valor, "2026-08");
    assert.equal(item.competencia.confianca, "confirmado");
    assert.equal(item.conflitos.length, 0, "o conflito resolvido não pode continuar aberto");
    assert.match(item.caminhoSugerido ?? "", /2026-08/);
    assert.equal(item.status, "analisado");
  });

  test("empresa informada vence a ausência de sinal no documento", async () => {
    const c = montar({ conteudos: { "anexo-1": "documento sem identificacao\n09/2026" } });

    const r = await analisarDocumentos(
      { anexoIds: ["anexo-1"], correcoes: { "anexo-1": { empresaId: ALFA.id } } },
      USUARIO,
      c.portas
    );

    assert.ok(r.ok);
    const item = r.proposta.itens[0];
    assert.equal(item.empresa.empresaId, ALFA.id);
    assert.equal(item.empresa.confianca, "confirmado");
  });

  test("empresa fora da carteira visível NÃO é aceita", async () => {
    // Aceitar um id solto seria arquivar em cliente que o usuário nem enxerga.
    const c = montar({ conteudos: { "anexo-1": "sem identificacao" }, empresas: [BETA] });

    const r = await analisarDocumentos(
      { anexoIds: ["anexo-1"], correcoes: { "anexo-1": { empresaId: ALFA.id } } },
      USUARIO,
      c.portas
    );

    assert.ok(r.ok);
    assert.equal(r.proposta.itens[0].empresa.empresaId, null);
  });

  test("a evidência deixa claro que veio do usuário, não do documento", async () => {
    const c = montar({ conteudos: { "anexo-1": "sem identificacao" } });

    const r = await analisarDocumentos(
      { anexoIds: ["anexo-1"], correcoes: { "anexo-1": { competencia: "2026-08" } } },
      USUARIO,
      c.portas
    );

    assert.ok(r.ok);
    const evidencia = r.proposta.itens[0].evidencias.find((e) => e.campo === "competencia");
    assert.ok(evidencia, "correção sem evidência não é auditável");
    assert.equal(evidencia.origem, "contexto");
    assert.match(evidencia.detalhe, /Informado pelo usuário/);
  });

  test("correção só afeta o anexo indicado", async () => {
    const c = montar({
      anexos: [anexo({ id: "a1", nome_original: "n1.pdf" }), anexo({ id: "a2", nome_original: "n2.pdf" })],
      conteudos: { a1: NOTA_ALFA, a2: `CNPJ ${CNPJ_ALFA} sem data` },
    });

    const r = await analisarDocumentos(
      { anexoIds: ["a1", "a2"], correcoes: { a2: { competencia: "2026-01" } } },
      USUARIO,
      c.portas
    );

    assert.ok(r.ok);
    assert.equal(r.proposta.itens[0].competencia.valor, "2026-09", "a1 não podia ser afetado");
    assert.equal(r.proposta.itens[1].competencia.valor, "2026-01");
  });
});
