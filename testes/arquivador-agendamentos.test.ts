import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { expandirDestino, montarNomeArquivo, type RegraArquivamento } from "../lib/arquivador/caminhos";
import { regraParaPastaExistente } from "../lib/arquivador/regras-pastas-existentes";
import {
  ehDoFluxoDeAgendamentos,
  regraDoFluxoDeAgendamentos,
  REGRA_AGENDAMENTOS,
} from "../lib/arquivador/fluxo-agendamentos";

function regra(codigo: string, caminho: string[], exigeEmpresa = true): RegraArquivamento {
  return {
    id: codigo, codigo, nome: codigo, escopo: "mensal", caminho_modelo: caminho,
    padrao_nome: "{CODIGO}_{COMPETENCIA}_{TIPO_DOCUMENTO}_v{VERSAO}.{EXTENSAO}",
    exige_empresa: exigeEmpresa, exige_competencia: true, exige_instituicao: false,
    projeto: null, subcategoria: null,
  };
}

const AGENDAMENTOS = regra(REGRA_AGENDAMENTOS, ["AGENDAMENTOS", "{ANO}", "{COMPETENCIA}"]);
const DOCUMENTO = regra("CLIENTE_DOCUMENTO", ["{ANO}", "{COMPETENCIA}"]);
const INTERNO = regra("INTERNO_GESTAO_ANALISE", ["00_INTERNO", "06_GESTAO_E_ANALISES_INTERNAS"], false);

describe("que documento é do fluxo de agendamentos", () => {
  test("contas a pagar, agendamentos e comprovante de pagamento entram", () => {
    assert.ok(ehDoFluxoDeAgendamentos("RELATORIO_AGENDAMENTOS"));
    assert.ok(ehDoFluxoDeAgendamentos("RELATORIO_CONTAS_A_PAGAR"));
    assert.ok(ehDoFluxoDeAgendamentos("COMPROVANTE_DE_AGENDAMENTO"));
    assert.ok(ehDoFluxoDeAgendamentos("COMPROVANTE_PAGAMENTO"));
    // O operador batiza o arquivo; isso conta como informação.
    assert.ok(ehDoFluxoDeAgendamentos(null, "EXEMPLO - AGENDAMENTOS - 11.09 A 20.09.pdf"));
  });

  test("o resto do mês não entra", () => {
    for (const tipo of ["NOTA_FISCAL", "EXTRATO", "FATURA_CARTAO", "COMPROVANTE_DE_ENDERECO", "FOLHA_PAGAMENTO"]) {
      assert.equal(ehDoFluxoDeAgendamentos(tipo), false, tipo);
    }
    assert.equal(ehDoFluxoDeAgendamentos(null, "extrato mensal.pdf"), false);
  });
});

describe("escolha da regra", () => {
  const regras = [AGENDAMENTOS, DOCUMENTO, INTERNO];

  test("troca a regra de cliente pela pasta AGENDAMENTOS", () => {
    const r = regraDoFluxoDeAgendamentos(DOCUMENTO, "RELATORIO_CONTAS_A_PAGAR", "contas.pdf", regras);
    assert.equal(r?.codigo, REGRA_AGENDAMENTOS);
  });

  test("não mexe em documento interno da Effective nem em outro tipo", () => {
    assert.equal(regraDoFluxoDeAgendamentos(INTERNO, "RELATORIO_AGENDAMENTOS", "x.pdf", regras)?.codigo, INTERNO.codigo);
    assert.equal(regraDoFluxoDeAgendamentos(DOCUMENTO, "NOTA_FISCAL", "nf.pdf", regras)?.codigo, DOCUMENTO.codigo);
  });

  test("sem a regra cadastrada, mantém a que veio", () => {
    assert.equal(regraDoFluxoDeAgendamentos(DOCUMENTO, "RELATORIO_AGENDAMENTOS", "x.pdf", [DOCUMENTO])?.codigo, DOCUMENTO.codigo);
  });
});

describe("caminho na estrutura de hoje", () => {
  const contexto = {
    empresaId: "id-999", empresaCodigo: "999", empresaNome: "EXEMPLO", pastaEmpresa: "999-EXEMPLO",
    pastaClientes: "01_CLIENTES_ATIVOS", competencia: "2026-09", tipoDocumento: "RELATORIO_AGENDAMENTOS",
    extensao: "pdf", versao: 1,
  };

  test("AGENDAMENTOS fica dentro da pasta do cliente, antes do ano", () => {
    const adaptada = regraParaPastaExistente(AGENDAMENTOS);
    assert.deepEqual(adaptada.caminho_modelo, ["AGENDAMENTOS", "{ANO}", "{COMPETENCIA_PASTA}"]);

    const destino = expandirDestino(adaptada, contexto);
    assert.ok(destino.ok);
    assert.equal(
      destino.ok && destino.caminhoLogico,
      "01_CLIENTES_ATIVOS/999-EXEMPLO/AGENDAMENTOS/2026/09.2026"
    );
    const nome = montarNomeArquivo(adaptada, contexto);
    assert.ok(nome.ok && nome.nome === "999_EXEMPLO_2026-09_RELATORIO_AGENDAMENTOS_v1.pdf");
  });

  test("documento comum continua na pasta plana da competência", () => {
    const destino = expandirDestino(regraParaPastaExistente(DOCUMENTO), contexto);
    assert.equal(destino.ok && destino.caminhoLogico, "01_CLIENTES_ATIVOS/999-EXEMPLO/2026/09.2026");
  });

  test("regra antiga (MENSAL_*) continua achatada", () => {
    const antiga = regra("MENSAL_CONTAS_PAGAR", ["01_DOCUMENTOS_MENSAIS", "{ANO}", "{COMPETENCIA}", "01_CONTAS_A_PAGAR"]);
    assert.deepEqual(regraParaPastaExistente(antiga).caminho_modelo, ["{ANO}", "{COMPETENCIA_PASTA}"]);
  });
});
