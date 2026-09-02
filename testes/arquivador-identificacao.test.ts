import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  identificarEmpresa,
  identificarCompetencia,
  extrairCnpjs,
  cnpjValido,
  type EmpresaCandidata,
} from "../lib/arquivador/identificar-empresa";

/**
 * Empresas e documentos totalmente FICTÍCIOS. Nenhum cliente real, nenhum
 * CNPJ real — os CNPJs abaixo têm dígitos verificadores válidos mas não
 * pertencem a ninguém.
 */

const CNPJ_ALFA = "11.222.333/0001-81";
const CNPJ_BETA = "44.555.666/0001-81";
const CNPJ_GAMA = "77.888.999/0001-81";

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
  ativo: true,
};

const GAMA: EmpresaCandidata = {
  id: "cccc3333-0000-0000-0000-000000000003",
  codigo: "GAM",
  razao_social: "Gama Comercio de Alimentos Ltda",
  nome_fantasia: "Gama Alimentos",
  cnpj: CNPJ_GAMA,
  ativo: false,
};

const CARTEIRA = [ALFA, BETA, GAMA];

const sinais = (texto: string, nomeArquivo = "arquivo.pdf") => ({
  texto,
  nomeArquivo,
  cnpjs: extrairCnpjs(texto + " " + nomeArquivo),
});

describe("CNPJ", () => {
  test("aceita CNPJ com dígitos válidos", () => {
    assert.equal(cnpjValido(CNPJ_ALFA), true);
    assert.equal(cnpjValido("11222333000181"), true);
  });

  test("recusa dígitos verificadores errados", () => {
    assert.equal(cnpjValido("11.222.333/0001-99"), false);
  });

  test("recusa número que só PARECE CNPJ", () => {
    // Sem a validação, isto viraria "CNPJ encontrado" e apontaria empresa errada.
    assert.equal(cnpjValido("12345678901234"), false);
    assert.equal(cnpjValido("11111111111111"), false);
  });

  test("extrai apenas os válidos de um texto com vários números", () => {
    const texto = `Nosso numero 12345678901234
      Codigo de barras 00190500954014481606906809350314337370000000100
      CNPJ ${CNPJ_ALFA}`;
    assert.deepEqual(extrairCnpjs(texto), ["11222333000181"]);
  });

  test("acha CNPJ formatado e cru como o mesmo valor", () => {
    assert.deepEqual(extrairCnpjs(`${CNPJ_ALFA} e 11222333000181`), ["11222333000181"]);
  });

  test("underscore ao redor não esconde o CNPJ", () => {
    // `\b` não casa entre "_" e dígito (ambos são caractere de palavra), então
    // nomes como ALF_11222333000181_NOTAS passavam batido.
    assert.deepEqual(extrairCnpjs("ALF_11222333000181_NOTAS.xlsx"), ["11222333000181"]);
  });
});

describe("empresa identificada", () => {
  test("CNPJ no conteúdo confirma, com evidência concreta", () => {
    const r = identificarEmpresa(CARTEIRA, sinais(`NOTA FISCAL\nCNPJ: ${CNPJ_BETA}`));

    assert.equal(r.confianca, "confirmado");
    assert.equal(r.empresa?.id, BETA.id);
    assert.equal(r.evidencias.length, 1);
    assert.match(r.evidencias[0].detalhe, /CNPJ .* encontrado no conteúdo/);
    assert.equal(r.evidencias[0].origem, "conteudo");
  });

  test("código no nome do arquivo confirma", () => {
    const r = identificarEmpresa(CARTEIRA, sinais("conteudo neutro", "ALF_2026-09_NOTAS.xlsx"));

    assert.equal(r.confianca, "confirmado");
    assert.equal(r.empresa?.id, ALFA.id);
    assert.equal(r.evidencias[0].origem, "nome_arquivo");
  });

  test("código NÃO casa no meio de outra palavra", () => {
    // "BET" dentro de "BETONEIRA" não pode identificar a Beta.
    const r = identificarEmpresa(CARTEIRA, sinais("compra de BETONEIRA e ALFAJOR"));
    assert.equal(r.confianca, "ausente", `casou indevidamente: ${JSON.stringify(r.evidencias)}`);
  });

  test("razão social reconhecida dá 'provavel', não 'confirmado'", () => {
    const r = identificarEmpresa(CARTEIRA, sinais("Recibo emitido para Beta Transportes Logistica"));

    assert.equal(r.confianca, "provavel");
    assert.equal(r.empresa?.id, BETA.id);
    assert.match(r.evidencias[0].detalhe, /Nome .* reconhecido/);
  });

  test("CNPJ vence semelhança de nome", () => {
    // O texto cita o nome da Alfa, mas o CNPJ é o da Beta.
    const r = identificarEmpresa(
      CARTEIRA,
      sinais(`Fornecedor: Panificadora Alfa\nCliente CNPJ ${CNPJ_BETA}`)
    );

    assert.equal(r.confianca, "confirmado");
    assert.equal(r.empresa?.id, BETA.id, "o CNPJ é o sinal forte");
  });

  test("empresa inativa também é identificável", () => {
    const r = identificarEmpresa(CARTEIRA, sinais(`CNPJ ${CNPJ_GAMA}`));
    assert.equal(r.confianca, "confirmado");
    assert.equal(r.empresa?.id, GAMA.id);
    assert.equal(r.empresa?.ativo, false, "quem escolhe o contêiner é o chamador");
  });
});

describe("empresa ausente", () => {
  test("texto sem sinal nenhum devolve 'ausente' e empresa nula", () => {
    const r = identificarEmpresa(CARTEIRA, sinais("Relatorio generico sem identificacao"));

    assert.equal(r.confianca, "ausente");
    assert.equal(r.empresa, null);
    assert.equal(r.evidencias.length, 0);
  });

  test("CNPJ de empresa fora da carteira NÃO inventa empresa", () => {
    const forasteiro = "22.333.444/0001-" + "00";
    const r = identificarEmpresa(CARTEIRA, sinais(`CNPJ ${forasteiro}`));

    assert.equal(r.confianca, "ausente");
    assert.equal(r.empresa, null);
  });

  test("carteira vazia devolve ausente, não erro", () => {
    const r = identificarEmpresa([], sinais(`CNPJ ${CNPJ_ALFA}`));
    assert.equal(r.confianca, "ausente");
    assert.equal(r.empresa, null);
  });
});

describe("empresa conflitante", () => {
  test("dois CNPJs da carteira no mesmo arquivo NÃO escolhem nenhum", () => {
    const r = identificarEmpresa(CARTEIRA, sinais(`De ${CNPJ_ALFA} para ${CNPJ_BETA}`));

    assert.equal(r.confianca, "conflitante");
    assert.equal(r.empresa, null, "escolher aqui arquivaria no cliente errado");
    assert.equal(r.conflitos.length, 2);
    assert.deepEqual(
      r.conflitos.map((c) => c.rotulo).sort(),
      ["ALF", "BET"]
    );
  });

  test("dois nomes reconhecidos também dão conflito", () => {
    const r = identificarEmpresa(
      CARTEIRA,
      sinais("Consolidado: Panificadora Alfa e Beta Transportes Logistica")
    );
    assert.equal(r.confianca, "conflitante");
    assert.equal(r.empresa, null);
  });

  test("cada conflito vem com o motivo, não só o id", () => {
    const r = identificarEmpresa(CARTEIRA, sinais(`${CNPJ_ALFA} / ${CNPJ_BETA}`));
    for (const c of r.conflitos) {
      assert.ok(c.motivo.length > 0, "conflito sem motivo não é conferível");
      assert.ok(c.empresaId.length > 0);
    }
  });
});

describe("contexto da conversa", () => {
  test("contexto sozinho é apenas 'provavel'", () => {
    const r = identificarEmpresa(CARTEIRA, sinais("documento sem identificacao"), ALFA.id);

    assert.equal(r.confianca, "provavel");
    assert.equal(r.empresa?.id, ALFA.id);
    assert.equal(r.evidencias[0].origem, "contexto");
  });

  test("conteúdo apontando OUTRA empresa vence o contexto", () => {
    const r = identificarEmpresa(CARTEIRA, sinais(`CNPJ ${CNPJ_BETA}`), ALFA.id);

    assert.equal(r.confianca, "confirmado");
    assert.equal(r.empresa?.id, BETA.id, "o documento manda mais que a lembrança do chat");
  });
});

describe("lote com empresas diferentes", () => {
  test("cada arquivo é identificado por si — o lote não é assumido homogêneo", () => {
    const lote = [
      { nome: "a.pdf", texto: `CNPJ ${CNPJ_ALFA}` },
      { nome: "b.pdf", texto: `CNPJ ${CNPJ_BETA}` },
      { nome: "c.pdf", texto: "sem identificacao" },
    ];

    const resultados = lote.map((f) => identificarEmpresa(CARTEIRA, sinais(f.texto, f.nome)));

    assert.equal(resultados[0].empresa?.id, ALFA.id);
    assert.equal(resultados[1].empresa?.id, BETA.id);
    assert.equal(resultados[2].confianca, "ausente");

    const distintas = new Set(resultados.map((r) => r.empresa?.id).filter(Boolean));
    assert.equal(distintas.size, 2, "o lote tem duas empresas e isso precisa aparecer");
  });
});

describe("competência", () => {
  test("AAAA-MM no nome do arquivo confirma", () => {
    const r = identificarCompetencia("conteudo", "ALF_2026-09_NOTAS.xlsx");
    assert.equal(r.confianca, "confirmado");
    assert.equal(r.competencia, "2026-09");
  });

  test("MM/AAAA no conteúdo dá 'provavel'", () => {
    const r = identificarCompetencia("Referente a 09/2026", "arquivo.pdf");
    assert.equal(r.confianca, "provavel");
    assert.equal(r.competencia, "2026-09");
  });

  test("mês por extenso é reconhecido", () => {
    const r = identificarCompetencia("Competencia SETEMBRO 2026", "x.pdf");
    assert.equal(r.competencia, "2026-09");
  });

  test("sem data nenhuma devolve 'ausente'", () => {
    const r = identificarCompetencia("relatorio sem data", "arquivo.pdf");
    assert.equal(r.confianca, "ausente");
    assert.equal(r.competencia, null);
  });

  test("duas competências diferentes é conflito, não a primeira", () => {
    const r = identificarCompetencia("Periodo de 08/2026 ate 09/2026", "x.pdf");
    assert.equal(r.confianca, "conflitante");
    assert.equal(r.competencia, null, "chutar a primeira arquivaria no mês errado");
    assert.equal(r.evidencias.length, 2);
  });

  test("mês inválido não vira competência", () => {
    const r = identificarCompetencia("codigo 2026-13 e 2026-00", "x.pdf");
    assert.equal(r.confianca, "ausente");
  });
});
