/**
 * Teste de CONEXÃO REAL com os provedores configurados.
 *
 * Diferente dos testes unitários (que usam mock), este script fala com os
 * serviços de verdade. Ele cria um arquivo temporário próprio, valida o ciclo
 * completo e APAGA tudo ao final — não deixa resíduo.
 *
 * Provedores sem credencial são reportados como "não configurado", não como
 * falha, e nenhum sucesso é simulado.
 *
 * Uso: node scripts/testar-conexoes-reais.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Carrega .env (o script roda fora do Next, então precisa fazer isso à mão).
for (const linha of fs.readFileSync(path.join(raiz, ".env"), "utf8").split(/\r?\n/)) {
  const m = linha.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { createClient } = await import("@supabase/supabase-js");

const verde = (s) => `\x1b[32m${s}\x1b[0m`;
const vermelho = (s) => `\x1b[31m${s}\x1b[0m`;
const amarelo = (s) => `\x1b[33m${s}\x1b[0m`;

let falhas = 0;
const ok = (m) => console.log(`  ${verde("OK")}   ${m}`);
const falha = (m) => { falhas++; console.log(`  ${vermelho("FALHA")} ${m}`); };
const aviso = (m) => console.log(`  ${amarelo("AVISO")} ${m}`);

console.log("\n\x1b[1m1. Supabase Storage (conexão real)\x1b[0m");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET_DOCUMENTOS ?? "documentos-operacionais";

if (!url || !chave) {
  aviso("Supabase não configurado — teste pulado.");
} else {
  const supabase = createClient(url, chave, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const caminho = `_teste_conexao/${randomUUID()}/arquivo.txt`;
  const conteudo = Buffer.from(`teste de conexao ${new Date().toISOString()}`);
  const hashEsperado = createHash("sha256").update(conteudo).digest("hex");

  try {
    // Bucket
    let { data: bucket } = await supabase.storage.getBucket(BUCKET);
    if (!bucket) {
      const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
      if (error && !/already exists/i.test(error.message)) throw error;
      ({ data: bucket } = await supabase.storage.getBucket(BUCKET));
    }
    if (bucket) ok(`bucket "${BUCKET}" acessível`); else falha("bucket não pôde ser criado/lido");

    if (bucket?.public === true) {
      falha("bucket está PÚBLICO — documentos sensíveis ficariam expostos");
    } else {
      ok("bucket é privado");
    }

    // Upload
    const { error: erroUpload } = await supabase.storage
      .from(BUCKET)
      .upload(caminho, conteudo, { contentType: "text/plain", upsert: false });
    if (erroUpload) falha(`upload: ${erroUpload.message}`);
    else ok("upload concluído");

    // Existência
    const pasta = caminho.slice(0, caminho.lastIndexOf("/"));
    const nome = caminho.slice(caminho.lastIndexOf("/") + 1);
    const { data: lista } = await supabase.storage.from(BUCKET).list(pasta, { search: nome });
    if ((lista ?? []).some((a) => a.name === nome)) ok("arquivo confirmado pelo provedor");
    else falha("arquivo não apareceu na listagem");

    // Não sobrescrever
    const { error: erroDup } = await supabase.storage
      .from(BUCKET)
      .upload(caminho, Buffer.from("outro"), { contentType: "text/plain", upsert: false });
    if (erroDup) ok("upload duplicado é rejeitado (não sobrescreve)");
    else falha("provedor aceitou sobrescrever silenciosamente");

    // Download + integridade
    const { data: baixado, error: erroDownload } = await supabase.storage
      .from(BUCKET)
      .download(caminho);
    if (erroDownload || !baixado) {
      falha(`download: ${erroDownload?.message ?? "vazio"}`);
    } else {
      const hashBaixado = createHash("sha256")
        .update(Buffer.from(await baixado.arrayBuffer()))
        .digest("hex");
      if (hashBaixado === hashEsperado) ok("download íntegro (hash confere)");
      else falha("conteúdo baixado difere do enviado");
    }

    // URL assinada
    const { data: assinada, error: erroUrl } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(caminho, 60);
    if (erroUrl || !assinada?.signedUrl) {
      falha(`URL assinada: ${erroUrl?.message ?? "não gerada"}`);
    } else {
      ok("URL assinada gerada");
      const r = await fetch(assinada.signedUrl);
      if (r.ok) ok("URL assinada funciona"); else falha(`URL assinada retornou HTTP ${r.status}`);
    }

    // Acesso anônimo deve ser negado
    const publica = `${url}/storage/v1/object/public/${BUCKET}/${caminho}`;
    const rPublica = await fetch(publica);
    if (rPublica.ok) falha("arquivo acessível publicamente sem autenticação!");
    else ok(`acesso público negado (HTTP ${rPublica.status})`);

    // Cópia
    const copia = caminho.replace("arquivo.txt", "copia.txt");
    const { error: erroCopia } = await supabase.storage.from(BUCKET).copy(caminho, copia);
    if (erroCopia) falha(`cópia: ${erroCopia.message}`);
    else ok("cópia entre caminhos funciona");

    // Limpeza
    const { error: erroRemocao } = await supabase.storage
      .from(BUCKET)
      .remove([caminho, copia]);
    if (erroRemocao) falha(`limpeza: ${erroRemocao.message}`);
    else ok("arquivos de teste removidos");
  } catch (e) {
    falha(`exceção: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log("\n\x1b[1m2. Google Drive (conexão real)\x1b[0m");
const faltandoDrive = [
  "GOOGLE_DRIVE_CLIENT_EMAIL",
  "GOOGLE_DRIVE_PRIVATE_KEY",
  "GOOGLE_DRIVE_PASTA_RAIZ_ID",
].filter((v) => !process.env[v]);

if (faltandoDrive.length > 0) {
  aviso(`não configurado — faltam: ${faltandoDrive.join(", ")}`);
  aviso("adapter implementado e coberto por testes com mock; conexão real NÃO validada");
} else {
  aviso("credenciais presentes — rode os testes de integração do Drive separadamente");
}

console.log();
if (falhas === 0) {
  console.log(verde("=== CONEXÕES REAIS: TUDO PASSOU ==="));
  process.exit(0);
} else {
  console.log(vermelho(`=== ${falhas} FALHA(S) ===`));
  process.exit(1);
}
