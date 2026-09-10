import "server-only";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { supabaseAdmin } from "../supabase-admin";
import { portasComuns } from "./portas-arquivamento";
import type { ItemAnalisado } from "./analise";
import type { PortasArquivamento } from "./arquivamento";

/**
 * Entrega na pasta sincronizada do OneDrive, via mini-sistema em Python.
 *
 * Este é o destino de verdade hoje. O acesso por API ao tenant dependia de
 * uma aprovação indisponível, então a rota é outra: o mini-sistema escreve no
 * disco local e o próprio OneDrive sincroniza.
 *
 * O TypeScript aqui é só um mensageiro. Quem decide caminho, nome, versão e
 * como copiar com segurança é o Python — e é lá que estão os 53 testes disso.
 * Reimplementar essa lógica aqui criaria uma segunda versão livre para
 * divergir da primeira.
 *
 * Conversa por JSON no stdin/stdout, o mesmo canal que o n8n vai usar. Um
 * canal só, testado por dois caminhos, em vez de dois canais parecidos.
 */

const RAIZ_MINI_SISTEMA = path.resolve(process.cwd(), "Mini-Sistemas", "arquivador_docs");
const PYTHON = process.env.ARQUIVADOR_PYTHON || "python";
const TIMEOUT_MS = 120_000;

type RespostaPython = {
  ok: boolean;
  status?: string;
  caminho_final?: string;
  nome_final?: string;
  versao?: number;
  sha256?: string;
  caminho_relativo?: string;
  erro?: string;
  faltando?: string[];
};

/**
 * Chama o mini-sistema e devolve a resposta já em objeto.
 *
 * Erro de processo (Python ausente, travado, saída ilegível) vira falha
 * explicada, nunca sucesso silencioso — arquivar é irreversível.
 */
function chamarPython(payload: Record<string, unknown>): Promise<RespostaPython> {
  return new Promise((resolve) => {
    // Executável instalado no PC, usado somente no modo local explícito.
    // Não incluir o repositório inteiro no pacote da Vercel ao rastreá-lo.
    const processo = spawn(/* turbopackIgnore: true */ PYTHON, ["-m", "arquivador", "json", "--stdin"], {
      cwd: RAIZ_MINI_SISTEMA,
      windowsHide: true,
    });

    let saida = "";
    let erro = "";
    let encerrado = false;

    const cronometro = setTimeout(() => {
      encerrado = true;
      processo.kill();
      resolve({
        ok: false,
        erro: `O arquivador local não respondeu em ${TIMEOUT_MS / 1000}s.`,
      });
    }, TIMEOUT_MS);

    processo.stdout.on("data", (d) => (saida += d.toString("utf8")));
    processo.stderr.on("data", (d) => (erro += d.toString("utf8")));

    processo.on("error", (e) => {
      if (encerrado) return;
      clearTimeout(cronometro);
      resolve({
        ok: false,
        erro:
          `Não consegui executar o arquivador local (${PYTHON}): ${e.message}. ` +
          "Confira se o Python está instalado e no PATH.",
      });
    });

    processo.on("close", (codigo) => {
      if (encerrado) return;
      clearTimeout(cronometro);

      // O mini-sistema responde JSON até em erro. Saída ilegível é defeito de
      // ambiente (Python quebrado, módulo faltando) e precisa aparecer inteira.
      try {
        resolve(JSON.parse(saida.trim()) as RespostaPython);
      } catch {
        resolve({
          ok: false,
          erro:
            `O arquivador local devolveu resposta ilegível (código ${codigo}). ` +
            `Saída: ${(erro || saida).slice(0, 400)}`,
        });
      }
    });

    processo.stdin.write(JSON.stringify(payload));
    processo.stdin.end();
  });
}

/** A pasta da empresa depende de ela estar ativa; isso é lido AGORA. */
async function empresaEstaAtiva(empresaId: string | null): Promise<boolean> {
  if (!empresaId) return true;

  const { data } = await supabaseAdmin
    .from("empresas")
    .select("ativo")
    .eq("id", empresaId)
    .maybeSingle();

  return (data as { ativo: boolean } | null)?.ativo ?? true;
}

async function entregarNaPastaLocal(dados: {
  item: ItemAnalisado;
  conteudo: Buffer;
  mimeType: string;
  nomeOriginal: string;
  extensao: string;
}) {
  const { item } = dados;

  if (!item.regra.valor) {
    return { ok: false as const, erro: "Item sem regra de arquivamento." };
  }

  // O Python trabalha com arquivo em disco. O conteúdo veio do Storage, então
  // passa por um temporário que é apagado sempre — inclusive se der erro.
  const pasta = await mkdtemp(path.join(tmpdir(), "arquivador-"));
  const origem = path.join(pasta, dados.nomeOriginal);

  try {
    await writeFile(origem, dados.conteudo);

    const resposta = await chamarPython({
      arquivo: origem,
      regra: item.regra.valor,
      empresa_codigo: item.empresa.valor,
      empresa_nome: item.empresa.rotulo ?? item.empresa.valor,
      empresa_ativa: await empresaEstaAtiva(item.empresa.empresaId),
      competencia: item.competencia.valor,
      instituicao: item.instituicao.valor,
      tipo_documento: item.tipoDocumento.valor,
      caminho_confirmado: item.caminhoSugerido,
    });

    if (!resposta.ok) {
      const faltando = resposta.faltando?.length
        ? ` Faltando: ${resposta.faltando.join(", ")}.`
        : "";
      return { ok: false as const, erro: `${resposta.erro ?? "Falha no arquivamento."}${faltando}` };
    }

    if (!resposta.caminho_final || !resposta.nome_final) {
      return {
        ok: false as const,
        erro: "O arquivador local disse que deu certo mas não informou o caminho.",
      };
    }

    // O caminho lógico vem do Python já relativo à raiz. Recortar do caminho
    // absoluto aqui seria chute: só o mini-sistema sabe onde a raiz termina,
    // e é esse valor relativo que vai para o banco — a raiz é configuração de
    // máquina, e gravá-la quebraria o histórico ao trocar de computador.
    const caminhoLogico = resposta.caminho_relativo;
    if (!caminhoLogico) {
      return {
        ok: false as const,
        erro: "O arquivador local não informou o caminho relativo à raiz.",
      };
    }

    return {
      ok: true as const,
      // Na pasta local não há id de provedor; o caminho É o identificador.
      identificador: resposta.caminho_final,
      caminhoLogico,
      nomeFinal: resposta.nome_final,
      versao: resposta.versao ?? 1,
      jaExistia: resposta.status === "ja_existia",
      provedor: "pasta_sincronizada",
    };
  } finally {
    await rm(pasta, { recursive: true, force: true });
  }
}

export function portasArquivamentoLocal(): PortasArquivamento {
  return {
    ...portasComuns,
    entregarArquivo: entregarNaPastaLocal,
  };
}

/**
 * Destino em uso. `local` (padrão) escreve na pasta sincronizada;
 * `google_drive` volta a subir por API, se o acesso ao tenant sair.
 */
export async function portasArquivamentoEmUso(): Promise<PortasArquivamento> {
  if (process.env.ARQUIVAMENTO_DESTINO === "google_drive") {
    const { portasArquivamentoPadrao } = await import("./portas-arquivamento");
    return portasArquivamentoPadrao();
  }
  return portasArquivamentoLocal();
}
