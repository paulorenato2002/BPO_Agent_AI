/**
 * Passa a amostra real de C:\Users\user\Desktop\ARC\TL pela extração e pelos
 * bloqueios, sem banco, sem rede e sem modelo.
 *
 * Serve para ver, arquivo por arquivo, o que o classificador receberia — e se
 * algum foi recusado.
 */
import fs from "node:fs";
import path from "node:path";

const ORIGEM = "C:/Users/user/Desktop/ARC/TL";

const verde = (s: string) => `\x1b[32m${s}\x1b[0m`;
const vermelho = (s: string) => `\x1b[31m${s}\x1b[0m`;
const amarelo = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cinza = (s: string) => `\x1b[90m${s}\x1b[0m`;

const { parseArquivo, extensaoSuportada } = await import("../lib/file-extract");
const { verificarBloqueio, redigirSegredos } = await import("../lib/arquivador/bloqueios");
const { extrairCnpjs, identificarCompetencia } = await import(
  "../lib/arquivador/identificar-empresa"
);

let recusados = 0;

for (const nome of fs.readdirSync(ORIGEM).sort()) {
  const caminho = path.join(ORIGEM, nome);
  if (!fs.statSync(caminho).isFile()) continue;

  if (!extensaoSuportada(nome)) {
    console.log(`${vermelho("RECUSADO")} ${nome}`);
    console.log(`         extensão não suportada`);
    recusados++;
    continue;
  }

  const buffer = fs.readFileSync(caminho);
  let bruto: string;
  try {
    const p = await parseArquivo(nome, buffer);
    bruto =
      p.tipo === "tabular"
        ? `${p.colunas.join(" | ")}\n${JSON.stringify(p.linhas.slice(0, 200))}`
        : p.texto;
  } catch (e) {
    console.log(`${vermelho("ILEGÍVEL")} ${nome}`);
    console.log(`         ${(e as Error).message}`);
    recusados++;
    continue;
  }

  const bloqueio = verificarBloqueio(nome, bruto);
  if (bloqueio.bloqueado) {
    console.log(`${vermelho("BLOQUEADO")} ${nome}`);
    console.log(`         ${bloqueio.motivo}`);
    recusados++;
    continue;
  }

  const { texto, redigidos } = redigirSegredos(bruto);
  const comp = identificarCompetencia(texto, nome);
  const cnpjs = extrairCnpjs(`${texto} ${nome}`);

  console.log(`${verde("OK")}       ${nome}`);
  console.log(
    cinza(
      `         ${texto.length.toLocaleString()} caracteres` +
        (redigidos ? `  ${amarelo(`${redigidos} trecho(s) tarjado(s)`)}` : "") +
        `  cnpjs: ${cnpjs.length}` +
        `  competência: ${comp.competencia ?? "—"} (${comp.confianca})`
    )
  );
}

console.log(
  `\n${recusados === 0 ? verde("Nenhum arquivo recusado.") : vermelho(`${recusados} recusado(s).`)}`
);
