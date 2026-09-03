/**
 * Exporta as regras de arquivamento e a estrutura fixa para um JSON.
 *
 * Por que existe: o mini-sistema de arquivamento roda em Python, na máquina
 * do operador, e pode ser chamado pelo n8n. Fazer ele carregar credencial do
 * Supabase só para ler configuração seria acoplamento caro e um segredo a
 * mais circulando. Ele lê este JSON.
 *
 * O BANCO continua sendo a fonte de verdade: este arquivo é uma cópia
 * derivada, regerada por este script sempre que uma regra mudar.
 *
 * Uso: npm run exportar:regras
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
const negrito = (s: string) => `\x1b[1m${s}\x1b[0m`;

const { supabaseAdmin } = await import("../lib/supabase-admin");

const destino = path.resolve(
  raizProjeto,
  "Mini-Sistemas",
  "arquivador_docs",
  "dados",
  "regras.json"
);

console.log(negrito("\nExportando configuração do arquivador\n"));

const { data: regras, error: erroRegras } = await supabaseAdmin
  .from("regras_arquivamento")
  .select(
    "codigo,nome,escopo,caminho_modelo,padrao_nome," +
      "exige_empresa,exige_competencia,exige_instituicao,projeto,subcategoria"
  )
  .eq("ativo", true)
  .order("escopo")
  .order("codigo");

if (erroRegras) {
  console.error(`Falha ao ler regras: ${erroRegras.message}`);
  process.exit(1);
}

const { data: estrutura, error: erroEstrutura } = await supabaseAdmin
  .from("estrutura_fixa_drive")
  .select("chave,caminho_modelo,descricao,ordem")
  .eq("ativo", true)
  .order("ordem");

if (erroEstrutura) {
  console.error(`Falha ao ler estrutura fixa: ${erroEstrutura.message}`);
  process.exit(1);
}

const conteudo = {
  _aviso:
    "ARQUIVO GERADO. Não edite à mão — regenere com `npm run exportar:regras` " +
    "no projeto Agente BPO. A fonte de verdade é o banco.",
  geradoEm: new Date().toISOString(),
  regras: regras ?? [],
  estrutura_fixa: estrutura ?? [],
};

fs.mkdirSync(path.dirname(destino), { recursive: true });
fs.writeFileSync(destino, JSON.stringify(conteudo, null, 2) + "\n", "utf8");

console.log(`  ${verde("OK")}   ${conteudo.regras.length} regras`);
console.log(`  ${verde("OK")}   ${conteudo.estrutura_fixa.length} pastas fixas`);
console.log(`\n  destino: ${destino}\n`);
