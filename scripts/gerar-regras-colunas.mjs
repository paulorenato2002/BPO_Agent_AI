/**
 * Transforma os CHECK constraints do banco (lib/db-constraints.raw.txt) em
 * lib/db-regras.json, que o agente lê em `descrever_tabela`.
 *
 * Por que isso existe: o schema vem do OpenAPI do PostgREST, que expõe colunas
 * e tipos mas NÃO as regras de valor. Sem isso o agente chuta um valor plausível
 * ("MATRIZ"), toma erro do banco e só então pergunta. Com as regras no schema,
 * ele acerta de primeira.
 *
 * Uso: node scripts/gerar-regras-colunas.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrada = path.join(raiz, "lib", "db-constraints.raw.txt");
const saida = path.join(raiz, "lib", "db-regras.json");

/** `(col)::text = ANY ((ARRAY['a'::character varying, 'b'...])::text[])` */
function extrairEnum(definicao) {
  const alvo = /\((\w+)\)::text = ANY \(\(ARRAY\[(.*?)\]\)::text\[\]\)/s.exec(definicao);
  if (!alvo) return null;
  const [, coluna, lista] = alvo;
  const valores = [...lista.matchAll(/'((?:[^']|'')*)'::character varying/g)].map((m) =>
    m[1].replace(/''/g, "'")
  );
  return valores.length ? { coluna, valores } : null;
}

/** `(col)::text ~ 'regex'` ou `col ~* 'regex'` */
function extrairFormato(definicao) {
  const alvo = /\(?(\w+)\)?(?:::text)? ~\*? '((?:[^']|'')*)'::text/.exec(definicao);
  if (!alvo) return null;
  return { coluna: alvo[1], padrao: alvo[2].replace(/''/g, "'") };
}

const linhas = fs
  .readFileSync(entrada, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

/** @type {Record<string, {colunas: Record<string, object>, regras: string[]}>} */
const porTabela = {};
let enums = 0;
let formatos = 0;
let regrasGerais = 0;

for (const linha of linhas) {
  const partes = linha.split("|").map((p) => p.trim());
  if (partes.length < 3) continue;
  const [tabela, nome, definicao] = partes;

  porTabela[tabela] ??= { colunas: {}, regras: [] };
  const alvo = porTabela[tabela];

  const enumerado = extrairEnum(definicao);
  if (enumerado) {
    alvo.colunas[enumerado.coluna] ??= {};
    alvo.colunas[enumerado.coluna].valoresPermitidos = enumerado.valores;
    enums++;
    continue;
  }

  const formato = extrairFormato(definicao);
  if (formato) {
    alvo.colunas[formato.coluna] ??= {};
    alvo.colunas[formato.coluna].formato = formato.padrao;
    formatos++;
    continue;
  }

  // Regras que envolvem mais de uma coluna ou faixas numéricas ficam como
  // texto — o modelo lê e entende, mesmo sem estrutura.
  alvo.regras.push(`${nome}: ${definicao.replace(/^CHECK\s*/, "").replace(/\s+/g, " ")}`);
  regrasGerais++;
}

fs.writeFileSync(saida, JSON.stringify(porTabela, null, 2));

console.log(`Regras geradas em ${path.relative(raiz, saida)}`);
console.log(`  tabelas com regras : ${Object.keys(porTabela).length}`);
console.log(`  colunas com valores fixos : ${enums}`);
console.log(`  colunas com formato : ${formatos}`);
console.log(`  regras gerais (multi-coluna/faixa) : ${regrasGerais}`);
