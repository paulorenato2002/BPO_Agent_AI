import "server-only";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

/** Resolve pelo código; a razão social do cadastro não é o nome da pasta. */
export async function pastaClienteLocal(container: string, codigo: string): Promise<string> {
  let raiz = process.env.ARQUIVADOR_RAIZ;
  if (!raiz) {
    const env = await readFile(path.join(process.cwd(), "Mini-Sistemas", "arquivador_docs", ".env"), "utf8");
    raiz = env.split(/\r?\n/).find(l => l.startsWith("ARQUIVADOR_RAIZ="))?.slice("ARQUIVADOR_RAIZ=".length).trim().replace(/^["']|["']$/g, "");
  }
  if (!raiz) throw new Error("Raiz do arquivador não configurada.");
  if (container.includes("/") || container.includes("\\") || container === "..") throw new Error("Contêiner inválido.");
  const raizReal = await realpath(raiz);
  const pasta = path.join(raizReal, container);
  const entradas = await readdir(pasta, { withFileTypes: true });
  const candidatas = entradas.filter(e => e.isDirectory() && e.name.startsWith(`${codigo}-`));
  if (candidatas.length !== 1) throw new Error(`Esperava uma pasta existente com prefixo ${codigo}- em ${container}; encontrei ${candidatas.length}.`);
  const nome = candidatas[0].name;
  const relativa = path.relative(raizReal, await realpath(path.join(pasta, nome)));
  if (relativa.startsWith("..") || path.isAbsolute(relativa)) throw new Error("A pasta do cliente aponta para fora da raiz.");
  return nome;
}
