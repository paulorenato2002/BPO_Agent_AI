import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  verificarBloqueio,
  bloqueadoPorNome,
  bloqueadoPorConteudo,
  EXTENSOES_BLOQUEADAS,
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
  test("senha colada em txt é detectada", () => {
    const r = bloqueadoPorConteudo("Acesso ao portal\nusuario: joao\nsenha: exemplo-fake-123");
    assert.equal(r.bloqueado, true);
    assert.equal(r.bloqueado && r.categoria, "conteudo");
  });

  test("token e api key são detectados", () => {
    assert.equal(bloqueadoPorConteudo("api_key = valor-ficticio-aqui").bloqueado, true);
    assert.equal(bloqueadoPorConteudo("Authorization: Bearer abc.def.ghi").bloqueado, true);
    assert.equal(bloqueadoPorConteudo("secret: nao-e-real").bloqueado, true);
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

  test("nome ok + conteúdo com segredo é bloqueado pelo conteúdo", () => {
    const r = verificarBloqueio("anotacoes.txt", "senha: fake-123");
    assert.equal(r.bloqueado, true);
    assert.equal(r.bloqueado && r.categoria, "conteudo");
  });
});
