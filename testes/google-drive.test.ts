import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { GoogleDriveAdapter, _limparCacheToken } from "../lib/storage/google-drive";

/**
 * Testes do adapter do Google Drive com `fetch` mockado.
 *
 * NENHUMA chamada real é feita ao Google. Estes testes provam que o adapter
 * monta as requisições corretas e — principalmente — que ele NUNCA reporta
 * sucesso quando as credenciais estão ausentes.
 */

// Chave RSA de teste, gerada em memória. Não é credencial de ninguém.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const ENV_ORIGINAL = { ...process.env };
const fetchOriginal = globalThis.fetch;

type Chamada = { url: string; metodo: string };
let chamadas: Chamada[] = [];

function configurarCredenciais() {
  process.env.GOOGLE_DRIVE_CLIENT_EMAIL = "servico@projeto.iam.gserviceaccount.com";
  process.env.GOOGLE_DRIVE_PRIVATE_KEY = privateKey as string;
  process.env.GOOGLE_DRIVE_PASTA_RAIZ_ID = "raiz123";
}

function limparCredenciais() {
  delete process.env.GOOGLE_DRIVE_CLIENT_EMAIL;
  delete process.env.GOOGLE_DRIVE_PRIVATE_KEY;
  delete process.env.GOOGLE_DRIVE_PASTA_RAIZ_ID;
}

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Mock do Drive: responde token, busca de pastas, criação de pasta e upload.
 * `arquivosExistentes` simula arquivos já presentes no destino.
 */
function instalarMockDrive(opcoes: { arquivosExistentes?: string[] } = {}) {
  const existentes = new Set(opcoes.arquivosExistentes ?? []);

  globalThis.fetch = (async (entrada: string | URL | Request, init?: RequestInit) => {
    const url = typeof entrada === "string" ? entrada : entrada.toString();
    chamadas.push({ url, metodo: init?.method ?? "GET" });

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return json({ access_token: "token-de-teste", expires_in: 3600 });
    }

    // Consulta de arquivos/pastas
    if (url.includes("/drive/v3/files?q=")) {
      const q = decodeURIComponent(url.split("q=")[1].split("&")[0]);
      const nome = /name = '([^']+)'/.exec(q)?.[1] ?? "";
      const ehPasta = q.includes("application/vnd.google-apps.folder");

      if (ehPasta) {
        // Toda pasta pedida "já existe" — simplifica a árvore.
        return json({ files: [{ id: `pasta_${nome}`, name: nome }] });
      }
      return existentes.has(nome)
        ? json({ files: [{ id: `arquivo_${nome}` }] })
        : json({ files: [] });
    }

    // Upload
    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
      return json({ id: "arquivo_novo_123", name: "TL_2026-08_RELATORIO_v1.xlsx" });
    }

    // Metadados da pasta raiz (health check)
    if (url.includes("/drive/v3/files/raiz123")) {
      return json({ id: "raiz123", name: "Documentos Effective" });
    }

    return json({ erro: "rota não mockada: " + url }, 404);
  }) as typeof fetch;
}

beforeEach(() => {
  chamadas = [];
  _limparCacheToken();
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  process.env = { ...ENV_ORIGINAL };
  _limparCacheToken();
});

describe("Google Drive — integração NÃO configurada", () => {
  test("estaConfigurado() é false sem as variáveis", () => {
    limparCredenciais();
    assert.equal(new GoogleDriveAdapter().estaConfigurado(), false);
  });

  test("enviar() nunca reporta sucesso sem credenciais", async () => {
    limparCredenciais();
    const r = await new GoogleDriveAdapter().enviar({
      caminho: "TL/2026/x.xlsx",
      conteudo: Buffer.from("dados"),
      mimeType: "application/vnd.ms-excel",
    });

    assert.equal(r.ok, false, "não pode fingir sucesso");
    assert.ok(!r.ok && r.naoConfigurado === true, "deve marcar como não configurado");
    assert.match(r.ok === false ? r.erro : "", /GOOGLE_DRIVE_CLIENT_EMAIL/);
  });

  test("a mensagem lista exatamente as variáveis que faltam", async () => {
    limparCredenciais();
    process.env.GOOGLE_DRIVE_CLIENT_EMAIL = "x@y.z";

    const r = await new GoogleDriveAdapter().enviar({
      caminho: "a/b.txt",
      conteudo: Buffer.from("x"),
      mimeType: "text/plain",
    });

    assert.equal(r.ok, false);
    const erro = r.ok === false ? r.erro : "";
    assert.ok(!erro.includes("GOOGLE_DRIVE_CLIENT_EMAIL"), "não deve listar a que existe");
    assert.match(erro, /GOOGLE_DRIVE_PRIVATE_KEY/);
    assert.match(erro, /GOOGLE_DRIVE_PASTA_RAIZ_ID/);
  });

  test("healthCheck() reporta não configurado, sem chamar a rede", async () => {
    limparCredenciais();
    let chamouRede = false;
    globalThis.fetch = (async () => {
      chamouRede = true;
      return json({});
    }) as typeof fetch;

    const h = await new GoogleDriveAdapter().healthCheck();
    assert.equal(h.configurado, false);
    assert.equal(h.disponivel, false);
    assert.equal(chamouRede, false, "não deve tentar rede sem credencial");
  });
});

describe("Google Drive — com credenciais (mock)", () => {
  test("upload confirma e devolve o ID do arquivo", async () => {
    configurarCredenciais();
    instalarMockDrive();

    const r = await new GoogleDriveAdapter().enviar({
      caminho: "TL/2026/2026-08/RELATORIO/TL_2026-08_RELATORIO_v1.xlsx",
      conteudo: Buffer.from("conteudo da planilha"),
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.identificadorExterno, "arquivo_novo_123");
      assert.equal(r.provedor, "google_drive");
      assert.ok(r.confirmadoEm instanceof Date, "precisa registrar quando confirmou");
    }
  });

  test("autentica via JWT antes de subir o arquivo", async () => {
    configurarCredenciais();
    instalarMockDrive();

    await new GoogleDriveAdapter().enviar({
      caminho: "TL/x.txt",
      conteudo: Buffer.from("x"),
      mimeType: "text/plain",
    });

    const token = chamadas.findIndex((c) => c.url.includes("oauth2.googleapis.com/token"));
    const upload = chamadas.findIndex((c) => c.url.includes("/upload/drive/v3/files"));
    assert.ok(token >= 0, "deveria pedir access token");
    assert.ok(upload > token, "o upload precisa vir depois da autenticação");
  });

  test("não sobrescreve arquivo já existente", async () => {
    configurarCredenciais();
    instalarMockDrive({ arquivosExistentes: ["ja_existe.txt"] });

    const r = await new GoogleDriveAdapter().enviar({
      caminho: "TL/2026/ja_existe.txt",
      conteudo: Buffer.from("novo conteudo"),
      mimeType: "text/plain",
    });

    assert.equal(r.ok, false, "sobrescrever silenciosamente é proibido");
    assert.match(r.ok === false ? r.erro : "", /Já existe/i);
    assert.ok(
      !chamadas.some((c) => c.url.includes("/upload/")),
      "não deveria nem tentar o upload"
    );
  });

  test("existe() detecta corretamente presença e ausência", async () => {
    configurarCredenciais();
    instalarMockDrive({ arquivosExistentes: ["presente.txt"] });
    const adapter = new GoogleDriveAdapter();

    const achou = await adapter.existe("TL/presente.txt");
    assert.equal(achou.ok && achou.existe, true);

    const naoAchou = await adapter.existe("TL/ausente.txt");
    assert.equal(naoAchou.ok && naoAchou.existe, false);
  });

  test("healthCheck() confirma acesso à pasta raiz", async () => {
    configurarCredenciais();
    instalarMockDrive();

    const h = await new GoogleDriveAdapter().healthCheck();
    assert.equal(h.configurado, true);
    assert.equal(h.disponivel, true);
    assert.match(h.detalhe, /Documentos Effective/);
  });

  test("erro HTTP do Google vira falha explícita, não sucesso", async () => {
    configurarCredenciais();
    globalThis.fetch = (async (entrada: string | URL | Request) => {
      const url = typeof entrada === "string" ? entrada : entrada.toString();
      if (url.includes("oauth2.googleapis.com/token")) {
        return json({ access_token: "t", expires_in: 3600 });
      }
      if (url.includes("/drive/v3/files?q=")) return json({ files: [] });
      return json({ error: "quota" }, 500);
    }) as typeof fetch;

    const r = await new GoogleDriveAdapter().enviar({
      caminho: "TL/x.txt",
      conteudo: Buffer.from("x"),
      mimeType: "text/plain",
    });

    assert.equal(r.ok, false);
    assert.ok(!r.ok && !r.naoConfigurado, "erro de execução não é 'não configurado'");
    assert.match(r.ok === false ? r.erro : "", /HTTP 500/);
  });

  test("falha de autenticação não vaza detalhe da credencial", async () => {
    configurarCredenciais();
    globalThis.fetch = (async () =>
      json({ error: "invalid_grant", error_description: "chave privada X" }, 401)) as typeof fetch;

    const r = await new GoogleDriveAdapter().enviar({
      caminho: "TL/x.txt",
      conteudo: Buffer.from("x"),
      mimeType: "text/plain",
    });

    assert.equal(r.ok, false);
    const erro = r.ok === false ? r.erro : "";
    assert.ok(!erro.includes("chave privada"), "mensagem não pode vazar detalhe da credencial");
    assert.match(erro, /HTTP 401/);
  });
});
