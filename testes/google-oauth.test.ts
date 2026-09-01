import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  ESCOPO_DRIVE,
  lerConfigOAuth,
  ehConfigFaltando,
  gerarState,
  stateConfere,
  montarUrlAutorizacao,
  trocarCodigoPorTokens,
  obterAccessToken,
  estaDentroDaRaiz,
  _limparCacheToken,
} from "../lib/integracoes/google-oauth";

import {
  guardarRefreshTokenParaExibicao,
  consumirRefreshToken,
  exibicaoPermitida,
} from "../lib/integracoes/refresh-token-temporario";

const ENV_ORIGINAL = { ...process.env };
const fetchOriginal = globalThis.fetch;

const CONFIG = {
  clientId: "id-de-teste.apps.googleusercontent.com",
  clientSecret: "segredo-de-teste",
  redirectUri: "http://localhost:3000/api/integracoes/google-drive/callback",
};

function configurar() {
  process.env.GOOGLE_DRIVE_CLIENT_ID = CONFIG.clientId;
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = CONFIG.clientSecret;
  process.env.GOOGLE_DRIVE_REDIRECT_URI = CONFIG.redirectUri;
}

function limpar() {
  for (const v of [
    "GOOGLE_DRIVE_CLIENT_ID",
    "GOOGLE_DRIVE_CLIENT_SECRET",
    "GOOGLE_DRIVE_REDIRECT_URI",
    "GOOGLE_DRIVE_REFRESH_TOKEN",
    "GOOGLE_DRIVE_PASTA_RAIZ_ID",
  ]) {
    delete process.env[v];
  }
}

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  limpar();
  _limparCacheToken();
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  process.env = { ...ENV_ORIGINAL };
  _limparCacheToken();
});

describe("configuração", () => {
  test("reporta exatamente as variáveis ausentes", () => {
    const c = lerConfigOAuth();
    assert.ok(ehConfigFaltando(c));
    assert.deepEqual(c.faltando, [
      "GOOGLE_DRIVE_CLIENT_ID",
      "GOOGLE_DRIVE_CLIENT_SECRET",
      "GOOGLE_DRIVE_REDIRECT_URI",
    ]);
  });

  test("com tudo definido, devolve a configuração", () => {
    configurar();
    const c = lerConfigOAuth();
    assert.ok(!ehConfigFaltando(c));
    assert.equal(c.clientId, CONFIG.clientId);
  });
});

describe("state (CSRF)", () => {
  test("é longo e imprevisível", () => {
    const a = gerarState();
    const b = gerarState();
    assert.notEqual(a, b);
    assert.ok(a.length >= 40, `state curto demais: ${a.length}`);
  });

  test("confere apenas quando idêntico", () => {
    const s = gerarState();
    assert.equal(stateConfere(s, s), true);
    assert.equal(stateConfere(s, gerarState()), false);
  });

  test("rejeita ausente, vazio ou de tamanho diferente", () => {
    const s = gerarState();
    assert.equal(stateConfere(undefined, s), false, "state ausente");
    assert.equal(stateConfere(s, undefined), false, "cookie ausente");
    assert.equal(stateConfere("", s), false, "state vazio");
    assert.equal(stateConfere(s.slice(0, -1), s), false, "tamanho diferente");
  });
});

describe("URL de autorização", () => {
  test("pede offline + consent e SOMENTE o escopo drive.file", () => {
    configurar();
    const c = lerConfigOAuth();
    assert.ok(!ehConfigFaltando(c));

    const url = new URL(montarUrlAutorizacao(c, "estado-x"));
    const p = url.searchParams;

    assert.equal(p.get("scope"), ESCOPO_DRIVE);
    assert.equal(p.get("scope"), "https://www.googleapis.com/auth/drive.file");
    assert.equal(p.get("access_type"), "offline");
    assert.equal(p.get("prompt"), "consent");
    assert.equal(p.get("include_granted_scopes"), "true");
    assert.equal(p.get("response_type"), "code");
    assert.equal(p.get("state"), "estado-x");
  });

  test("NÃO pede acesso amplo ao Drive", () => {
    configurar();
    const c = lerConfigOAuth();
    assert.ok(!ehConfigFaltando(c));
    const url = montarUrlAutorizacao(c, "s");

    // O escopo amplo terminaria em /auth/drive, sem o sufixo .file.
    assert.ok(
      !/auth%2Fdrive(&|$)/.test(url) && !/auth\/drive(&|$)/.test(url),
      "não pode solicitar o escopo amplo /auth/drive"
    );
  });

  test("o client_secret NUNCA vai na URL de autorização", () => {
    configurar();
    const c = lerConfigOAuth();
    assert.ok(!ehConfigFaltando(c));
    const url = montarUrlAutorizacao(c, "s");
    assert.ok(!url.includes(CONFIG.clientSecret), "client_secret vazou na URL");
  });
});

describe("troca de código por tokens", () => {
  test("exige refresh_token e explica o que fazer sem ele", async () => {
    configurar();
    globalThis.fetch = (async () =>
      json({ access_token: "at", scope: ESCOPO_DRIVE })) as typeof fetch;

    const r = await trocarCodigoPorTokens(CONFIG, "codigo-x");
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.semRefreshToken === true);
    assert.match(r.ok === false ? r.erro : "", /permissions/i);
  });

  test("erro HTTP não vaza o código de autorização", async () => {
    configurar();
    globalThis.fetch = (async () =>
      json({ error: "invalid_grant", code: "codigo-secreto-x" }, 400)) as typeof fetch;

    const r = await trocarCodigoPorTokens(CONFIG, "codigo-secreto-x");
    assert.equal(r.ok, false);
    const erro = r.ok === false ? r.erro : "";
    assert.ok(!erro.includes("codigo-secreto-x"), "o código vazou na mensagem");
    assert.match(erro, /HTTP 400/);
  });

  test("sucesso devolve o refresh token e a conta", async () => {
    configurar();
    globalThis.fetch = (async (entrada: string | URL | Request) => {
      const url = typeof entrada === "string" ? entrada : entrada.toString();
      if (url.includes("/about")) {
        return json({ user: { emailAddress: "colaborador@empresa.com" } });
      }
      return json({ refresh_token: "rt-teste", access_token: "at", scope: ESCOPO_DRIVE });
    }) as typeof fetch;

    const r = await trocarCodigoPorTokens(CONFIG, "codigo-x");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.refreshToken, "rt-teste");
      assert.equal(r.email, "colaborador@empresa.com");
    }
  });
});

describe("access token", () => {
  test("sem configuração, reporta 'não configurado' e não chama a rede", async () => {
    let chamouRede = false;
    globalThis.fetch = (async () => {
      chamouRede = true;
      return json({});
    }) as typeof fetch;

    const r = await obterAccessToken();
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.naoConfigurado === true);
    assert.match(r.ok === false ? r.erro : "", /GOOGLE_DRIVE_REFRESH_TOKEN/);
    assert.equal(chamouRede, false);
  });

  test("token inválido devolve erro com orientação", async () => {
    configurar();
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN = "rt-invalido";
    globalThis.fetch = (async () => json({ error: "invalid_grant" }, 400)) as typeof fetch;

    const r = await obterAccessToken();
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.erro : "", /revogado/i);
  });

  test("reaproveita o token em cache em vez de renovar a cada chamada", async () => {
    configurar();
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN = "rt";
    let renovacoes = 0;
    globalThis.fetch = (async () => {
      renovacoes++;
      return json({ access_token: "at-1", expires_in: 3600 });
    }) as typeof fetch;

    await obterAccessToken();
    await obterAccessToken();
    await obterAccessToken();
    assert.equal(renovacoes, 1, "deveria renovar uma vez só");
  });
});

describe("confinamento à pasta raiz", () => {
  const RAIZ = "raiz123";

  test("aceita o próprio id da raiz", async () => {
    assert.equal(await estaDentroDaRaiz("at", RAIZ, RAIZ), true);
  });

  test("aceita descendente indireto", async () => {
    // neto -> filho -> raiz
    globalThis.fetch = (async (entrada: string | URL | Request) => {
      const url = typeof entrada === "string" ? entrada : entrada.toString();
      if (url.includes("neto")) return json({ parents: ["filho"] });
      if (url.includes("filho")) return json({ parents: [RAIZ] });
      return json({}, 404);
    }) as typeof fetch;

    assert.equal(await estaDentroDaRaiz("at", "neto", RAIZ), true);
  });

  test("RECUSA item fora da raiz", async () => {
    // externo -> raiz-do-drive (sem passar pela nossa)
    globalThis.fetch = (async (entrada: string | URL | Request) => {
      const url = typeof entrada === "string" ? entrada : entrada.toString();
      if (url.includes("externo")) return json({ parents: ["outraPasta"] });
      if (url.includes("outraPasta")) return json({ parents: [] });
      return json({}, 404);
    }) as typeof fetch;

    assert.equal(await estaDentroDaRaiz("at", "externo", RAIZ), false);
  });

  test("não entra em laço infinito com ciclo de pais", async () => {
    globalThis.fetch = (async () => json({ parents: ["a"] })) as typeof fetch;
    assert.equal(await estaDentroDaRaiz("at", "a", RAIZ, 5), false);
  });
});

describe("exibição única do refresh token", () => {
  test("permitida fora de produção", () => {
    assert.equal(exibicaoPermitida(), process.env.NODE_ENV !== "production");
  });

  test("leitura consome — a mesma chave não serve duas vezes", () => {
    const chave = guardarRefreshTokenParaExibicao("user-1", "rt-secreto", "a@b.com");

    const primeira = consumirRefreshToken(chave, "user-1");
    assert.equal(primeira.ok, true);
    assert.equal(primeira.ok && primeira.refreshToken, "rt-secreto");

    const segunda = consumirRefreshToken(chave, "user-1");
    assert.equal(segunda.ok, false);
    assert.equal(segunda.ok === false && segunda.motivo, "nao_encontrado");
  });

  test("outro usuário não consegue ler o token", () => {
    const chave = guardarRefreshTokenParaExibicao("user-1", "rt-secreto", null);

    const invasor = consumirRefreshToken(chave, "user-2");
    assert.equal(invasor.ok, false);
    assert.equal(invasor.ok === false && invasor.motivo, "outro_usuario");

    // E o dono ainda consegue — a tentativa alheia não destruiu o token.
    const dono = consumirRefreshToken(chave, "user-1");
    assert.equal(dono.ok, true);
  });

  test("chave inexistente não devolve nada", () => {
    const r = consumirRefreshToken("chave-que-nunca-existiu", "user-1");
    assert.equal(r.ok, false);
  });
});
