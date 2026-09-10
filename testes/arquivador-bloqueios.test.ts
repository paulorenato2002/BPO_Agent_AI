import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  verificarBloqueio,
  bloqueadoPorNome,
  bloqueadoPorConteudo,
  EXTENSOES_BLOQUEADAS,
  redigirSegredos,
} from "../lib/arquivador/bloqueios";

/**
 * Nenhum segredo real aparece aqui. Todos os valores são inventados e têm
 * apenas a FORMA de uma credencial — é a forma que o detector procura.
 */

describe("bloqueio por extensão", () => {
  test("recusa todo certificado e chave da lista", () => {
    for (const ext of EXTENSOES_BLOQUEADAS) {
      const r = bloqueadoPorNome(`arquivo.${ext}`);
      assert.equal(r.bloqueado, true, `.${ext} deveria ser bloqueado`);
      assert.equal(r.bloqueado && r.categoria, "extensao");
    }
  });

  test("o .pfx do acervo antigo é recusado", () => {
    const r = verificarBloqueio("CERTIFICADO_A1_EMPRESA.pfx");
    assert.equal(r.bloqueado, true);
    assert.match(r.bloqueado ? r.motivo : "", /não foi lido/i);
  });

  test("maiúsculas não escapam do bloqueio", () => {
    assert.equal(bloqueadoPorNome("CHAVE.PEM").bloqueado, true);
    assert.equal(bloqueadoPorNome("Certificado.PFX").bloqueado, true);
  });

  test("caminho no nome não escapa do bloqueio", () => {
    assert.equal(bloqueadoPorNome("../../segredos/prod.key").bloqueado, true);
    assert.equal(bloqueadoPorNome("C:\\certs\\prod.p12").bloqueado, true);
  });

  test("planilha e PDF legítimos passam", () => {
    for (const nome of ["NOTAS_2026-09.xlsx", "extrato.pdf", "base.csv", "anotacoes.txt"]) {
      assert.equal(verificarBloqueio(nome).bloqueado, false, `${nome} não devia ser bloqueado`);
    }
  });
});

describe("bloqueio por nome de credencial", () => {
  test("recusa nomes conhecidos de credencial", () => {
    const nomes = [
      "client_secret_123.json",
      "service-account.json",
      "credentials.json",
      "tokens.json",
      ".env",
      ".env.local",
      "id_rsa",
      "authorized_keys",
    ];

    for (const nome of nomes) {
      const r = bloqueadoPorNome(nome);
      assert.equal(r.bloqueado, true, `${nome} deveria ser bloqueado`);
    }
  });

  test("nome legítimo que contém a palavra não é bloqueado", () => {
    // "Política de credenciais" é documento de processo, conteúdo normal de BPO.
    assert.equal(bloqueadoPorNome("POLITICA_DE_ACESSO.pdf").bloqueado, false);
    assert.equal(bloqueadoPorNome("RELATORIO_TOKENS_CARTAO.xlsx").bloqueado, false);
  });
});

describe("bloqueio por conteúdo", () => {
  test("rótulo léxico NÃO bloqueia — é tarjado depois", () => {
    // A política mudou de propósito. "senha:" e "api_key=" dão falso positivo
    // demais em documento financeiro: um extrato real trazia a senha do boleto
    // na coluna de observações e era recusado inteiro. Em vez de perder o
    // documento, o VALOR é tarjado antes de qualquer coisa ir ao modelo.
    assert.equal(bloqueadoPorConteudo("usuario: joao\nsenha: exemplo-fake-123").bloqueado, false);
    assert.equal(bloqueadoPorConteudo("api_key = valor-ficticio-aqui").bloqueado, false);
    assert.equal(bloqueadoPorConteudo("secret: nao-e-real").bloqueado, false);
  });

  test("token Bearer continua bloqueando: o formato é inconfundível", () => {
    assert.equal(bloqueadoPorConteudo("Authorization: Bearer abc.def.ghi.jkl").bloqueado, true);
  });

  test("chave privada PEM colada no texto é detectada", () => {
    const texto = "segue a chave\n-----BEGIN RSA PRIVATE KEY-----\nAAAA\n";
    assert.equal(bloqueadoPorConteudo(texto).bloqueado, true);
  });

  test("credencial embutida em URL é detectada", () => {
    assert.equal(
      bloqueadoPorConteudo("conectar em postgres://usuario:senhafake@host:5432/db").bloqueado,
      true
    );
  });

  test("chave de service account e chave AWS são detectadas", () => {
    assert.equal(bloqueadoPorConteudo('{"private_key_id": "abc123"}').bloqueado, true);
    assert.equal(bloqueadoPorConteudo("AKIAIOSFODNN7EXAMPLE").bloqueado, true);
  });

  test("o motivo NUNCA ecoa o segredo encontrado", () => {
    const segredo = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const r = bloqueadoPorConteudo(`chave da conta: ${segredo}`);

    assert.equal(r.bloqueado, true);
    const motivo = r.bloqueado ? r.motivo : "";
    assert.ok(!motivo.includes(segredo), "o motivo vazou o segredo");
    assert.ok(!motivo.includes("sk-"), "o motivo vazou o prefixo da chave");
  });

  test("documento que FALA sobre senha não é bloqueado", () => {
    // Sem "rótulo: valor" não há segredo — é texto sobre política.
    const texto =
      "A política exige troca de senha a cada 90 dias. " +
      "O token de acesso deve ser renovado pelo gestor.";
    assert.equal(bloqueadoPorConteudo(texto).bloqueado, false, `falso positivo: ${texto}`);
  });

  test("extrato bancário fictício comum não é bloqueado", () => {
    const texto = [
      "EXTRATO DE CONTA CORRENTE",
      "Agencia 0001 Conta 12345-6",
      "01/09/2026 PIX RECEBIDO 1.250,00",
      "03/09/2026 TARIFA MENSAL -49,90",
    ].join("\n");
    assert.equal(bloqueadoPorConteudo(texto).bloqueado, false);
  });
});

describe("verificarBloqueio — barreira completa", () => {
  test("sem texto, checa só o nome (uso do upload, antes de ler)", () => {
    assert.equal(verificarBloqueio("planilha.xlsx").bloqueado, false);
    assert.equal(verificarBloqueio("chave.pem").bloqueado, true);
  });

  test("o nome é checado ANTES do conteúdo", () => {
    // Extensão proibida vence, mesmo com conteúdo inocente.
    const r = verificarBloqueio("cert.pfx", "conteudo totalmente inocente");
    assert.equal(r.bloqueado, true);
    assert.equal(r.bloqueado && r.categoria, "extensao");
  });

  test("nome ok + segredo ESTRUTURAL é bloqueado pelo conteúdo", () => {
    const r = verificarBloqueio("anotacoes.txt", "chave sk-abcdefghijklmnop123456");
    assert.equal(r.bloqueado, true);
    assert.equal(r.bloqueado && r.categoria, "conteudo");
  });
});

describe("tarja de rótulos léxicos", () => {
  test("o extrato com senha de boleto passa, sem o valor", () => {
    // Caso real: coluna "Observações" de um extrato financeiro trazia
    // "SENHA : 50936" — a senha do boleto. O documento inteiro era recusado.
    const linha = '{"Descrição":"Conta de internet","Observações":"SENHA : 50936"}';
    assert.equal(bloqueadoPorConteudo(linha).bloqueado, false);

    const { texto, redigidos } = redigirSegredos(linha);
    assert.equal(redigidos, 1);
    assert.ok(!texto.includes("50936"), "o valor não pode sobreviver à tarja");
    assert.ok(texto.includes("SENHA"), "o rótulo fica: ajuda a classificar");
  });

  test("tarja todas as ocorrências, não só a primeira", () => {
    const { texto, redigidos } = redigirSegredos(
      ["senha: aaa1", "senha: bbb2", "token: ccc3"].join("\n")
    );
    assert.equal(redigidos, 3);
    assert.ok(!texto.includes("aaa1"));
    assert.ok(!texto.includes("bbb2"));
    assert.ok(!texto.includes("ccc3"));
  });

  test("chamadas seguidas não pulam ocorrências", () => {
    // Regex global guarda `lastIndex`. Se ele vazasse entre chamadas, a
    // segunda tarja começaria no meio do texto e deixaria segredo passar.
    const entrada = "senha: zzz9";
    for (let i = 0; i < 3; i++) {
      assert.equal(redigirSegredos(entrada).redigidos, 1, `chamada ${i + 1}`);
    }
  });

  test("documento que só FALA de senha não é tarjado", () => {
    const texto = "A política exige troca de senha a cada 90 dias.";
    assert.equal(redigirSegredos(texto).redigidos, 0);
  });
});
