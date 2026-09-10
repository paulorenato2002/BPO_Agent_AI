// Banco descartável em memória. Não lê .env nem conecta ao Supabase.
// Preparação: npm install --prefix .teste-sql-runtime --no-save --package-lock=false @electric-sql/pglite
import { PGlite } from "../.teste-sql-runtime/node_modules/@electric-sql/pglite/dist/index.js";
import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
const db = new PGlite();
try {
  // gen_random_uuid já é nativo; PGlite não distribui a extensão pgcrypto.
  const baseline = (await readFile("supabase/baseline/0000_baseline_existente_TESTE.sql", "utf8"))
    .replace("create extension if not exists pgcrypto;", "");
  await db.exec(baseline);
  for (const nome of (await readdir("supabase/migrations")).filter(n => n.endsWith(".sql")).sort()) {
    try { await db.exec(await readFile(`supabase/migrations/${nome}`, "utf8")); }
    catch (e) { throw new Error(`Migration ${nome}: ${e.message}`); }
  }
  await db.exec(await readFile("supabase/testes/teste_fila.sql", "utf8"));
  const r = await db.query("select status from public.fila_arquivamento");
  assert.equal(r.rows[0].status, "concluido");
  console.log("OK: migrations aplicadas; fila, retomada, isolamento, confirmação, conclusão e idempotência validados sem rede.");
} finally { await db.close(); }
