/**
 * Verifica, contra o banco REAL, se a migration do arquivador foi aplicada.
 *
 * Existe porque "rodou sem erro no SQL Editor" não é prova: já aconteceu de a
 * migration ser executada no projeto Supabase errado. Este script confere o
 * estado no MESMO projeto que a aplicação usa, lendo o .env.
 *
 * É só leitura — não cria, não altera e não apaga nada.
 *
 * Uso: npm run verificar:arquivador
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const linha of fs.readFileSync(path.join(raiz, ".env"), "utf8").split(/\r?\n/)) {
  const m = linha.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { createClient } = await import("@supabase/supabase-js");

const verde = (s) => `\x1b[32m${s}\x1b[0m`;
const vermelho = (s) => `\x1b[31m${s}\x1b[0m`;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const anon = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

let ok = 0;
let falhas = 0;
function check(condicao, msg, detalhe = "") {
  if (condicao) {
    ok++;
    console.log(verde("  OK   ") + msg);
  } else {
    falhas++;
    console.log(vermelho("  FALHA") + " " + msg + (detalhe ? ` — ${detalhe}` : ""));
  }
}

console.log(`\nprojeto: ${(url.match(/https:\/\/([a-z0-9]+)\./) || [])[1]}\n`);

// 1. As três tabelas do arquivador existem.
for (const t of ["regras_arquivamento", "pastas_drive", "propostas_arquivamento"]) {
  const { error } = await admin.from(t).select("*", { count: "exact", head: true });
  check(!error, `tabela ${t} existe`, error?.message);
}

// 2. As regras foram semeadas na distribuição esperada.
const { data: regras, error: erroRegras } = await admin
  .from("regras_arquivamento")
  .select("codigo,escopo,caminho_modelo,padrao_nome,exige_empresa,exige_competencia")
  // Só as ATIVAS. As antigas continuam na tabela para não cortar o vínculo
  // com documentos já arquivados por elas.
  .eq("ativo", true);

if (erroRegras) {
  check(false, "leitura de regras_arquivamento", erroRegras.message);
} else {
  // A estrutura do cliente foi simplificada para ano/competência: 6 regras
  // internas + 1 de cliente. As antigas continuam na tabela, desativadas,
  // porque documentos já arquivados apontam para elas.
  check(regras.length === 7, "7 regras ativas", `achei ${regras.length}`);

  const porEscopo = {};
  for (const r of regras) porEscopo[r.escopo] = (porEscopo[r.escopo] ?? 0) + 1;

  for (const [escopo, esperado] of [
    ["interno", 6],
    ["mensal", 1],
  ]) {
    check(porEscopo[escopo] === esperado, `${esperado} regra(s) de escopo "${escopo}"`,
      `achei ${porEscopo[escopo] ?? 0}`);
  }

  const cliente = regras.find((r) => r.codigo === "CLIENTE_DOCUMENTO");
  check(Boolean(cliente), "a regra única de cliente existe");
  if (cliente) {
    check(
      JSON.stringify(cliente.caminho_modelo) === JSON.stringify(["{ANO}", "{COMPETENCIA}"]),
      "documento de cliente vai só para ano/competência",
      JSON.stringify(cliente.caminho_modelo)
    );
  }

  // Nenhuma regra de cliente ativa pode ter subpasta de categoria: o tipo do
  // documento vive no NOME agora.
  const comCategoria = regras.filter(
    (r) => r.escopo !== "interno" && r.caminho_modelo.length > 2
  );
  check(comCategoria.length === 0, "nenhuma regra de cliente cria subpasta de categoria",
    comCategoria.map((r) => r.codigo).join(", "));

  // Invariantes de negócio — o seed pode estar completo e ainda assim errado.
  const internasComEmpresa = regras.filter((r) => r.escopo === "interno" && r.exige_empresa);
  check(internasComEmpresa.length === 0, "nenhuma regra interna exige empresa",
    internasComEmpresa.map((r) => r.codigo).join(", "));

  const mensaisSemCompetencia = regras.filter((r) => r.escopo === "mensal" && !r.exige_competencia);
  check(mensaisSemCompetencia.length === 0, "toda regra mensal exige competência",
    mensaisSemCompetencia.map((r) => r.codigo).join(", "));

  const semPlaceholder = regras.filter(
    (r) =>
      ["mensal", "projeto"].includes(r.escopo) &&
      !JSON.stringify(r.caminho_modelo).includes("{COMPETENCIA}")
  );
  check(semPlaceholder.length === 0, "regra de cliente usa {COMPETENCIA} no caminho",
    semPlaceholder.map((r) => r.codigo).join(", "));

  // {EMPRESA} no nome era desperdício: a pasta do cliente já está no caminho,
  // e o caminho do Windows é curto.
  const comEmpresaNoNome = regras.filter((r) => r.padrao_nome.includes("{EMPRESA}"));
  check(comEmpresaNoNome.length === 0, "nenhum padrão de nome repete a empresa",
    comEmpresaNoNome.map((r) => r.codigo).join(", "));
}

// 2b. Estrutura fixa do Drive.
const { data: fixas, error: erroFixas } = await admin
  .from("estrutura_fixa_drive")
  .select("chave,caminho_modelo")
  .eq("ativo", true);

if (erroFixas) {
  check(false, "leitura de estrutura_fixa_drive", erroFixas.message);
} else {
  check(fixas.length === 9, "9 pastas fixas cadastradas", `achei ${fixas.length}`);

  const chaves = new Set(fixas.map((f) => f.chave));
  for (const obrigatoria of ["clientes_ativos", "clientes_inativos", "interno_raiz"]) {
    check(chaves.has(obrigatoria), `estrutura fixa "${obrigatoria}" existe`);
  }

  // Estrutura fixa é criada antes de existir competência: um {ANO} aqui
  // viraria uma pasta chamada literalmente "{ANO}".
  const comPlaceholder = fixas.filter((f) => JSON.stringify(f.caminho_modelo).includes("{"));
  check(comPlaceholder.length === 0, "nenhuma pasta fixa usa placeholder",
    comPlaceholder.map((f) => f.chave).join(", "));

  // Toda regra interna precisa de pasta na estrutura fixa; senão o bootstrap
  // não a cria e o erro só aparece no primeiro arquivamento.
  if (!erroRegras) {
    const caminhosFixos = new Set(fixas.map((f) => f.caminho_modelo.join("/")));
    const descobertas = regras
      .filter((r) => r.escopo === "interno")
      .filter((r) => !caminhosFixos.has(r.caminho_modelo.join("/")));
    check(descobertas.length === 0, "toda regra interna tem pasta na estrutura fixa",
      descobertas.map((r) => r.codigo).join(", "));
  }
}

// 3. As colunas de classificação entraram em documentos_operacionais.
// Uma a uma: um select com tudo junto só reporta a PRIMEIRA coluna ausente,
// escondendo as demais.
const COLUNAS_CLASSIFICACAO = [
  "instituicao",
  "projeto",
  "subcategoria",
  "regra_arquivamento_id",
  "nome_final",
  "caminho_logico",
  "evidencias",
  "classificacao_sugerida",
  "classificacao_confirmada",
  "confirmado_por",
  "confirmado_em",
  "proposta_id",
];

const ausentes = [];
for (const coluna of COLUNAS_CLASSIFICACAO) {
  const { error } = await admin
    .from("documentos_operacionais")
    .select(`id,${coluna}`)
    .limit(1);
  if (error) ausentes.push(coluna);
}
check(ausentes.length === 0,
  `documentos_operacionais tem as ${COLUNAS_CLASSIFICACAO.length} colunas de classificação`,
  ausentes.length ? `faltam: ${ausentes.join(", ")}` : "");

// 4. anon continua sem enxergar nada disso.
for (const t of [
  "regras_arquivamento",
  "pastas_drive",
  "propostas_arquivamento",
  "estrutura_fixa_drive",
]) {
  const { data, error } = await anon.from(t).select("*").limit(1);
  check(error !== null || (data ?? []).length === 0, `anon NÃO lê ${t}`,
    error ? "" : `retornou ${data.length} linha(s)`);
}

console.log(`\n  ${ok} ok, ${falhas} falha(s)\n`);
process.exit(falhas > 0 ? 1 : 0);
