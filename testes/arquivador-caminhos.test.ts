import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  expandirDestino,
  montarNomeArquivo,
  segmentosEstruturais,
  type RegraArquivamento,
} from "../lib/arquivador/caminhos";

/**
 * Testes da expansão de regra -> caminho/nome.
 *
 * As regras abaixo têm a MESMA forma das semeadas em produção (conferidas
 * contra o banco), para o teste não validar uma fantasia.
 */

const EMPRESA_ID = "11111111-2222-3333-4444-555555555555";

const REGRA_INTERNA: RegraArquivamento = {
  id: "r1",
  codigo: "INTERNO_MODELO_CONTRATO",
  nome: "Modelos de contratos",
  escopo: "interno",
  caminho_modelo: ["00_INTERNO", "02_MODELOS_DE_CONTRATOS"],
  padrao_nome: "{TIPO_DOCUMENTO}_{DATA_DOCUMENTO}_v{VERSAO}.{EXTENSAO}",
  exige_empresa: false,
  exige_competencia: false,
  exige_instituicao: false,
  projeto: null,
  subcategoria: null,
};

const REGRA_MENSAL: RegraArquivamento = {
  id: "r2",
  codigo: "CLIENTE_DOCUMENTO",
  nome: "Documento de cliente",
  escopo: "mensal",
  // O tipo do documento vive no NOME, não em subpasta: a pasta da
  // competência é plana de propósito.
  caminho_modelo: ["{ANO}", "{COMPETENCIA}"],
  padrao_nome:
    "{CODIGO}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}",
  exige_empresa: true,
  exige_competencia: true,
  exige_instituicao: false,
  projeto: null,
  subcategoria: null,
};

const REGRA_EXTRATOS: RegraArquivamento = {
  ...REGRA_MENSAL,
  id: "r3",
  codigo: "CLIENTE_DOCUMENTO_COM_INSTITUICAO",
  exige_instituicao: true,
};

const REGRA_PROJETO: RegraArquivamento = {
  id: "r4",
  codigo: "PROJETO_CARTOES_INSUMOS",
  nome: "Conferência de cartões — insumos",
  escopo: "projeto",
  caminho_modelo: ["{PROJETO}", "{ANO}", "{COMPETENCIA}"],
  padrao_nome: "{CODIGO}_{COMPETENCIA}_{PROJETO}_{TIPO_DOCUMENTO}_v{VERSAO}.{EXTENSAO}",
  exige_empresa: true,
  exige_competencia: true,
  exige_instituicao: false,
  projeto: "CONFERENCIA_DE_CARTOES",
  subcategoria: "INSUMOS",
};

const CTX_BASE = {
  empresaId: EMPRESA_ID,
  empresaCodigo: "TL",
  empresaNome: "Transportadora Luvre",
  pastaClientes: "01_CLIENTES_ATIVOS",
  competencia: "2026-09",
  tipoDocumento: "NOTA_FISCAL",
  versao: 1,
  extensao: "pdf",
};

describe("expandirDestino — regra interna", () => {
  test("caminho começa na raiz, sem pasta de empresa", () => {
    const r = expandirDestino(REGRA_INTERNA, {});
    assert.ok(r.ok, r.ok ? "" : r.erro);
    assert.equal(r.caminhoLogico, "00_INTERNO/02_MODELOS_DE_CONTRATOS");
    assert.deepEqual(
      r.segmentos.map((s) => s.nome),
      ["00_INTERNO", "02_MODELOS_DE_CONTRATOS"]
    );
  });

  test("todos os níveis são estruturais e a chave usa o prefixo 'estrutural'", () => {
    const r = expandirDestino(REGRA_INTERNA, {});
    assert.ok(r.ok);
    assert.deepEqual(
      r.segmentos.map((s) => s.escopo),
      ["estrutural", "estrutural"]
    );
    assert.equal(r.chaveLogica, "estrutural:00_INTERNO:02_MODELOS_DE_CONTRATOS");
  });

  test("não exige empresa nem competência", () => {
    const r = expandirDestino(REGRA_INTERNA, {});
    assert.ok(r.ok, "regra interna não deveria exigir nada");
  });
});

describe("expandirDestino — regra mensal", () => {
  test("a pasta da empresa nasce DENTRO do contêiner, nunca na raiz", () => {
    const r = expandirDestino(REGRA_MENSAL, CTX_BASE);
    assert.ok(r.ok, r.ok ? "" : r.erro);
    assert.equal(
      r.caminhoLogico,
      "01_CLIENTES_ATIVOS/TL/2026/2026-09"
    );
    assert.equal(r.segmentos[0].nome, "01_CLIENTES_ATIVOS");
    assert.equal(r.segmentos[1].nome, "TL");
  });

  test("cliente inativo vai para o outro contêiner", () => {
    const r = expandirDestino(REGRA_MENSAL, {
      ...CTX_BASE,
      pastaClientes: "02_CLIENTES_INATIVOS",
    });
    assert.ok(r.ok, r.ok ? "" : r.erro);
    assert.match(r.caminhoLogico, /^02_CLIENTES_INATIVOS\/TL\//);
  });

  test("sem o contêiner, recusa em vez de largar a empresa na raiz", () => {
    const r = expandirDestino(REGRA_MENSAL, { ...CTX_BASE, pastaClientes: null });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.faltando.includes("pastaClientes"));
  });

  test("mudar de ativo para inativo NÃO muda a chave da pasta da empresa", () => {
    const ativo = expandirDestino(REGRA_MENSAL, CTX_BASE);
    const inativo = expandirDestino(REGRA_MENSAL, {
      ...CTX_BASE,
      pastaClientes: "02_CLIENTES_INATIVOS",
    });

    assert.ok(ativo.ok && inativo.ok);
    const chaveEmpresa = (r: typeof ativo) =>
      r.segmentos.find((s) => s.escopo === "empresa")?.chaveLogica;

    assert.equal(chaveEmpresa(ativo), `empresa:${EMPRESA_ID}`);
    assert.equal(
      chaveEmpresa(ativo),
      chaveEmpresa(inativo),
      "a chave da empresa é estável: virar inativo não pode criar uma segunda pasta"
    );
  });

  test("o contêiner tem chave estrutural própria", () => {
    const r = expandirDestino(REGRA_MENSAL, CTX_BASE);
    assert.ok(r.ok);
    assert.equal(r.segmentos[0].chaveLogica, "estrutural:01_CLIENTES_ATIVOS");
    assert.equal(r.segmentos[0].escopo, "estrutural");
  });

  test("a chave lógica identifica a empresa pelo UUID, não pelo nome", () => {
    const r = expandirDestino(REGRA_MENSAL, CTX_BASE);
    assert.ok(r.ok);
    assert.equal(
      r.chaveLogica,
      `empresa:${EMPRESA_ID}:2026:2026-09`
    );
    assert.ok(!r.chaveLogica.includes("TL"), "o nome da empresa não pode entrar na chave");
  });

  test("renomear a empresa NÃO muda a chave lógica", () => {
    const antes = expandirDestino(REGRA_MENSAL, CTX_BASE);
    const depois = expandirDestino(REGRA_MENSAL, {
      ...CTX_BASE,
      empresaCodigo: "TLOG",
      empresaNome: "Transportadora Luvre Logística",
    });

    assert.ok(antes.ok && depois.ok);
    assert.equal(
      antes.chaveLogica,
      depois.chaveLogica,
      "a chave é a identidade estável da pasta — renomear não pode quebrá-la"
    );
    assert.notEqual(antes.caminhoLogico, depois.caminhoLogico, "mas o nome visível muda");
  });

  test("cada nível recebe o escopo certo", () => {
    const r = expandirDestino(REGRA_MENSAL, CTX_BASE);
    assert.ok(r.ok);
    assert.deepEqual(
      r.segmentos.map((s) => s.escopo),
      ["estrutural", "empresa", "periodo", "periodo"]
    );
  });

  test("sem competência, diz exatamente o que falta", () => {
    const r = expandirDestino(REGRA_MENSAL, { ...CTX_BASE, competencia: null });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.faltando.includes("competencia"));
  });

  test("sem empresa, cobra empresaId, código e contêiner", () => {
    const r = expandirDestino(REGRA_MENSAL, { competencia: "2026-09" });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.faltando.includes("empresaId"));
    assert.ok(!r.ok && r.faltando.includes("empresaCodigo"));
    assert.ok(!r.ok && r.faltando.includes("pastaClientes"));
  });

  test("competência fora do formato AAAA-MM é recusada", () => {
    for (const invalida of ["2026-13", "09-2026", "2026/09", "2026-9", "abc"]) {
      const r = expandirDestino(REGRA_MENSAL, { ...CTX_BASE, competencia: invalida });
      assert.equal(r.ok, false, `"${invalida}" deveria ser recusada`);
    }
  });

  test("instituição só é exigida quando a regra pede", () => {
    const semExigir = expandirDestino(REGRA_MENSAL, CTX_BASE);
    assert.ok(semExigir.ok, "a regra base não exige instituição");

    const exigindo = expandirDestino(REGRA_EXTRATOS, CTX_BASE);
    assert.equal(exigindo.ok, false);
    assert.ok(!exigindo.ok && exigindo.faltando.includes("instituicao"));
  });
});

describe("expandirDestino — regra de projeto", () => {
  test("o nível do projeto é marcado como escopo 'projeto'", () => {
    const r = expandirDestino(REGRA_PROJETO, { ...CTX_BASE, tipoDocumento: "EXTRATO" });
    assert.ok(r.ok, r.ok ? "" : r.erro);
    assert.deepEqual(
      r.segmentos.map((s) => `${s.nome}:${s.escopo}`),
      [
        "01_CLIENTES_ATIVOS:estrutural",
        "TL:empresa",
        "CONFERENCIA_DE_CARTOES:projeto",
        "2026:periodo",
        "2026-09:periodo",
      ]
    );
  });
});

describe("expandirDestino — segurança de caminho", () => {
  test("código de empresa malicioso não escapa da árvore", () => {
    const r = expandirDestino(REGRA_MENSAL, {
      ...CTX_BASE,
      empresaCodigo: "../../etc/passwd",
    });
    assert.ok(r.ok, r.ok ? "" : r.erro);
    assert.ok(!r.caminhoLogico.includes(".."), `vazou: ${r.caminhoLogico}`);
    const pastaEmpresa = r.segmentos.find((s) => s.escopo === "empresa");
    assert.equal(pastaEmpresa?.nome.includes("/"), false);
  });

  test("contêiner malicioso também é sanitizado", () => {
    const r = expandirDestino(REGRA_MENSAL, {
      ...CTX_BASE,
      pastaClientes: "../../fora",
    });
    assert.ok(r.ok, r.ok ? "" : r.erro);
    assert.ok(!r.caminhoLogico.includes(".."), `vazou: ${r.caminhoLogico}`);
    assert.ok(!r.segmentos[0].nome.includes("/"));
  });

  test("nenhum segmento contém barra ou caractere de controle", () => {
    const r = expandirDestino(REGRA_MENSAL, {
      ...CTX_BASE,
      empresaCodigo: "A/B\\CD",
    });
    assert.ok(r.ok);
    for (const s of r.segmentos) {
      assert.ok(!/[/\\]/.test(s.nome), `segmento com barra: ${s.nome}`);
      assert.ok(!/[ -]/.test(s.nome), `segmento com controle: ${s.nome}`);
    }
  });
});

describe("montarNomeArquivo", () => {
  test("monta o nome completo quando tudo está presente", () => {
    const r = montarNomeArquivo(REGRA_EXTRATOS, {
      ...CTX_BASE,
      tipoDocumento: "EXTRATO",
      instituicao: "Itau",
      versao: 2,
    });
    assert.ok(r.ok, r.ok ? "" : r.erro);
    assert.equal(r.nome, "TL_2026-09_EXTRATO_ITAU_v2.pdf");
  });

  test("placeholder opcional sem valor some, sem deixar '__' nem '{}'", () => {
    const r = montarNomeArquivo(REGRA_MENSAL, CTX_BASE);
    assert.ok(r.ok, r.ok ? "" : r.erro);
    assert.ok(!r.nome.includes("{"), `sobrou placeholder: ${r.nome}`);
    assert.ok(!r.nome.includes("__"), `sobrou separador duplo: ${r.nome}`);
    assert.equal(r.nome, "TL_2026-09_NOTA_FISCAL_v1.pdf");
  });

  test("versão cai para 1 quando não informada", () => {
    const r = montarNomeArquivo(REGRA_MENSAL, { ...CTX_BASE, versao: null });
    assert.ok(r.ok);
    assert.match(r.nome, /_v1\.pdf$/);
  });

  test("extensão é normalizada para minúscula e sem ponto", () => {
    const r = montarNomeArquivo(REGRA_MENSAL, { ...CTX_BASE, extensao: ".PDF" });
    assert.ok(r.ok);
    assert.match(r.nome, /\.pdf$/);
    assert.ok(!r.nome.includes(".."), `ponto duplicado: ${r.nome}`);
  });

  test("sem extensão, recusa em vez de gerar arquivo sem tipo", () => {
    const r = montarNomeArquivo(REGRA_MENSAL, { ...CTX_BASE, extensao: null });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.faltando.includes("extensao"));
  });

  test("data fora do formato AAAA-MM-DD é recusada", () => {
    const r = montarNomeArquivo(REGRA_INTERNA, {
      tipoDocumento: "MODELO",
      extensao: "docx",
      dataDocumento: "31/12/2026",
    });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.faltando.includes("dataDocumento"));
  });

  test("acento e espaço viram nome seguro", () => {
    const r = montarNomeArquivo(REGRA_MENSAL, {
      ...CTX_BASE,
      empresaNome: "Ação & Serviços Ltda",
      tipoDocumento: "Nota Fiscal",
    });
    assert.ok(r.ok, r.ok ? "" : r.erro);
    assert.ok(!/[áàâãéíóúçÇ&\s]/.test(r.nome), `nome não sanitizado: ${r.nome}`);
  });

  test("regra de projeto usa o nome do projeto da própria regra", () => {
    const r = montarNomeArquivo(REGRA_PROJETO, { ...CTX_BASE, tipoDocumento: "BASE" });
    assert.ok(r.ok, r.ok ? "" : r.erro);
    assert.match(r.nome, /CONFERENCIA_DE_CARTOES/);
  });
});

describe("segmentosEstruturais — estrutura fixa", () => {
  test("gera um nível por segmento, com chave acumulada", () => {
    const s = segmentosEstruturais(["00_INTERNO", "02_MODELOS_DE_CONTRATOS"]);
    assert.deepEqual(
      s.map((x) => x.chaveLogica),
      ["estrutural:00_INTERNO", "estrutural:00_INTERNO:02_MODELOS_DE_CONTRATOS"]
    );
    assert.equal(s[1].caminhoLogico, "00_INTERNO/02_MODELOS_DE_CONTRATOS");
    assert.ok(s.every((x) => x.escopo === "estrutural"));
  });

  /**
   * O bootstrap cria as pastas por `segmentosEstruturais`; o arquivamento
   * reencontra por `expandirDestino`. Se as chaves divergissem, o resolvedor
   * não acharia o mapeamento e criaria uma SEGUNDA pasta com o mesmo nome —
   * exatamente o defeito que o resolvedor existe para evitar.
   */
  test("a chave do bootstrap é idêntica à que a regra interna produz", () => {
    const viaRegra = expandirDestino(REGRA_INTERNA, {});
    const viaEstrutura = segmentosEstruturais(REGRA_INTERNA.caminho_modelo);

    assert.ok(viaRegra.ok);
    assert.deepEqual(
      viaEstrutura.map((s) => s.chaveLogica),
      viaRegra.segmentos.map((s) => s.chaveLogica)
    );
  });

  /**
   * Mesma armadilha do lado do contêiner: o bootstrap cria
   * 01_CLIENTES_ATIVOS, e o arquivamento de um cliente precisa reencontrar
   * essa mesma pasta em vez de criar uma irmã.
   */
  test("a chave do contêiner bate com a que o caminho de empresa produz", () => {
    const viaEstrutura = segmentosEstruturais(["01_CLIENTES_ATIVOS"]);
    const viaRegra = expandirDestino(REGRA_MENSAL, CTX_BASE);

    assert.ok(viaRegra.ok);
    assert.equal(viaEstrutura[0].chaveLogica, viaRegra.segmentos[0].chaveLogica);
  });

  test("segmento vazio é descartado em vez de virar pasta sem nome", () => {
    const s = segmentosEstruturais(["00_INTERNO", "   ", "02_X"]);
    assert.deepEqual(
      s.map((x) => x.nome),
      ["00_INTERNO", "02_X"]
    );
  });
});
