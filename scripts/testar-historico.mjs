/**
 * Testa o histórico de conversas contra as ROTAS REAIS do app, autenticado
 * como um usuário de teste (cookies de sessão, igual ao navegador).
 *
 * Cobre: criação persistente, reuso de chat vazio, limite de 10, arquivamento,
 * restauração, persistência de mensagem e isolamento entre usuários.
 *
 * Requer o dev server rodando em http://localhost:3000.
 * Uso: node scripts/testar-historico.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const l of fs.readFileSync(path.join(raiz, ".env"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { createClient } = await import("@supabase/supabase-js");
const APP = process.env.URL_TESTE_APP ?? "http://localhost:3000";
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const verde = (s) => `\x1b[32m${s}\x1b[0m`;
const vermelho = (s) => `\x1b[31m${s}\x1b[0m`;
let falhas = 0;
const checar = (d, c) => {
  if (c) console.log(`  ${verde("OK")}   ${d}`);
  else { falhas++; console.log(`  ${vermelho("FALHA")} ${d}`); }
};

/** Faz login pela tela real e guarda os cookies da sessão. */
async function sessaoDe(email, senha) {
  const corpo = new URLSearchParams({ email, senha, proximo: "/" });
  const r = await fetch(`${APP}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Next-Action": "login",
    },
    body: corpo,
    redirect: "manual",
  }).catch(() => null);

  // Server Actions exigem um id de ação que não temos aqui; autenticamos pelo
  // Supabase e montamos o cookie no mesmo formato que @supabase/ssr espera.
  void r;

  const anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } }
  );
  const { data, error } = await anon.auth.signInWithPassword({ email, password: senha });
  if (error) throw new Error(`login ${email}: ${error.message}`);

  const ref = process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1];
  const valor = Buffer.from(JSON.stringify(data.session)).toString("base64");
  return { cookie: `sb-${ref}-auth-token=base64-${valor}`, id: data.user.id };
}

function api(sessao) {
  return async (caminho, init = {}) => {
    const r = await fetch(`${APP}${caminho}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: sessao.cookie, ...(init.headers ?? {}) },
      redirect: "manual",
    });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* redirect ou html */ }
    return { status: r.status, json };
  };
}

async function criarUsuario(sufixo, papel) {
  const email = `teste-hist-${sufixo}-${randomUUID().slice(0, 8)}@teste.local`;
  const senha = randomBytes(18).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({
    email, password: senha, email_confirm: true,
  });
  if (error) throw new Error(error.message);
  await admin.from("perfis_usuarios").insert({
    usuario_id: data.user.id, nome: `Hist ${sufixo.toUpperCase()}`, email, papel,
  });
  return { id: data.user.id, email, senha };
}

const criados = [];
try {
  console.log("\n\x1b[1m1. Sessão autenticada\x1b[0m");
  const u1 = await criarUsuario("a", "analista");
  const u2 = await criarUsuario("b", "supervisor");
  criados.push(u1, u2);

  const s1 = await sessaoDe(u1.email, u1.senha);
  const s2 = await sessaoDe(u2.email, u2.senha);
  const a = api(s1);
  const b = api(s2);

  const inicial = await a("/api/conversas");
  checar("usuário autenticado acessa /api/conversas", inicial.status === 200 && inicial.json?.ok);
  checar("começa sem conversas", (inicial.json?.dados ?? []).length === 0);

  console.log("\n\x1b[1m2. Novo chat cria conversa REAL\x1b[0m");
  const criada = await a("/api/conversas", { method: "POST", body: "{}" });
  checar("POST cria conversa", criada.status === 201 && criada.json?.ok);
  const id1 = criada.json?.dados?.id;
  checar("devolve id real (uuid)", /^[0-9a-f-]{36}$/.test(id1 ?? ""));

  const depois = await a("/api/conversas");
  checar("conversa aparece no histórico", (depois.json?.dados ?? []).some((c) => c.id === id1));

  console.log("\n\x1b[1m3. Chat vazio é reutilizado\x1b[0m");
  const denovo = await a("/api/conversas", { method: "POST", body: "{}" });
  checar("segundo POST reutiliza o chat vazio", denovo.json?.dados?.id === id1);
  checar("marcado como reutilizada", denovo.json?.dados?.reutilizada === true);
  const lista2 = await a("/api/conversas");
  checar("não criou conversa duplicada", (lista2.json?.dados ?? []).length === 1);

  console.log("\n\x1b[1m4. Limite de 10 conversas\x1b[0m");
  // Dá conteúdo à primeira para ela não ser reutilizada.
  await admin.from("mensagens_agente").insert({
    conversa_id: id1, papel: "usuario", conteudo: "ocupando o chat", status: "concluida",
  });
  for (let i = 2; i <= 10; i++) {
    const c = await a("/api/conversas", { method: "POST", body: "{}" });
    if (c.json?.ok) {
      await admin.from("mensagens_agente").insert({
        conversa_id: c.json.dados.id, papel: "usuario", conteudo: `msg ${i}`, status: "concluida",
      });
    }
  }
  const cheio = await a("/api/conversas");
  checar("chegou a 10 conversas ativas", cheio.json?.ativas === 10);

  const excedente = await a("/api/conversas", { method: "POST", body: "{}" });
  checar("a 11ª é recusada com 409", excedente.status === 409);
  checar("mensagem explica o limite", /limite/i.test(excedente.json?.mensagem ?? ""));
  const aindaDez = await a("/api/conversas");
  checar("nenhuma conversa foi apagada", aindaDez.json?.ativas === 10);

  console.log("\n\x1b[1m5. Arquivar libera espaço\x1b[0m");
  const arq = await a(`/api/conversas/${id1}`, { method: "DELETE" });
  checar("arquivamento aceito", arq.status === 200);
  const nove = await a("/api/conversas");
  checar("passou a 9 ativas", nove.json?.ativas === 9);
  checar("arquivada sai do histórico", !(nove.json?.dados ?? []).some((c) => c.id === id1));

  const { data: preservada } = await admin
    .from("conversas_agente").select("status").eq("id", id1).single();
  checar("conversa arquivada foi PRESERVADA", preservada?.status === "arquivada");

  const nova11 = await a("/api/conversas", { method: "POST", body: "{}" });
  checar("com espaço, cria de novo", nova11.status === 201);

  console.log("\n\x1b[1m6. Restaurar revalida o limite\x1b[0m");
  const restaura = await a(`/api/conversas/${id1}`, {
    method: "PATCH", body: JSON.stringify({ acao: "restaurar" }),
  });
  checar("restaurar acima do limite é recusado", restaura.status === 409);

  console.log("\n\x1b[1m7. Isolamento entre usuários\x1b[0m");
  const doOutro = await b(`/api/conversas/${id1}/mensagens`);
  checar("B não lê mensagens da conversa de A", doOutro.status === 404);

  const renomeiaAlheia = await b(`/api/conversas/${id1}`, {
    method: "PATCH", body: JSON.stringify({ titulo: "invadido" }),
  });
  checar("B não renomeia conversa de A", renomeiaAlheia.status === 404);

  const listaB = await b("/api/conversas");
  checar("B vê apenas o próprio histórico (vazio)", (listaB.json?.dados ?? []).length === 0);

  console.log("\n\x1b[1m8. Sem sessão\x1b[0m");
  const semCookie = await fetch(`${APP}/api/conversas`, { redirect: "manual" });
  checar("rota exige autenticação", semCookie.status === 307 || semCookie.status === 401);
} catch (e) {
  falhas++;
  console.log(vermelho(`\nErro: ${e.message}`));
} finally {
  console.log("\n\x1b[1m9. Limpeza\x1b[0m");
  for (const u of criados) {
    const { data: convs } = await admin.from("conversas_agente").select("id").eq("usuario_id", u.id);
    for (const c of convs ?? []) {
      await admin.from("mensagens_agente").delete().eq("conversa_id", c.id);
    }
    await admin.from("conversas_agente").delete().eq("usuario_id", u.id);
    await admin.from("perfis_usuarios").delete().eq("usuario_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
  console.log("  usuários e conversas de teste removidos");
}

console.log();
if (falhas === 0) { console.log(verde("=== HISTÓRICO: TUDO PASSOU ===")); process.exit(0); }
else { console.log(vermelho(`=== ${falhas} FALHA(S) ===`)); process.exit(1); }
