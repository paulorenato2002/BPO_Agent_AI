// Asserções do aprendizado num Postgres em memória. Não lê .env nem rede.
// Preparação: npm install --prefix .teste-sql-runtime --no-save --package-lock=false @electric-sql/pglite
import { PGlite } from "../.teste-sql-runtime/node_modules/@electric-sql/pglite/dist/index.js";
import { readFile, readdir } from "node:fs/promises";

const db = new PGlite();
try {
  const baseline = (await readFile("supabase/baseline/0000_baseline_existente_TESTE.sql", "utf8"))
    .replace("create extension if not exists pgcrypto;", "");
  await db.exec(baseline);
  for (const nome of (await readdir("supabase/migrations")).filter((n) => n.endsWith(".sql")).sort()) {
    try {
      await db.exec(await readFile(`supabase/migrations/${nome}`, "utf8"));
    } catch (e) {
      throw new Error(`Migration ${nome}: ${e.message}`);
    }
  }

  // `\set` é meta-comando do psql; o runner em memória não o interpreta.
  const testes = (await readFile("supabase/testes/teste_aprendizado.sql", "utf8"))
    .replace(/^\\set .*$/gm, "");

  // PGlite não entrega `raise notice` ao cliente, então o detalhe de cada
  // asserção só aparece no `npm run test:migrations` (psql, via Docker). Aqui
  // vale o veredito: o bloco termina com `raise exception` se algo falhou,
  // e isso o runner enxerga.
  try {
    await db.exec(testes);
  } catch (e) {
    console.error(`FALHOU: ${e.message}`);
    console.error("Para ver qual asserção quebrou, rode: npm run test:migrations");
    process.exit(1);
  }
  console.log(
    "OK: aprendizado validado sem rede — conta aprendida, repetição, disputa recusada,"
  );
  console.log(
    "    item incompleto ignorado, layout compartilhado e reclassificação humana."
  );
} finally {
  await db.close();
}
