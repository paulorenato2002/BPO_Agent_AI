import { test } from "node:test";
import assert from "node:assert/strict";
import { expandirDestino, type RegraArquivamento } from "../lib/arquivador/caminhos";
import { regraParaPastaExistente } from "../lib/arquivador/regras-pastas-existentes";

test("pasta real do cliente e competência MM.AAAA, sem categorias extras", () => {
  const regra: RegraArquivamento = { id: "teste", codigo: "CLIENTE_DOCUMENTO", nome: "Documento", escopo: "mensal",
    caminho_modelo: ["{ANO}", "{COMPETENCIA_PASTA}"], padrao_nome: "", exige_empresa: true,
    exige_competencia: true, exige_instituicao: false, projeto: null, subcategoria: null };
  const resultado = expandirDestino(regra, { empresaId: "teste", empresaCodigo: "210",
    empresaNome: "TL ACADEMIA DE GINASTICA LTDA", pastaEmpresa: "210-TL ACADEMIA",
    pastaClientes: "01_CLIENTES_ATIVOS", competencia: "2026-07" });
  assert.equal(resultado.ok, true);
  if (resultado.ok) assert.equal(resultado.caminhoLogico, "01_CLIENTES_ATIVOS/210-TL ACADEMIA/2026/07.2026");
});

test("regra antiga de extratos é adaptada somente em memória", () => {
  const antiga = { codigo: "MENSAL_EXTRATOS_INVESTIMENTOS", exige_empresa: true,
    caminho_modelo: ["01_DOCUMENTOS_MENSAIS", "{ANO}", "{COMPETENCIA}", "03_EXTRATOS_E_INVESTIMENTOS"] } as RegraArquivamento;
  assert.deepEqual(regraParaPastaExistente(antiga).caminho_modelo, ["{ANO}", "{COMPETENCIA_PASTA}"]);
  assert.equal(antiga.caminho_modelo.length, 4);
});
