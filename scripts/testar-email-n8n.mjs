// Valida a migration da caixa de entrada em Postgres isolado, sem .env nem rede.
import { PGlite } from "../.teste-sql-runtime/node_modules/@electric-sql/pglite/dist/index.js";
import { readFile } from "node:fs/promises";

const db = new PGlite();
try {
  const baseline = (await readFile("supabase/baseline/0000_baseline_existente_TESTE.sql", "utf8"))
    .replace("create extension if not exists pgcrypto;", "");
  const migration = await readFile(
    "supabase/migrations/20260917173000_email_eventos_n8n.sql",
    "utf8"
  );
  await db.exec(baseline);
  await db.exec(migration);
  await db.exec(migration);

  await db.query(
    `insert into public.email_eventos
      (provedor_evento_id, conta_email, remetente, assunto, recebido_em)
     values ($1, $2, $3, $4, $5)`,
    ["msg-1", "effective.bpo@gmail.com", "cliente@example.com", "Teste", "2026-09-17T17:00:00Z"]
  );

  const dados = await db.query(`select count(*)::int as total from public.email_eventos`);
  if (dados.rows[0]?.total !== 1) throw new Error("evento não foi persistido");

  const rls = await db.query(
    `select relrowsecurity from pg_class where oid = 'public.email_eventos'::regclass`
  );
  if (rls.rows[0]?.relrowsecurity !== true) throw new Error("RLS não foi habilitado");

  const privilegios = await db.query(
    `select count(*)::int as total
       from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name = 'email_eventos'
        and grantee in ('anon', 'authenticated')`
  );
  if (privilegios.rows[0]?.total !== 0) throw new Error("papel web recebeu privilégio indevido");

  let duplicataBloqueada = false;
  try {
    await db.query(
      `insert into public.email_eventos
        (provedor_evento_id, conta_email, remetente, recebido_em)
       values ($1, $2, $3, $4)`,
      ["msg-1", "effective.bpo@gmail.com", "outro@example.com", "2026-09-17T18:00:00Z"]
    );
  } catch {
    duplicataBloqueada = true;
  }
  if (!duplicataBloqueada) throw new Error("ID repetido foi aceito");

  console.log("OK: email_eventos, idempotência, RLS e revogações validados sem rede.");
} finally {
  await db.close();
}
