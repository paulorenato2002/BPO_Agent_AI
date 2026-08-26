/**
 * Gera um BASELINE do schema existente a partir do endpoint OpenAPI do PostgREST.
 *
 * ⚠️  USO EXCLUSIVO DE TESTE LOCAL. Este arquivo NUNCA deve ser aplicado ao
 * banco de produção — ele é uma reconstrução aproximada (colunas, tipos, PK, FK,
 * NOT NULL, defaults) usada apenas para que as migrations da camada operacional
 * possam ser aplicadas e testadas num Postgres descartável em Docker.
 *
 * Ele NÃO reproduz triggers, índices, RLS nem constraints CHECK do banco real.
 *
 * Uso:
 *   node scripts/gerar-baseline-teste.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raizProjeto = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function carregarEnv() {
  const env = {};
  const bruto = fs.readFileSync(path.join(raizProjeto, ".env"), "utf8");
  for (const linha of bruto.split(/\r?\n/)) {
    const m = linha.match(/^([A-Za-z_0-9]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** Traduz o `format` do OpenAPI de volta para o tipo Postgres. */
function tipoPostgres(meta) {
  const f = meta.format;
  if (f === "int32") return "integer";
  if (f === "int64") return "bigint";
  if (f === "character varying") return meta.maxLength ? `varchar(${meta.maxLength})` : "text";
  if (f === "character") return meta.maxLength ? `char(${meta.maxLength})` : "char(1)";
  return f || "text";
}

/** Defaults que dependem de objetos que não existem no baseline são descartados. */
function defaultSeguro(meta) {
  if (meta.default === undefined) return null;
  const d = String(meta.default);
  if (/nextval|::regclass/i.test(d)) return null;
  if (typeof meta.default === "boolean" || typeof meta.default === "number") return String(meta.default);
  if (/^(now\(\)|gen_random_uuid\(\)|CURRENT_)/i.test(d)) return d;
  if (/::/.test(d)) return d;
  return `'${d.replace(/'/g, "''")}'`;
}

const env = carregarEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes no .env");

const resposta = await fetch(`${url}/rest/v1/`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});
if (!resposta.ok) throw new Error(`Falha ao ler schema: HTTP ${resposta.status}`);
const openapi = await resposta.json();
const defs = openapi.definitions || {};

const tabelas = Object.entries(defs);
const partes = [];

partes.push(`-- =============================================================================
-- BASELINE DO SCHEMA EXISTENTE — SOMENTE PARA TESTE LOCAL
--
-- Gerado automaticamente por scripts/gerar-baseline-teste.mjs a partir do
-- endpoint OpenAPI do PostgREST em ${new Date().toISOString()}.
--
-- ⚠️  NUNCA APLIQUE ESTE ARQUIVO EM PRODUÇÃO.
-- Ele reconstrói apenas colunas/tipos/PK/FK/NOT NULL/defaults, o suficiente para
-- validar as migrations da camada operacional num Postgres descartável.
-- Triggers, índices, CHECKs e RLS do banco real NÃO estão aqui.
--
-- Tabelas reconstruídas: ${tabelas.length}
-- =============================================================================

create extension if not exists pgcrypto;

-- Stub mínimo do schema auth do Supabase (as migrations referenciam auth.users
-- e auth.uid()).
create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- Papéis usados pelas políticas de RLS.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;
`);

// 1ª passada: tabelas sem FK (evita erro de ordem de criação).
for (const [nome, def] of tabelas) {
  const props = def.properties || {};
  const obrigatorias = new Set(def.required || []);
  const colunas = [];

  for (const [col, meta] of Object.entries(props)) {
    const desc = meta.description || "";
    const bits = [`  ${col} ${tipoPostgres(meta)}`];
    if (/Primary Key/i.test(desc)) bits.push("primary key");
    const def_ = defaultSeguro(meta);
    if (def_) bits.push(`default ${def_}`);
    if (obrigatorias.has(col) && !/Primary Key/i.test(desc)) bits.push("not null");
    colunas.push(bits.join(" "));
  }

  partes.push(`\ncreate table if not exists public.${nome} (\n${colunas.join(",\n")}\n);`);
}

// 2ª passada: FKs, depois que todas as tabelas existem.
partes.push("\n\n-- Chaves estrangeiras");
for (const [nome, def] of tabelas) {
  for (const [col, meta] of Object.entries(def.properties || {})) {
    const fk = (meta.description || "").match(/Foreign Key to `([a-z_]+)\.([a-z_]+)`/i);
    if (!fk) continue;
    const constraint = `${nome}_${col}_fkey`;
    partes.push(
      `do $$ begin
  if not exists (select 1 from pg_constraint where conname = '${constraint}') then
    alter table public.${nome} add constraint ${constraint} foreign key (${col}) references public.${fk[1]}(${fk[2]});
  end if;
end $$;`
    );
  }
}

partes.push(`\ngrant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;`);

const destino = path.join(raizProjeto, "supabase", "baseline", "0000_baseline_existente_TESTE.sql");
fs.mkdirSync(path.dirname(destino), { recursive: true });
fs.writeFileSync(destino, partes.join("\n"));

console.log(`Baseline gerado: ${path.relative(raizProjeto, destino)}`);
console.log(`Tabelas reconstruídas: ${tabelas.length}`);
