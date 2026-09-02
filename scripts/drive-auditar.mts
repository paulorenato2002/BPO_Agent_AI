/**
 * Auditoria INDEPENDENTE da estrutura no Drive.
 *
 * O `drive:estrutura` diz "existe" com base no que ele mesmo gravou. Isso é
 * a palavra dele, não prova. Aqui olhamos de fora e conferimos quatro coisas
 * que o outro script não pode atestar sobre si:
 *
 *   1. nenhuma pasta duplicada (mesmo nome, mesmo pai) no Drive;
 *   2. todo external_id de pastas_drive existe mesmo no Drive e não está na
 *      lixeira;
 *   3. tudo está confinado abaixo de GOOGLE_DRIVE_PASTA_RAIZ_ID;
 *   4. nenhuma pasta órfã pendente de revisão.
 *
 * Somente leitura. Não cria, não move, não apaga.
 *
 * Uso: npm run drive:auditar
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raizProjeto = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const arquivo of [".env", ".env.local"]) {
  const caminho = path.join(raizProjeto, arquivo);
  if (!fs.existsSync(caminho)) continue;
  for (const linha of fs.readFileSync(caminho, "utf8").split(/\r?\n/)) {
    const m = linha.match(/^([A-Za-z_0-9]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}

const verde = (s: string) => `\x1b[32m${s}\x1b[0m`;
const vermelho = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cinza = (s: string) => `\x1b[90m${s}\x1b[0m`;
const negrito = (s: string) => `\x1b[1m${s}\x1b[0m`;

const { supabaseAdmin } = await import("../lib/supabase-admin");
const { obterAccessToken, estaDentroDaRaiz } = await import("../lib/integracoes/google-oauth");

let ok = 0;
let falhas = 0;
function checar(condicao: boolean, msg: string, detalhe = "") {
  if (condicao) {
    ok++;
    console.log(`  ${verde("OK")}   ${msg}`);
  } else {
    falhas++;
    console.log(`  ${vermelho("FALHA")} ${msg}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

const RAIZ = process.env.GOOGLE_DRIVE_PASTA_RAIZ_ID!;
const API = "https://www.googleapis.com/drive/v3";

const auth = await obterAccessToken();
if (!auth.ok) {
  console.log(`\n${vermelho("✗")} ${auth.erro}\n`);
  process.exit(1);
}
const token = auth.accessToken;

async function drive(url: string): Promise<Record<string, unknown>> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return (await r.json()) as Record<string, unknown>;
}

// 1. Mapeamentos gravados ----------------------------------------------------
console.log(negrito("\n1. Mapeamentos em pastas_drive"));

const { data: linhas, error } = await supabaseAdmin
  .from("pastas_drive")
  .select("chave_logica,external_id,nome,caminho_logico,status,parent_external_id")
  .eq("provedor", "google_drive")
  .order("caminho_logico");

if (error) {
  console.log(`\n${vermelho("✗")} ${error.message}\n`);
  process.exit(1);
}

const ativas = (linhas ?? []).filter((l) => l.status === "ativa");
const orfas = (linhas ?? []).filter((l) => l.status === "substituida");

console.log(`  ${cinza("·")}    ${ativas.length} pastas ativas, ${orfas.length} órfãs`);
checar(orfas.length === 0, "nenhuma pasta órfã pendente de revisão",
  orfas.map((o) => o.external_id).join(", "));

// IDs únicos: duas chaves não podem apontar para a mesma pasta.
const idsUnicos = new Set(ativas.map((l) => l.external_id));
checar(idsUnicos.size === ativas.length,
  "cada pasta do Drive é mapeada por uma única chave",
  `${ativas.length} linhas, ${idsUnicos.size} ids distintos`);

// 2. Cada pasta existe mesmo, e não está na lixeira --------------------------
console.log(negrito("\n2. Conferindo cada pasta no Drive"));

let sumiram = 0;
let naLixeira = 0;
for (const linha of ativas) {
  const meta = await drive(
    `${API}/files/${linha.external_id}?fields=id,name,trashed,mimeType&supportsAllDrives=true`
  );

  if (!meta.id) {
    sumiram++;
    console.log(`  ${vermelho("SUMIU")} ${linha.caminho_logico} (${linha.external_id})`);
    continue;
  }
  if (meta.trashed === true) {
    naLixeira++;
    console.log(`  ${vermelho("LIXEIRA")} ${linha.caminho_logico}`);
  }
}
checar(sumiram === 0, "todo external_id gravado existe no Drive", `${sumiram} sumiram`);
checar(naLixeira === 0, "nenhuma pasta mapeada está na lixeira", `${naLixeira} na lixeira`);

// 3. Confinamento sob a raiz -------------------------------------------------
console.log(negrito("\n3. Confinamento sob a pasta raiz"));

let fora = 0;
for (const linha of ativas) {
  const dentro = await estaDentroDaRaiz(token, linha.external_id, RAIZ);
  if (!dentro) {
    fora++;
    console.log(`  ${vermelho("FORA")} ${linha.caminho_logico} (${linha.external_id})`);
  }
}
checar(fora === 0, `todas as ${ativas.length} pastas estão abaixo da raiz`, `${fora} fora`);

// 4. Duplicatas no Drive -----------------------------------------------------
//
// Percorre a árvore a partir da raiz e procura irmãs de mesmo nome. É o
// defeito que o resolvedor existe para evitar, então é o que mais importa.
console.log(negrito("\n4. Procurando pastas duplicadas"));

async function filhos(paiId: string): Promise<{ id: string; name: string }[]> {
  const q = `'${paiId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const r = await drive(
    `${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=200` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true`
  );
  return (r.files ?? []) as { id: string; name: string }[];
}

const duplicadas: string[] = [];
const porVisitar = [{ id: RAIZ, caminho: "(raiz)" }];
let visitadas = 0;

while (porVisitar.length > 0) {
  const atual = porVisitar.pop()!;
  visitadas++;

  const lista = await filhos(atual.id);
  const vistos = new Map<string, number>();

  for (const f of lista) {
    vistos.set(f.name, (vistos.get(f.name) ?? 0) + 1);
    porVisitar.push({ id: f.id, caminho: `${atual.caminho}/${f.name}` });
  }

  for (const [nome, quantas] of vistos) {
    if (quantas > 1) duplicadas.push(`${atual.caminho}/${nome} (${quantas}x)`);
  }
}

checar(duplicadas.length === 0, `nenhuma pasta duplicada em ${visitadas} níveis visitados`,
  duplicadas.join(", "));

// 5. Resumo ------------------------------------------------------------------
console.log(negrito("\n5. Resumo"));
console.log(`  ${ok} ok, ${falhas} falha(s)\n`);
process.exit(falhas > 0 ? 1 : 0);
