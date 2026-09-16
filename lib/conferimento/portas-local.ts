import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";
import { buscarAnexosDoUsuario } from "../repositorios/anexos";
import { lerArquivo } from "../file-store";
import type { PortasConferimento, RespostaConferidor } from "./conferimento";

/**
 * Portas reais: anexos no Supabase, conferência no Python instalado no PC.
 *
 * Mesmo canal do arquivador (JSON no stdin/stdout). Funciona onde há Python —
 * hoje, o ambiente local; na Vercel não há, e a ferramenta responde com erro
 * explicado em vez de resultado.
 */

const RAIZ_CONFERIDOR = path.resolve(process.cwd(), "Mini-Sistemas", "conferidor");
const PYTHON = process.env.CONFERIDOR_PYTHON || process.env.ARQUIVADOR_PYTHON || "python";
const TIMEOUT_MS = 120_000;

export function chamarConferidor(payload: Record<string, unknown>): Promise<RespostaConferidor> {
  return new Promise((resolve) => {
    // Executável instalado no PC; não rastrear o repositório no pacote.
    const processo = spawn(/* turbopackIgnore: true */ PYTHON, ["cli.py", "json", "--stdin"], {
      cwd: RAIZ_CONFERIDOR,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    const saida: Buffer[] = [];
    let erro = "";
    let encerrado = false;

    const cronometro = setTimeout(() => {
      encerrado = true;
      processo.kill();
      resolve({ ok: false, erros: [`O conferidor local não respondeu em ${TIMEOUT_MS / 1000}s.`] });
    }, TIMEOUT_MS);

    processo.stdout.on("data", (d: Buffer) => saida.push(d));
    processo.stderr.on("data", (d) => (erro += d.toString("utf8")));

    processo.on("error", (e) => {
      if (encerrado) return;
      encerrado = true;
      clearTimeout(cronometro);
      resolve({
        ok: false,
        erros: [
          `Não consegui executar o conferidor local (${PYTHON}): ${e.message}. ` +
            "A conferência só roda onde o Python e as dependências do mini-sistema estão instalados.",
        ],
      });
    });

    processo.on("close", (codigo) => {
      if (encerrado) return;
      clearTimeout(cronometro);
      const texto = Buffer.concat(saida).toString("utf8").trim();
      try {
        resolve(JSON.parse(texto) as RespostaConferidor);
      } catch {
        resolve({
          ok: false,
          erros: [`O conferidor local devolveu resposta ilegível (código ${codigo}). Saída: ${(erro || texto).slice(0, 400)}`],
        });
      }
    });

    // Sem isto, um Python que morre cedo derruba o servidor com EPIPE.
    processo.stdin.on("error", () => {});
    processo.stdin.end(JSON.stringify(payload));
  });
}

export function portasConferimentoLocal(): PortasConferimento {
  return {
    buscarAnexos: buscarAnexosDoUsuario,
    lerConteudo: (anexo) => lerArquivo(anexo.arquivo_id, anexo.nome_original),
    conferir: chamarConferidor,
  };
}
