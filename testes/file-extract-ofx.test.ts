import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseArquivo, extensaoSuportada } from "../lib/file-extract";
import { identificarCompetencia } from "../lib/arquivador/identificar-empresa";

/**
 * OFX — extrato bancário eletrônico.
 *
 * Nenhum dado real: banco, agência, conta e lançamentos são inventados, mas a
 * FORMA é a do arquivo que o Sicoob exporta, que é o que o leitor procura.
 */

/** Monta um OFX mínimo mas fiel: SGML, tags de valor sem fechamento. */
function ofx(opcoes: { inicio: string; fim: string; lancamentos: [string, string, string][] }) {
  const transacoes = opcoes.lancamentos
    .map(
      ([data, valor, memo]) =>
        `<STMTTRN>\n<TRNTYPE>OTHER\n<DTPOSTED>${data}120000[-3:BRT]\n` +
        `<TRNAMT>${valor}\n<FITID>${data}${valor}\n<MEMO>${memo}\n</STMTTRN>`
    )
    .join("\n");

  return Buffer.from(
    [
      "OFXHEADER:100",
      "DATA:OFXSGML",
      "VERSION:102",
      "ENCODING:USASCII",
      "CHARSET:1252",
      "",
      "<OFX>",
      "<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE></STATUS>",
      "<FI>",
      "<ORG>Banco Ficticio de Teste",
      "<FID>999",
      "</FI>",
      "</SONRS></SIGNONMSGSRSV1>",
      "<BANKMSGSRSV1><STMTTRNRS><STMTRS>",
      "<CURDEF>BRL",
      "<BANKACCTFROM>",
      "<BANKID>999",
      "<BRANCHID>1234-5",
      "<ACCTID>9876543-2",
      "<ACCTTYPE>CHECKING",
      "</BANKACCTFROM>",
      "<BANKTRANLIST>",
      `<DTSTART>${opcoes.inicio}120000[-3:BRT]`,
      `<DTEND>${opcoes.fim}120000[-3:BRT]`,
      transacoes,
      "</BANKTRANLIST>",
      "<LEDGERBAL><BALAMT>1234.56<DTASOF>" + opcoes.fim + "</LEDGERBAL>",
      "</STMTRS></STMTTRNRS></BANKMSGSRSV1>",
      "</OFX>",
    ].join("\n"),
    "latin1"
  );
}

const PADRAO = ofx({
  inicio: "20260801",
  fim: "20260831",
  lancamentos: [
    ["20260805", "-150.00", "PAGAMENTO FORNECEDOR"],
    ["20260815", "2300.75", "PIX RECEBIDO"],
    ["20260901", "-99.90", "TARIFA"],
  ],
});

describe("leitura de OFX", () => {
  test(".ofx é aceito no upload", () => {
    assert.equal(extensaoSuportada("extrato.ofx"), true);
    assert.equal(extensaoSuportada("extrato.OFX"), true);
  });

  test("extrai banco, agência e conta — o que identifica o cliente", async () => {
    const r = await parseArquivo("extrato.ofx", PADRAO);
    assert.equal(r.tipo, "texto");
    if (r.tipo !== "texto") return;

    assert.match(r.texto, /Banco Ficticio de Teste/);
    assert.match(r.texto, /agência 1234-5/);
    assert.match(r.texto, /conta 9876543-2/);
    assert.equal(r.descricaoTipo, "extrato bancário OFX");
  });

  test("declara o período com separador, e é ele que vira competência", async () => {
    const r = await parseArquivo("extrato.ofx", PADRAO);
    if (r.tipo !== "texto") return assert.fail("esperava texto");

    assert.match(r.texto, /Período do extrato: 2026-08-01 a 2026-08-31/);

    // O ponto do desenho: um lançamento em setembro não pode transformar a
    // competência em "conflitante". Só o período do extrato conta.
    const comp = identificarCompetencia(r.texto, "extrato.ofx");
    assert.equal(comp.competencia, "2026-08");
    assert.notEqual(comp.confianca, "conflitante");
  });

  test("as datas dos lançamentos saem SEM separador, de propósito", async () => {
    const r = await parseArquivo("extrato.ofx", PADRAO);
    if (r.tipo !== "texto") return assert.fail("esperava texto");

    // 20260901 aparece; 2026-09-01 não pode aparecer, senão viraria uma
    // segunda competência candidata e o extrato seria marcado ambíguo.
    assert.match(r.texto, /20260901/);
    assert.ok(!r.texto.includes("2026-09-01"));
  });

  test("conta os lançamentos mesmo amostrando", async () => {
    const muitos = ofx({
      inicio: "20260801",
      fim: "20260831",
      lancamentos: Array.from({ length: 120 }, (_, i) => [
        "20260805",
        `-${i + 1}.00`,
        `LANCAMENTO ${i + 1}`,
      ]) as [string, string, string][],
    });
    const r = await parseArquivo("extrato.ofx", muitos);
    if (r.tipo !== "texto") return assert.fail("esperava texto");

    assert.match(r.texto, /Lançamentos no arquivo: 120/);
    assert.match(r.texto, /e mais 80/);
    // Amostrar mantém o texto pequeno: classificar não precisa do extrato todo.
    assert.ok(r.texto.length < 6000, `texto ficou com ${r.texto.length} caracteres`);
  });

  test("acento sobrevive à codificação latin1 do banco", async () => {
    const comAcento = ofx({
      inicio: "20260801",
      fim: "20260831",
      lancamentos: [["20260805", "-10.00", "MANUTENÇÃO DE CONTA"]],
    });
    const r = await parseArquivo("extrato.ofx", comAcento);
    if (r.tipo !== "texto") return assert.fail("esperava texto");
    assert.match(r.texto, /MANUTENÇÃO/);
  });

  test("arquivo truncado não derruba a leitura", async () => {
    const pedaco = PADRAO.subarray(0, 200);
    const r = await parseArquivo("extrato.ofx", pedaco);
    assert.equal(r.tipo, "texto");
    if (r.tipo !== "texto") return;
    // Sem período nem conta, mas ainda é um resultado utilizável — o
    // classificador decide o que fazer com pouco sinal.
    assert.match(r.texto, /Extrato bancário eletrônico/);
  });
});
