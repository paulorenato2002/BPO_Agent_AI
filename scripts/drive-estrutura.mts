/**
 * Confere (e opcionalmente cria) a estrutura fixa de pastas no Google Drive.
 *
 * Usa o MESMO resolvedor da aplicação, de propósito: reimplementar a lógica de
 * idempotência aqui seria criar uma segunda versão para divergir da primeira.
 *
 * Só monta as pastas INTERNAS — as que não dependem de cliente nem de
 * competência. Pastas de empresa/ano/competência nascem sob demanda, no
 * arquivamento, porque criá-las todas de antemão encheria o Drive de pastas
 * vazias para clientes que talvez nunca mandem documento naquele mês.
 *
 * PADRÃO É SIMULAÇÃO. Sem `--aplicar`, nada é criado: o script mostra o que
 * faria. Isso é o Drive de produção — o efeito colateral tem que ser pedido.
 *
 * Uso:
 *   npm run drive:estrutura              # simula, não altera nada
 *   npm run drive:estrutura -- --aplicar # cria de verdade
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RegraArquivamento } from "../lib/arquivador/caminhos";

const raizProjeto = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// .env.local tem precedência sobre .env — é onde ficam os segredos locais.
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
const amarelo = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cinza = (s: string) => `\x1b[90m${s}\x1b[0m`;
const negrito = (s: string) => `\x1b[1m${s}\x1b[0m`;

const aplicar = process.argv.includes("--aplicar");

// Importados depois do .env: supabase-admin valida credenciais já na carga.
const { supabaseAdmin } = await import("../lib/supabase-admin");
const { expandirDestino } = await import("../lib/arquivador/caminhos");
const { resolverArvore } = await import("../lib/arquivador/resolvedor-pastas");
const { googleDrive } = await import("../lib/storage/google-drive");

function sair(mensagem: string, codigo = 1): never {
  console.log(`\n${vermelho("✗")} ${mensagem}\n`);
  process.exit(codigo);
}

// 1. Integração está de pé? --------------------------------------------------
console.log(negrito("\n1. Conferindo a integração"));

const saude = await googleDrive.healthCheck();
if (!saude.configurado) {
  sair(
    "Google Drive não configurado.\n" +
      "  Conecte em http://localhost:3000/integracoes/google-drive e rode `npm run drive:bootstrap`."
  );
}
if (!saude.disponivel) {
  sair(`Drive configurado mas inacessível: ${saude.detalhe}`);
}
console.log(`  ${verde("OK")}   raiz acessível — ${saude.detalhe}`);

// 2. Regras internas ---------------------------------------------------------
console.log(negrito("\n2. Lendo as regras internas"));

const { data: regras, error } = await supabaseAdmin
  .from("regras_arquivamento")
  .select(
    "id,codigo,nome,escopo,caminho_modelo,padrao_nome," +
      "exige_empresa,exige_competencia,exige_instituicao,projeto,subcategoria"
  )
  .eq("escopo", "interno")
  .eq("ativo", true)
  .order("codigo");

if (error) sair(`Falha ao ler regras_arquivamento: ${error.message}`);
if (!regras || regras.length === 0) {
  sair("Nenhuma regra interna ativa. A migration do arquivador foi aplicada neste projeto?");
}
console.log(`  ${verde("OK")}   ${regras.length} regras internas ativas`);

// 3. Expandir cada regra em uma árvore ---------------------------------------
console.log(negrito("\n3. Caminhos a garantir"));

const arvores: { codigo: string; segmentos: ReturnType<typeof expandirDestino> }[] = [];

for (const regra of regras as unknown as RegraArquivamento[]) {
  const destino = expandirDestino(regra, {});
  if (!destino.ok) {
    sair(`A regra ${regra.codigo} não expandiu: ${destino.erro}`);
  }
  arvores.push({ codigo: regra.codigo, segmentos: destino });
  console.log(`  ${cinza("·")}    ${destino.caminhoLogico}`);
}

// 4. Resolver ----------------------------------------------------------------
if (!aplicar) {
  console.log(negrito("\n4. Simulação"));
  console.log(
    `  ${amarelo("SIMULACAO")} nada foi criado.\n` +
      `  Para criar de verdade: ${negrito("npm run drive:estrutura -- --aplicar")}\n`
  );
  process.exit(0);
}

console.log(negrito("\n4. Garantindo as pastas no Drive"));

let criadas = 0;
let reaproveitadas = 0;
let falhas = 0;

for (const arvore of arvores) {
  if (!arvore.segmentos.ok) continue;

  const r = await resolverArvore(arvore.segmentos.segmentos, { criar: true });

  if (!r.ok) {
    falhas++;
    console.log(`  ${vermelho("FALHA")} ${arvore.codigo} — ${r.erro}`);
    continue;
  }

  for (const pasta of r.pastas) {
    if (pasta.criada) criadas++;
    else reaproveitadas++;
  }

  const novas = r.pastas.filter((p) => p.criada).length;
  const marca = novas > 0 ? verde("CRIADA") : cinza("existe");
  console.log(`  ${marca} ${r.folha.caminhoLogico}`);
}

// 5. Resumo ------------------------------------------------------------------
console.log(negrito("\n5. Resumo"));
console.log(`  pastas criadas nesta execução: ${criadas}`);
console.log(`  pastas que já existiam:        ${reaproveitadas}`);

if (falhas > 0) {
  console.log(`  ${vermelho(`falhas: ${falhas}`)}\n`);
  process.exit(1);
}

console.log(`\n${verde("=== ESTRUTURA GARANTIDA ===")}\n`);
