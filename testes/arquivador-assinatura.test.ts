import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  extrairConta,
  chaveConta,
  assinaturaLayout,
  identificarInstituicao,
} from "../lib/arquivador/assinatura";

/**
 * Nenhuma conta real. Os números têm a FORMA das contas que aparecem nos
 * documentos — que é o que o extrator procura.
 */

describe("extração de conta", () => {
  test("mesma conta em formatos diferentes vira a mesma chave", () => {
    // O ponto do desenho: o PDF escreve com pontos, o OFX sem. Se as duas
    // formas gerassem chaves diferentes, o aprendizado nunca casaria entre
    // o extrato em PDF e o mesmo extrato em OFX.
    const doPdf = extrairConta("Conta: \t1.136.082-8 / EMPRESA EXEMPLO LTDA");
    const doOfx = extrairConta("Conta: agência 5004-0 / conta 1136082-8 / CHECKING");

    assert.ok(doPdf && doOfx);
    assert.equal(chaveConta(doPdf), chaveConta(doOfx));
    assert.equal(chaveConta(doPdf), "11360828");
  });

  test("a agência fica FORA da chave", () => {
    // "Cooperativa: 5004-0" e "Cooperativa: 5004" são o mesmo lugar, escritos
    // por telas diferentes do mesmo banco. Na chave, virariam duas contas.
    const a = extrairConta("Cooperativa: 5004-0\nConta: 1.136.082-8");
    const b = extrairConta("Cooperativa: 5004\nConta: \t1.136.082-8");
    assert.ok(a && b);
    assert.notEqual(a.agencia, b.agencia, "as agências realmente diferem");
    assert.equal(chaveConta(a), chaveConta(b), "mas a chave tem de ser a mesma");
  });

  test("reconhece conta cartão", () => {
    const c = extrairConta("Conta Cartão: 7565004170240\nFatura de AGOSTO");
    assert.equal(c?.conta, "7565004170240");
  });

  test("sem rótulo de conta, não inventa", () => {
    // Um aprendizado errado é pior que aprendizado nenhum: uma vez confirmado,
    // passaria a mandar documento de um cliente para a pasta de outro.
    assert.equal(extrairConta("Valor total 1.136.082,80 referente ao período"), null);
    assert.equal(extrairConta("Nota fiscal 12345 emitida em 01/08/2026"), null);
    assert.equal(extrairConta(""), null);
  });

  test("número curto demais não é conta", () => {
    assert.equal(extrairConta("Conta: 12"), null);
  });

  test("o mesmo banco em nomes diferentes vira a mesma instituição", () => {
    // O OFX assina "Banco Cooperativo do Brasil"; o PDF diz "SICOOB".
    assert.equal(identificarInstituicao("Banco Cooperativo do Brasil"), "SICOOB");
    assert.equal(identificarInstituicao("SISTEMA DE COOPERATIVAS DE CRÉDITO DO BRASIL"), "SICOOB");
    assert.equal(identificarInstituicao("extrato SICOOB"), "SICOOB");
  });

  test("instituição desconhecida devolve null, não um palpite", () => {
    assert.equal(identificarInstituicao("Banco Que Nao Existe S.A."), null);
  });
});

describe("assinatura de layout", () => {
  test("as mesmas colunas em ordem diferente dão a mesma assinatura", () => {
    const a = assinaturaLayout({ tipo: "tabular", colunas: ["Data da venda", "Valor bruto", "Bandeira"] });
    const b = assinaturaLayout({ tipo: "tabular", colunas: ["Bandeira", "Data da venda", "Valor bruto"] });
    assert.ok(a);
    assert.equal(a, b);
  });

  test("acento e caixa não mudam a assinatura", () => {
    const a = assinaturaLayout({ tipo: "tabular", colunas: ["Histórico", "Informações", "Valor"] });
    const b = assinaturaLayout({ tipo: "tabular", colunas: ["HISTORICO", "informacoes", "valor"] });
    assert.equal(a, b);
  });

  test("conjuntos de colunas diferentes NÃO colidem", () => {
    // Recebíveis e Vendas da Cielo colidiam quando a extração lia o banner em
    // vez do cabeçalho real. Colidir significaria aprender "isto é relatório
    // de vendas" e depois classificar recebíveis como vendas.
    const vendas = assinaturaLayout({ tipo: "tabular", colunas: ["Data da venda", "Bandeira", "Valor bruto"] });
    const receb = assinaturaLayout({ tipo: "tabular", colunas: ["Data de pagamento", "Tipo de lançamento", "Valor líquido"] });
    assert.notEqual(vendas, receb);
  });

  test("uma coluna só não é layout", () => {
    assert.equal(assinaturaLayout({ tipo: "tabular", colunas: ["Total"] }), null);
  });

  test("texto: a data muda, a assinatura não", () => {
    // É isso que faz o extrato de setembro ser reconhecido pelo padrão que o
    // usuário confirmou em agosto.
    const agosto = assinaturaLayout({
      tipo: "texto",
      texto: [
        "SISTEMA DE COOPERATIVAS DE CREDITO",
        "EXTRATO DE CONTA CORRENTE 09/08/2026 - 09:02:15",
        "Cooperativa: 5004-0",
        "Periodo: 01/08/2026 - 31/08/2026",
      ].join("\n"),
    });
    const setembro = assinaturaLayout({
      tipo: "texto",
      texto: [
        "SISTEMA DE COOPERATIVAS DE CREDITO",
        "EXTRATO DE CONTA CORRENTE 09/09/2026 - 11:47:03",
        "Cooperativa: 5004-0",
        "Periodo: 01/09/2026 - 30/09/2026",
      ].join("\n"),
    });
    assert.ok(agosto);
    assert.equal(agosto, setembro);
  });

  test("texto: documentos de tipos diferentes não colidem", () => {
    const extrato = assinaturaLayout({
      tipo: "texto",
      texto: "SICOOB\nEXTRATO DE CONTA CORRENTE\nCooperativa\nConta",
    });
    const fatura = assinaturaLayout({
      tipo: "texto",
      texto: "SICOOB\nEXTRATO DE FATURA DE CARTAO DE CREDITO\nConta Cartao\nVencimento",
    });
    assert.notEqual(extrato, fatura);
  });

  test("texto sem cabeçalho legível não gera assinatura", () => {
    assert.equal(assinaturaLayout({ tipo: "texto", texto: "123\n456\n789" }), null);
    assert.equal(assinaturaLayout({ tipo: "texto", texto: "" }), null);
  });
});
