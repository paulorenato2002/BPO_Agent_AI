import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  inspecionarArquivo,
  ehFalhaInspecao,
  sanitizarNomeArquivo,
  calcularHashSha256,
  extrairExtensao,
  TAMANHO_MAXIMO_BYTES,
} from "../lib/documentos/inspecao";

import {
  gerarNomePadronizado,
  gerarCaminhoPasta,
  gerarCaminhoCompleto,
  formatarCompetencia,
  normalizarSegmento,
} from "../lib/documentos/nomenclatura";

describe("inspeção de arquivo", () => {
  test("extrai metadados e calcula o hash correto", () => {
    const conteudo = Buffer.from("col1,col2\n1,2\n");
    const r = inspecionarArquivo("relatorio.csv", conteudo, "text/csv");

    assert.ok(!ehFalhaInspecao(r));
    assert.equal(r.extensao, "csv");
    assert.equal(r.mimeType, "text/csv");
    assert.equal(r.tamanhoBytes, conteudo.length);
    assert.equal(r.nomeOriginal, "relatorio.csv");
    assert.equal(
      r.hashSha256,
      createHash("sha256").update(conteudo).digest("hex"),
      "hash precisa bater com o SHA-256 real do conteúdo"
    );
  });

  test("o mesmo conteúdo sempre gera o mesmo hash (base da deduplicação)", () => {
    const a = calcularHashSha256(Buffer.from("conteudo identico"));
    const b = calcularHashSha256(Buffer.from("conteudo identico"));
    const c = calcularHashSha256(Buffer.from("conteudo diferente"));
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[0-9a-f]{64}$/, "formato aceito pelo CHECK do banco");
  });

  test("rejeita extensão não permitida", () => {
    const r = inspecionarArquivo("script.exe", Buffer.from("MZ"), "application/octet-stream");
    assert.ok(ehFalhaInspecao(r));
    assert.equal(r.codigo, "extensao_nao_permitida");
  });

  test("rejeita arquivo vazio", () => {
    const r = inspecionarArquivo("vazio.txt", Buffer.alloc(0));
    assert.ok(ehFalhaInspecao(r));
    assert.equal(r.codigo, "arquivo_vazio");
  });

  test("rejeita arquivo acima do limite de tamanho", () => {
    const grande = Buffer.alloc(TAMANHO_MAXIMO_BYTES + 1, 0x41);
    const r = inspecionarArquivo("grande.txt", grande);
    assert.ok(ehFalhaInspecao(r));
    assert.equal(r.codigo, "tamanho_excedido");
  });

  test("ignora MIME type forjado e usa o canônico da extensão", () => {
    // Um Content-Type mentiroso não deve influenciar o tratamento do arquivo.
    const r = inspecionarArquivo("planilha.xlsx", Buffer.from("PK"), "text/html");
    assert.ok(!ehFalhaInspecao(r));
    assert.equal(
      r.mimeType,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });
});

describe("sanitização de nome (path traversal)", () => {
  test("remove componentes de caminho relativo", () => {
    assert.equal(sanitizarNomeArquivo("../../etc/passwd"), "passwd");
    assert.equal(sanitizarNomeArquivo("../../../x.txt"), "x.txt");
  });

  test("remove caminho absoluto do Windows", () => {
    assert.equal(sanitizarNomeArquivo("C:\\Windows\\system32\\evil.txt"), "evil.txt");
  });

  test("remove byte nulo e caracteres de controle", () => {
    assert.equal(sanitizarNomeArquivo("arquivo\u0000.txt"), "arquivo.txt");
  });

  test("neutraliza caracteres inválidos para storage", () => {
    assert.equal(sanitizarNomeArquivo('rel<a>t"o|rio?.csv'), "rel_a_t_o_rio_.csv");
  });

  test("nome só com pontos vira vazio (rejeitado depois)", () => {
    assert.equal(sanitizarNomeArquivo("..."), "");
  });

  test("extrai extensão em minúsculo", () => {
    assert.equal(extrairExtensao("RELATORIO.XLSX"), "xlsx");
    assert.equal(extrairExtensao("sem_extensao"), "");
  });
});

describe("nomenclatura", () => {
  const base = {
    empresaCodigo: "TL",
    ano: 2026,
    mes: 8,
    tipoDocumento: "relatorio_vendas",
    versao: 1,
    extensao: "xlsx",
  };

  test("gera o nome no padrão acordado", () => {
    // Padrão do escopo: {empresa}_{competencia}_{tipo}_v{versao}.{ext}
    assert.equal(gerarNomePadronizado(base), "TL_2026-08_RELATORIO_VENDAS_v1.xlsx");
  });

  test("gera a pasta de destino no padrão acordado", () => {
    assert.equal(gerarCaminhoPasta(base), "TL/2026/2026-08/RELATORIO_VENDAS");
  });

  test("caminho completo junta pasta e nome", () => {
    assert.equal(
      gerarCaminhoCompleto(base),
      "TL/2026/2026-08/RELATORIO_VENDAS/TL_2026-08_RELATORIO_VENDAS_v1.xlsx"
    );
  });

  test("versão diferente gera nome diferente (não sobrescreve)", () => {
    const v1 = gerarNomePadronizado(base);
    const v2 = gerarNomePadronizado({ ...base, versao: 2 });
    assert.notEqual(v1, v2);
    assert.ok(v2.includes("_v2."));
  });

  test("competência ausente não quebra a geração", () => {
    const semComp = gerarNomePadronizado({ ...base, ano: null, mes: null });
    assert.equal(semComp, "TL_SEM_COMPETENCIA_RELATORIO_VENDAS_v1.xlsx");
    assert.equal(formatarCompetencia(null, null), "SEM_COMPETENCIA");
  });

  test("mês de um dígito é preenchido com zero", () => {
    assert.equal(formatarCompetencia(2026, 3), "2026-03");
  });

  test("remove acento e espaço dos segmentos", () => {
    assert.equal(normalizarSegmento("Relatório de Vendas"), "RELATORIO_DE_VENDAS");
    assert.equal(normalizarSegmento("Precificação"), "PRECIFICACAO");
  });

  test("valor malicioso no código da empresa não escapa da pasta", () => {
    const caminho = gerarCaminhoCompleto({ ...base, empresaCodigo: "../../etc" });
    assert.ok(!caminho.includes(".."), `caminho não pode conter '..': ${caminho}`);
  });

  test("tipo documental com barra não cria pasta extra", () => {
    // A barra precisa ser neutralizada, senão o tipo documental viraria dois
    // níveis de pasta e o arquivo sairia do destino previsto.
    const pasta = gerarCaminhoPasta({ ...base, tipoDocumento: "a/b" });
    const segmentos = pasta.split("/");
    assert.equal(segmentos.length, 4, `pasta deveria ter 4 níveis, veio: ${pasta}`);
    assert.equal(segmentos[3], "A_B", "a barra deve virar underscore");
  });
});
