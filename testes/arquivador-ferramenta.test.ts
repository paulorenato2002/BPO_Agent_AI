import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ferramentaAnalisarDocumentos } from "../lib/ferramentas/arquivador";

/**
 * Contrato da ferramenta que o MODELO enxerga. O handler não é exercitado
 * aqui (isso é o teste de análise); o que importa neste arquivo é o que o
 * agente consegue pedir e o que ele lê antes de decidir usar.
 */

const validar = ferramentaAnalisarDocumentos.validarEntrada;

describe("contrato exposto ao modelo", () => {
  test("a descrição diz o que a ferramenta NÃO faz", () => {
    const d = ferramentaAnalisarDocumentos.descricao;
    // Sem isto o agente promete arquivamento e o usuário acha que acabou.
    assert.match(d, /NÃO arquiva/);
    assert.match(d, /confirmar/i);
    assert.match(d, /Drive/);
  });

  test("não exige aprovação: analisar não tem efeito externo", () => {
    assert.equal(ferramentaAnalisarDocumentos.exigeAprovacao, false);
    assert.equal(ferramentaAnalisarDocumentos.modo, "sincrono");
  });

  test("o schema não oferece caminho, pasta nem id do Drive", () => {
    const props = Object.keys(
      (ferramentaAnalisarDocumentos.schemaEntrada.properties ?? {}) as object
    );
    for (const proibido of ["caminho", "pasta", "driveId", "externalId", "destino"]) {
      assert.ok(!props.includes(proibido), `o modelo não pode informar "${proibido}"`);
    }
    assert.deepEqual(props.sort(), [
      "anexoIds",
      "conversaId",
      "empresaContextoId",
      "mensagemId",
    ]);
  });
});

describe("validação de entrada", () => {
  test("aceita lista de anexos", () => {
    const r = validar({ anexoIds: ["a1", "a2"] });
    assert.equal(r.valido, true);
    assert.deepEqual(r.valido && r.dado.anexoIds, ["a1", "a2"]);
  });

  test("aceita anexoId avulso e normaliza para lista", () => {
    // É como o modelo tende a chamar quando há um arquivo só.
    const r = validar({ anexoId: "a1" });
    assert.equal(r.valido, true);
    assert.deepEqual(r.valido && r.dado.anexoIds, ["a1"]);
  });

  test("recusa chamada sem anexo", () => {
    for (const entrada of [{}, { anexoIds: [] }, { anexoIds: [null, 123] }, null]) {
      const r = validar(entrada);
      assert.equal(r.valido, false, `deveria recusar: ${JSON.stringify(entrada)}`);
    }
  });

  test("recusa lote absurdo", () => {
    const r = validar({ anexoIds: Array.from({ length: 21 }, (_, i) => `a${i}`) });
    assert.equal(r.valido, false);
    assert.match(r.valido === false ? r.problemas.join(" ") : "", /Máximo de 20/);
  });

  test("campos opcionais viram null quando ausentes ou inválidos", () => {
    const r = validar({ anexoIds: ["a1"], conversaId: 42, mensagemId: "" });
    assert.equal(r.valido, true);
    if (r.valido) {
      assert.equal(r.dado.conversaId, null);
      assert.equal(r.dado.mensagemId, null);
    }
  });

  test("campo extra inventado pelo modelo é descartado", () => {
    const r = validar({ anexoIds: ["a1"], caminhoSugerido: "/qualquer/coisa" });
    assert.equal(r.valido, true);
    assert.ok(r.valido && !("caminhoSugerido" in r.dado));
  });
});

describe("handler", () => {
  test("sem usuário no contexto, recusa sem tocar em nada", async () => {
    const r = await ferramentaAnalisarDocumentos.handler(
      { anexoIds: ["a1"] },
      { usuarioId: null }
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.codigoErro, "sem_usuario");
  });
});

describe("catálogo", () => {
  test("a ferramenta entra no registro e aparece para o agente", async () => {
    const { registrarFerramentasDeNegocio } = await import("../lib/ferramentas/catalogo");
    const registro = registrarFerramentasDeNegocio();

    assert.ok(registro.obter("analisar_documentos"), "não foi registrada");
    assert.ok(
      registro.listarParaAgente().some((f) => f.codigo === "analisar_documentos"),
      "registrada mas invisível para o agente"
    );
  });

  test("registrar duas vezes não explode", async () => {
    // O Next recarrega módulos em dev, e `registrar` lança em código duplicado.
    const { registrarFerramentasDeNegocio } = await import("../lib/ferramentas/catalogo");
    registrarFerramentasDeNegocio();
    registrarFerramentasDeNegocio();
    assert.equal(
      registrarFerramentasDeNegocio().listar().filter((f) => f.codigo === "analisar_documentos")
        .length,
      1
    );
  });

  test("o formato OpenAI expõe nome, descrição e schema", async () => {
    const { registrarFerramentasDeNegocio } = await import("../lib/ferramentas/catalogo");
    const tools = registrarFerramentasDeNegocio().comoToolsOpenAI();
    const t = tools.find((x) => x.function.name === "analisar_documentos");

    assert.ok(t, "ferramenta ausente do formato OpenAI");
    assert.equal(t.type, "function");
    assert.match(t.function.description, /NÃO arquiva/);
    assert.ok(t.function.parameters);
  });
});

describe("ferramenta arquivar_documentos", () => {
  test("a descrição avisa que 'ok' não é confirmação de itens", async () => {
    const { ferramentaArquivarDocumentos } = await import("../lib/ferramentas/arquivador");
    const d = ferramentaArquivarDocumentos.descricao;
    assert.match(d, /NÃO são confirmação/);
    assert.match(d, /pergunte antes/);
  });

  test("é marcada como risco alto: sobe arquivo para o Drive do cliente", async () => {
    const { ferramentaArquivarDocumentos } = await import("../lib/ferramentas/arquivador");
    assert.equal(ferramentaArquivarDocumentos.nivelRisco, "alto");
    assert.equal(ferramentaArquivarDocumentos.tentativas, 1, "retentativa é decisão humana");
  });

  test("confirmar precisa ser o booleano true — nada de aproximação", async () => {
    const { ferramentaArquivarDocumentos } = await import("../lib/ferramentas/arquivador");
    const v = ferramentaArquivarDocumentos.validarEntrada;

    for (const valor of ["true", 1, "sim", "SIM", {}, null]) {
      const r = v({ propostaId: "p1", confirmar: valor, anexosConfirmados: ["a1"] });
      assert.equal(r.valido, false, `"${JSON.stringify(valor)}" não podia passar como confirmação`);
    }

    assert.equal(
      v({ propostaId: "p1", confirmar: true, anexosConfirmados: ["a1"] }).valido,
      true
    );
  });

  test("recusa sem proposta ou sem anexos confirmados", async () => {
    const { ferramentaArquivarDocumentos } = await import("../lib/ferramentas/arquivador");
    const v = ferramentaArquivarDocumentos.validarEntrada;

    assert.equal(v({ confirmar: true, anexosConfirmados: ["a1"] }).valido, false);
    assert.equal(v({ propostaId: "p1", confirmar: true, anexosConfirmados: [] }).valido, false);
  });

  test("as duas ferramentas ficam no catálogo", async () => {
    const { registrarFerramentasDeNegocio } = await import("../lib/ferramentas/catalogo");
    const codigos = registrarFerramentasDeNegocio().listarParaAgente().map((f) => f.codigo);
    assert.ok(codigos.includes("analisar_documentos"));
    assert.ok(codigos.includes("arquivar_documentos"));
  });
});
