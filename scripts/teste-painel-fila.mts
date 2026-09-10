/**
 * Ensaio do caminho do PAINEL, de ponta a ponta, contra o banco real.
 *
 * Faz exatamente o que as rotas de `/api/painel/*` fazem, na mesma ordem e com
 * as mesmas funções:
 *
 *   arquivo no disco -> Storage -> anexo -> analisarDocumentos (modelo real)
 *   -> proposta -> enfileirarArquivamento -> fila
 *
 * Existe porque a tela precisa de sessão de navegador, e o que se quer provar
 * aqui é o MOTOR, não o clique. O worker Python consome a fila depois.
 *
 * PADRÃO É SIMULAÇÃO: sem `--aplicar` nada sobe e nada é enfileirado.
 *
 * Uso:
 *   node --conditions=react-server --import tsx scripts/teste-painel-fila.mts
 *   node --conditions=react-server --import tsx scripts/teste-painel-fila.mts -- --aplicar
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.loadEnvFile(".env");
process.loadEnvFile(".env.local");

const aplicar = process.argv.includes("--aplicar");

const verde = (s: string) => `\x1b[32m${s}\x1b[0m`;
const vermelho = (s: string) => `\x1b[31m${s}\x1b[0m`;
const amarelo = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cinza = (s: string) => `\x1b[90m${s}\x1b[0m`;
const negrito = (s: string) => `\x1b[1m${s}\x1b[0m`;

const { supabaseAdmin } = await import("../lib/supabase-admin");
const { salvarArquivo } = await import("../lib/file-store");
const { calcularHashSha256 } = await import("../lib/documentos/inspecao");
const { registrarAnexo } = await import("../lib/repositorios/anexos");
const { analisarDocumentos } = await import("../lib/arquivador/analise");
const { portasAnalisePadrao } = await import("../lib/arquivador/portas-analise");
const { enfileirarArquivamento } = await import("../lib/arquivador/fila");
const { criarOuReutilizarConversa } = await import("../lib/repositorios/conversas");
const { extensaoSuportada } = await import("../lib/file-extract");

// Documentos reais de um cliente real, na pasta que o usuário indicou.
const ORIGEM = String.raw`C:\Users\user\Desktop\ARC\TL`;
const USUARIO = process.env.TESTE_USUARIO_ID ?? "";

if (!USUARIO) {
  console.error("Defina TESTE_USUARIO_ID com o usuario_id de perfis_usuarios.");
  process.exit(1);
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".ofx": "text/plain",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".txt": "text/plain",
};

console.log(`\n${negrito("Ensaio do painel — motor de arquivamento")}`);
console.log(`  origem:  ${ORIGEM}`);
console.log(`  usuário: ${USUARIO}`);
console.log(`  modo:    ${aplicar ? vermelho("APLICAR (sobe e enfileira)") : amarelo("SIMULAÇÃO")}\n`);

// Mesmo filtro da rota /api/upload: o painel não deixa subir o que a
// extração não sabe ler, então o ensaio não pode deixar também.
const todos = fs.readdirSync(ORIGEM);
const arquivos = todos.filter(extensaoSuportada).map((n) => path.join(ORIGEM, n));
const recusados = todos.filter((n) => !extensaoSuportada(n));

if (!arquivos.length) {
  console.error(`Nenhum arquivo suportado em ${ORIGEM}.`);
  process.exit(1);
}

console.log(`${negrito("1. Arquivos encontrados")}`);
for (const a of arquivos) {
  console.log(`  ${path.basename(a)}  ${cinza(`${fs.statSync(a).size.toLocaleString()} bytes`)}`);
}

if (recusados.length) {
  console.log(`
${negrito("Recusados no upload")} ${cinza("(a extração não lê estes formatos)")}`);
  for (const n of recusados) console.log(`  ${amarelo("—")} ${n}`);
}

if (!aplicar) {
  console.log(`\n  ${amarelo("SIMULAÇÃO")} nada subiu. Repita com -- --aplicar\n`);
  process.exit(0);
}

// --- 2. Sessão -------------------------------------------------------------
const conversa = await criarOuReutilizarConversa(USUARIO, "Ensaio do painel em lote");
if (!conversa.ok) {
  console.error("Não foi possível abrir a conversa.");
  process.exit(1);
}
const conversaId = conversa.dados.id;
console.log(`\n${negrito("2. Sessão")}\n  conversa ${conversaId}`);

// --- 3. Upload + anexo (o que /api/upload faz) ------------------------------
console.log(`\n${negrito("3. Storage e anexos")}`);
const anexoIds: string[] = [];
for (const caminho of arquivos) {
  const nome = path.basename(caminho);
  const buffer = fs.readFileSync(caminho);
  const arquivoId = randomUUID();
  const mime = MIME[path.extname(nome).toLowerCase()];
  await salvarArquivo(arquivoId, nome, buffer, mime);
  const anexo = await registrarAnexo({
    arquivoId,
    usuarioId: USUARIO,
    conversaId,
    nomeOriginal: nome,
    tamanhoBytes: buffer.length,
    mimeType: mime,
    hashSha256: calcularHashSha256(buffer),
  });
  anexoIds.push(anexo.id);
  console.log(`  ${verde("OK")}  ${nome}`);
}

// --- 4. Análise (o que /api/painel/analisar faz) ----------------------------
console.log(`\n${negrito("4. Análise")} ${cinza("(usa a API da OpenAI — tem custo)")}`);
const resultado = await analisarDocumentos(
  { anexoIds, conversaId },
  USUARIO,
  portasAnalisePadrao()
);

if (!resultado.ok) {
  console.error(vermelho(`  ${resultado.erro} (${resultado.codigo})`));
  process.exit(1);
}

const proposta = resultado.proposta;
console.log(
  `  proposta ${proposta.propostaId}  ${cinza(
    `${proposta.resumo.prontos} pronto(s), ${proposta.resumo.incompletos} incompleto(s), ${proposta.resumo.bloqueados} bloqueado(s)`
  )}\n`
);

for (const item of proposta.itens) {
  const marca = item.caminhoSugerido ? verde("PRONTO  ") : amarelo("PENDENTE");
  console.log(`  ${marca} ${item.nomeOriginal}`);
  console.log(
    `           empresa: ${item.empresa.rotulo ?? "—"} (${item.empresa.confianca})` +
      `  competência: ${item.competencia.valor ?? "—"} (${item.competencia.confianca})`
  );
  console.log(
    `           tipo: ${item.tipoDocumento.valor ?? "—"}  instituição: ${item.instituicao.valor ?? "—"}`
  );
  if (item.caminhoSugerido) console.log(`           ${cinza(item.caminhoSugerido)}`);
  if (item.camposFaltantes.length) console.log(`           falta: ${item.camposFaltantes.join(", ")}`);
  for (const c of item.conflitos) console.log(`           ${amarelo(c.motivo)}`);
  if (item.possivelDuplicata) console.log(`           ${cinza(`já existe: ${item.possivelDuplicata.nome}`)}`);
}

// --- 5. Confirmação (o que /api/painel/confirmar faz) -----------------------
const prontos = proposta.itens.filter((i) => i.caminhoSugerido).map((i) => i.anexoId);
if (!prontos.length) {
  console.log(`\n  ${amarelo("Nenhum item pronto. Nada foi enfileirado.")}\n`);
  process.exit(0);
}

console.log(`\n${negrito("5. Confirmação")}`);
const fila = await enfileirarArquivamento(
  { propostaId: proposta.propostaId, anexosConfirmados: prontos, confirmar: true },
  USUARIO,
  conversaId
);
for (const i of fila.itens) console.log(`  ${verde("NA FILA")} ${i.nome_original}  ${cinza(i.id)}`);

console.log(`\n  Agora rode o worker no PC:`);
console.log(`  ${negrito("cd Mini-Sistemas/arquivador_docs && python -m arquivador.worker")}\n`);

const { count } = await supabaseAdmin
  .from("fila_arquivamento")
  .select("id", { count: "exact", head: true })
  .eq("status", "pendente");
console.log(`  pendentes na fila agora: ${count}\n`);
