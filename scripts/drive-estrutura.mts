/**
 * Confere (e opcionalmente cria) a estrutura fixa de pastas no Google Drive.
 *
 * Usa o MESMO resolvedor da aplicação, de propósito: reimplementar a lógica de
 * idempotência aqui seria criar uma segunda versão para divergir da primeira.
 *
 * A estrutura vem de `estrutura_fixa_drive`, não das regras de arquivamento.
 * São perguntas diferentes: a regra diz onde vai um documento de uma classe;
 * a estrutura fixa diz quais pastas precisam existir antes de qualquer
 * documento chegar. 01_CLIENTES_ATIVOS é o exemplo — precisa existir, mas
 * nunca recebe documento direto.
 *
 * NENHUMA pasta de empresa, ano, competência ou projeto é criada aqui. Essas
 * nascem sob demanda no arquivamento; criá-las de antemão encheria o Drive de
 * pastas vazias de clientes que talvez nunca mandem documento naquele mês.
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
const { expandirDestino, segmentosEstruturais } = await import("../lib/arquivador/caminhos");
const { listarEstruturaFixa } = await import("../lib/arquivador/estrutura-fixa");
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
if (!saude.disponivel) sair(`Drive configurado mas inacessível: ${saude.detalhe}`);
console.log(`  ${verde("OK")}   raiz acessível — ${saude.detalhe}`);

// 2. Estrutura fixa cadastrada -----------------------------------------------
console.log(negrito("\n2. Lendo a estrutura fixa"));

const estrutura = await listarEstruturaFixa().catch((e: unknown) => {
  const detalhe = e instanceof Error ? e.message : String(e);
  // Quem roda isto precisa saber o que FAZER, não ler um stack trace.
  sair(
    `${detalhe}\n\n` +
      "  Aplique a migration abaixo no SQL Editor do projeto e rode de novo:\n" +
      "    supabase/migrations/20260829100000_estrutura_fixa_drive.sql\n\n" +
      "  Confira que o SQL Editor está no projeto certo — rode `npm run verificar:arquivador`."
  );
});

if (estrutura.length === 0) {
  sair(
    "A tabela estrutura_fixa_drive existe mas está vazia.\n" +
      "  O bloco de seed da migration não rodou. Reaplique o arquivo inteiro."
  );
}
console.log(`  ${verde("OK")}   ${estrutura.length} pastas fixas cadastradas`);

// 3. Trava contra divergência ------------------------------------------------
//
// As regras internas apontam para pastas dentro de 00_INTERNO. Se alguém
// cadastrar uma regra interna nova e esquecer a estrutura fixa, o bootstrap
// não criaria a pasta e o erro só apareceria no primeiro arquivamento.
console.log(negrito("\n3. Conferindo regras internas contra a estrutura fixa"));

const { data: regrasInternas, error: erroRegras } = await supabaseAdmin
  .from("regras_arquivamento")
  .select(
    "id,codigo,nome,escopo,caminho_modelo,padrao_nome," +
      "exige_empresa,exige_competencia,exige_instituicao,projeto,subcategoria"
  )
  .eq("escopo", "interno")
  .eq("ativo", true)
  .order("codigo");

if (erroRegras) sair(`Falha ao ler regras_arquivamento: ${erroRegras.message}`);

const caminhosFixos = new Set(estrutura.map((e) => e.caminho_modelo.join("/")));
const descobertas: string[] = [];

for (const regra of (regrasInternas ?? []) as unknown as RegraArquivamento[]) {
  const destino = expandirDestino(regra, {});
  if (!destino.ok) sair(`A regra ${regra.codigo} não expandiu: ${destino.erro}`);
  if (!caminhosFixos.has(destino.caminhoLogico)) descobertas.push(destino.caminhoLogico);
}

if (descobertas.length > 0) {
  sair(
    "Estas regras internas apontam para pastas que NÃO estão em estrutura_fixa_drive:\n" +
      descobertas.map((c) => `    ${c}`).join("\n") +
      "\n  Cadastre-as na estrutura fixa antes de continuar."
  );
}
console.log(`  ${verde("OK")}   ${(regrasInternas ?? []).length} regras internas cobertas`);

// 4. Caminhos a garantir -----------------------------------------------------
console.log(negrito("\n4. Caminhos a garantir"));
for (const pasta of estrutura) {
  console.log(`  ${cinza("·")}    ${pasta.caminho_modelo.join("/")}  ${cinza(pasta.chave)}`);
}

if (!aplicar) {
  console.log(negrito("\n5. Simulação"));
  console.log(
    `  ${amarelo("SIMULACAO")} nada foi criado.\n` +
      `  Para criar de verdade: ${negrito("npm run drive:estrutura -- --aplicar")}\n`
  );
  process.exit(0);
}

// 5. Resolver ----------------------------------------------------------------
console.log(negrito("\n5. Garantindo as pastas no Drive"));

let criadas = 0;
let reaproveitadas = 0;
let falhas = 0;

for (const pasta of estrutura) {
  const segmentos = segmentosEstruturais(pasta.caminho_modelo);
  const r = await resolverArvore(segmentos, { criar: true });

  if (!r.ok) {
    falhas++;
    console.log(`  ${vermelho("FALHA")} ${pasta.chave} — ${r.erro}`);
    continue;
  }

  for (const p of r.pastas) {
    if (p.criada) criadas++;
    else reaproveitadas++;
  }

  const novas = r.pastas.filter((p) => p.criada).length;
  const marca = novas > 0 ? verde("CRIADA") : cinza("existe");
  console.log(`  ${marca} ${r.folha.caminhoLogico}  ${cinza(r.folha.externalId)}`);
}

// 6. Resumo ------------------------------------------------------------------
console.log(negrito("\n6. Resumo"));
console.log(`  pastas criadas nesta execução: ${criadas}`);
console.log(`  pastas que já existiam:        ${reaproveitadas}`);

if (falhas > 0) {
  console.log(`  ${vermelho(`falhas: ${falhas}`)}\n`);
  process.exit(1);
}

console.log(`\n${verde("=== ESTRUTURA GARANTIDA ===")}\n`);
