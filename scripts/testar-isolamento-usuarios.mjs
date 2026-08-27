/**
 * Prova de isolamento multiusuário contra a RLS REAL do Supabase.
 *
 * Cria dois usuários de teste próprios (com senhas geradas na hora, nunca
 * usando contas reais da equipe), autentica cada um, e verifica com o JWT de
 * cada um o que ele consegue e o que NÃO consegue ver.
 *
 * Ao final, remove os dois usuários e tudo que criaram.
 *
 * Uso: node scripts/testar-isolamento-usuarios.mjs
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

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const verde = (s) => `\x1b[32m${s}\x1b[0m`;
const vermelho = (s) => `\x1b[31m${s}\x1b[0m`;

let falhas = 0;
function checar(descricao, condicao) {
  if (condicao) console.log(`  ${verde("OK")}   ${descricao}`);
  else { falhas++; console.log(`  ${vermelho("FALHA")} ${descricao}`); }
}

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

/** Cliente que age COMO o usuário — sujeito à RLS, igual ao navegador dele. */
function clienteDoUsuario(token) {
  return createClient(URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function criarUsuarioTeste(sufixo, papel) {
  const email = `teste-isolamento-${sufixo}-${randomUUID().slice(0, 8)}@teste.local`;
  const senha = randomBytes(18).toString("base64url");

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: senha,
    email_confirm: true,
  });
  if (error) throw new Error(`criar usuário ${sufixo}: ${error.message}`);

  const { error: erroPerfil } = await admin.from("perfis_usuarios").insert({
    usuario_id: data.user.id,
    nome: `Teste Isolamento ${sufixo.toUpperCase()}`,
    email,
    papel,
  });
  if (erroPerfil) throw new Error(`perfil ${sufixo}: ${erroPerfil.message}`);

  const anon = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: sessao, error: erroLogin } = await anon.auth.signInWithPassword({
    email,
    password: senha,
  });
  if (erroLogin) throw new Error(`login ${sufixo}: ${erroLogin.message}`);

  return { id: data.user.id, email, senha, token: sessao.session.access_token };
}

const criados = [];

try {
  console.log("\n\x1b[1m1. Criando dois usuários de teste\x1b[0m");
  const a = await criarUsuarioTeste("a", "analista");
  const b = await criarUsuarioTeste("b", "supervisor");
  criados.push(a, b);
  checar("usuário A (analista) autenticado", Boolean(a.token));
  checar("usuário B (supervisor) autenticado", Boolean(b.token));

  const clienteA = clienteDoUsuario(a.token);
  const clienteB = clienteDoUsuario(b.token);

  console.log("\n\x1b[1m2. Conversas privadas\x1b[0m");
  const { data: convA, error: erroConvA } = await clienteA
    .from("conversas_agente")
    .insert({ usuario_id: a.id, titulo: "Conversa privada do A" })
    .select("id")
    .single();
  checar("A cria a própria conversa", !erroConvA && Boolean(convA));

  // A NÃO pode criar conversa em nome de B.
  const { error: erroFalsificar } = await clienteA
    .from("conversas_agente")
    .insert({ usuario_id: b.id, titulo: "Conversa forjada" });
  checar("A NÃO cria conversa em nome de B", Boolean(erroFalsificar));

  // B não enxerga a conversa de A — mesmo sendo supervisor.
  const { data: vistas } = await clienteB
    .from("conversas_agente")
    .select("id")
    .eq("id", convA.id);
  checar(
    "B (supervisor) NÃO vê a conversa de A — papel superior não abre exceção",
    (vistas ?? []).length === 0
  );

  // B também não consegue alterar.
  const { data: alterou } = await clienteB
    .from("conversas_agente")
    .update({ titulo: "invadido" })
    .eq("id", convA.id)
    .select("id");
  checar("B NÃO consegue renomear a conversa de A", (alterou ?? []).length === 0);

  console.log("\n\x1b[1m3. Mensagens seguem a propriedade da conversa\x1b[0m");
  const { error: erroMsgA } = await clienteA.from("mensagens_agente").insert({
    conversa_id: convA.id,
    papel: "usuario",
    conteudo: "Mensagem secreta do A",
  });
  checar("A escreve na própria conversa", !erroMsgA);

  const { data: msgsB } = await clienteB
    .from("mensagens_agente")
    .select("id")
    .eq("conversa_id", convA.id);
  checar("B NÃO lê mensagens da conversa de A", (msgsB ?? []).length === 0);

  const { error: erroMsgB } = await clienteB.from("mensagens_agente").insert({
    conversa_id: convA.id,
    papel: "usuario",
    conteudo: "Injetando na conversa alheia",
  });
  checar("B NÃO escreve na conversa de A", Boolean(erroMsgB));

  console.log("\n\x1b[1m4. Memória pessoal é isolada\x1b[0m");
  const { data: memA, error: erroMemA } = await clienteA
    .from("memorias_agente")
    .insert({
      tipo_memoria: "preferencia",
      escopo: "pessoal",
      usuario_id: a.id,
      titulo: "Prefiro respostas curtas",
      conteudo: "Responder de forma objetiva, sem rodeios.",
      criada_por: a.id,
    })
    .select("id")
    .single();
  checar("A cria memória pessoal", !erroMemA && Boolean(memA));

  const { data: memVistaB } = await clienteB
    .from("memorias_agente")
    .select("id")
    .eq("id", memA.id);
  checar("B NÃO vê a memória pessoal de A", (memVistaB ?? []).length === 0);

  console.log("\n\x1b[1m5. Aprovação de memória por papel\x1b[0m");
  const { data: empresa } = await admin.from("empresas").select("id").limit(1).maybeSingle();

  if (!empresa) {
    console.log("  (pulado: não há empresa cadastrada para vincular)");
  } else {
    const { data: memEmpresa, error: erroProp } = await clienteA
      .from("memorias_agente")
      .insert({
        tipo_memoria: "regra",
        escopo: "empresa",
        empresa_id: empresa.id,
        titulo: "Fechamento até o dia 5",
        conteudo: "A DRE fecha até o quinto dia útil.",
        criada_por: a.id,
      })
      .select("id")
      .single();
    checar("A (analista) propõe memória de empresa", !erroProp && Boolean(memEmpresa));

    // Analista não pode ativar.
    //
    // A RLS não devolve erro: a política de UPDATE simplesmente não deixa a
    // linha entrar no escopo, então o comando afeta 0 linhas silenciosamente.
    // Por isso verificamos o ESTADO RESULTANTE, e não a presença de erro —
    // esperar exceção aqui daria falso negativo.
    await clienteA
      .from("memorias_agente")
      .update({ status: "ativa", aprovada_por: a.id, aprovada_em: new Date().toISOString() })
      .eq("id", memEmpresa.id);

    const { data: aposTentativaA } = await admin
      .from("memorias_agente")
      .select("status")
      .eq("id", memEmpresa.id)
      .single();
    checar(
      "A (analista) NÃO ativa memória de empresa (segue pendente)",
      aposTentativaA?.status !== "ativa"
    );

    // Supervisor pode.
    const { data: ativada, error: erroAtivarB } = await clienteB
      .from("memorias_agente")
      .update({ status: "ativa", aprovada_por: b.id, aprovada_em: new Date().toISOString() })
      .eq("id", memEmpresa.id)
      .select("status")
      .maybeSingle();
    checar(
      "B (supervisor) ativa a memória de empresa",
      !erroAtivarB && ativada?.status === "ativa"
    );

    // Depois de ativa, A passa a enxergar.
    const { data: visivelParaA } = await clienteA
      .from("memorias_agente")
      .select("id")
      .eq("id", memEmpresa.id);
    checar("memória de empresa ATIVA fica visível para a equipe", (visivelParaA ?? []).length === 1);
  }

  console.log("\n\x1b[1m6. Usuário desativado perde acesso\x1b[0m");
  await admin.from("perfis_usuarios").update({ ativo: false }).eq("usuario_id", a.id);
  const { data: aposDesativar } = await clienteA.from("memorias_agente").select("id").limit(5);
  checar(
    "usuário desativado não lê memórias",
    (aposDesativar ?? []).length === 0
  );
  const { data: convPreservadas } = await admin
    .from("conversas_agente")
    .select("id")
    .eq("usuario_id", a.id);
  checar(
    "histórico do desativado é PRESERVADO no banco",
    (convPreservadas ?? []).length > 0
  );
} catch (e) {
  falhas++;
  console.log(vermelho(`\nErro: ${e.message}`));
} finally {
  console.log("\n\x1b[1m7. Limpeza\x1b[0m");
  for (const u of criados) {
    await admin.from("memorias_agente").delete().eq("criada_por", u.id);
    await admin.from("conversas_agente").delete().eq("usuario_id", u.id);
    await admin.from("perfis_usuarios").delete().eq("usuario_id", u.id);
    await admin.auth.admin.deleteUser(u.id);
  }
  const { data: sobraram } = await admin
    .from("perfis_usuarios")
    .select("nome")
    .like("nome", "Teste Isolamento%");
  console.log(
    `  usuários de teste removidos; resíduo: ${(sobraram ?? []).length}`
  );
}

console.log();
if (falhas === 0) { console.log(verde("=== ISOLAMENTO: TUDO PASSOU ===")); process.exit(0); }
else { console.log(vermelho(`=== ${falhas} FALHA(S) ===`)); process.exit(1); }
