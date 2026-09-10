import { test } from "node:test";
import assert from "node:assert/strict";
import { identificarEmpresa, type EmpresaCandidata } from "../lib/arquivador/identificar-empresa";
import { itemArquivavel } from "../lib/arquivador/arquivamento";
import type { ItemAnalisado } from "../lib/arquivador/analise";

const clientes: EmpresaCandidata[] = [
  { id: "academia", codigo: "210", nome_fantasia: "TL ACADEMIA", razao_social: null, cnpj: "11222333000181", ativo: true },
  { id: "transportes", codigo: "211", nome_fantasia: "TL TRANSPORTES", razao_social: null, cnpj: null, ativo: true },
];
test("TL sem CNPJ devolve as duas opções e não escolhe empresa", () => {
  const r = identificarEmpresa(clientes, { nomeArquivo: "TL_2026-09.pdf", texto: "", cnpjs: [] });
  assert.equal(r.confianca, "conflitante");
  assert.equal(r.empresa, null);
  assert.equal(r.conflitos.length, 2);
  assert.match(r.conflitos[0].rotulo, /TL ACADEMIA/);
});
test("código TL não sobrepõe a possibilidade TL ACADEMIA", () => {
  const r = identificarEmpresa([{ ...clientes[1], codigo: "TL", nome_fantasia: "TL" }, clientes[0]],
    { nomeArquivo: "TL.pdf", texto: "", cnpjs: [] });
  assert.equal(r.confianca, "conflitante");
});
test("CNPJ resolve a sigla sem adivinhar", () => {
  const r = identificarEmpresa(clientes, { nomeArquivo: "TL.pdf", texto: "11222333000181", cnpjs: ["11222333000181"] });
  assert.equal(r.confianca, "confirmado");
  assert.equal(r.empresa?.id, "academia");
});
test("provável não pode ser arquivado mesmo que já tenha caminho sugerido", () => {
  const r = itemArquivavel({ status: "analisado", conflitos: [], empresa: { empresaId: "academia", confianca: "provavel" },
    caminhoSugerido: "CLIENTES/TL", nomeSugerido: "arquivo.pdf" } as unknown as ItemAnalisado);
  assert.equal(r.pode, false);
});
