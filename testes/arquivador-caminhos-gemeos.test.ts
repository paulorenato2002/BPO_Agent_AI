import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expandirDestino, montarNomeArquivo, type RegraArquivamento } from "../lib/arquivador/caminhos";
import { regraParaPastaExistente } from "../lib/arquivador/regras-pastas-existentes";

/**
 * O TypeScript propõe o destino; o Python recalcula antes de copiar e RECUSA o
 * item se o resultado divergir. São duas implementações da mesma regra, e o
 * sintoma de qualquer diferença é sempre o mesmo: "o destino mudou desde a
 * proposta" em todo arquivamento, sem dizer qual é a diferença.
 *
 * Este teste compara as duas. Ele precisa do Python instalado e da pasta do
 * cliente existindo no disco (o mini-sistema resolve a pasta real), então é
 * PULADO onde isso não existe — CI e Vercel não têm nem um nem outro.
 */

const RAIZ_MINI = path.resolve(process.cwd(), "Mini-Sistemas", "arquivador_docs");
const PYTHON = process.env.ARQUIVADOR_PYTHON || "python";

type Caso = {
  nome: string;
  regra: RegraArquivamento;
  tipoDocumento: string;
  instituicao: string | null;
};

function regra(codigo: string, caminho: string[]): RegraArquivamento {
  return {
    id: codigo, codigo, nome: codigo, escopo: "mensal", caminho_modelo: caminho,
    padrao_nome: "{CODIGO}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}",
    exige_empresa: true, exige_competencia: true, exige_instituicao: false,
    projeto: null, subcategoria: null,
  };
}

const CASOS: Caso[] = [
  { nome: "agendamentos", regra: regra("CLIENTE_AGENDAMENTOS", ["AGENDAMENTOS", "{ANO}", "{COMPETENCIA}"]),
    tipoDocumento: "RELATORIO_AGENDAMENTOS", instituicao: "ITAÚ" },
  { nome: "contas a pagar", regra: regra("CLIENTE_AGENDAMENTOS", ["AGENDAMENTOS", "{ANO}", "{COMPETENCIA}"]),
    tipoDocumento: "RELATORIO_CONTAS_A_PAGAR", instituicao: null },
  { nome: "documento comum", regra: regra("CLIENTE_DOCUMENTO", ["{ANO}", "{COMPETENCIA}"]),
    tipoDocumento: "NOTA_FISCAL", instituicao: "SICOOB" },
];

/**
 * Uma pasta de cliente que exista no disco desta máquina.
 *
 * Lida do disco, nunca escrita aqui: nome e código de cliente não entram no
 * repositório. Sem raiz configurada ou sem nenhuma pasta, o teste é pulado.
 */
function empresaParaTeste(): { codigo: string; nome: string; pasta: string } | null {
  let raiz = process.env.ARQUIVADOR_RAIZ;
  if (!raiz) {
    try {
      const env = readFileSync(path.join(RAIZ_MINI, ".env"), "utf8");
      raiz = env.split(/\r?\n/).find((l) => l.startsWith("ARQUIVADOR_RAIZ="))
        ?.slice("ARQUIVADOR_RAIZ=".length).trim().replace(/^["']|["']$/g, "");
    } catch {
      return null;
    }
  }
  if (!raiz) return null;
  try {
    const pasta = readdirSync(path.join(raiz, "01_CLIENTES_ATIVOS"), { withFileTypes: true })
      .find((e) => e.isDirectory() && /^\d+-/.test(e.name))?.name;
    if (!pasta) return null;
    const codigo = pasta.split("-")[0];
    return { codigo, nome: pasta.slice(codigo.length + 1), pasta };
  } catch {
    return null;
  }
}

function pythonSimula(payload: Record<string, unknown>): { ok: boolean; caminho?: string; erro?: string } {
  const r = spawnSync(PYTHON, ["-m", "arquivador", "json", "--stdin"], {
    cwd: RAIZ_MINI, input: JSON.stringify(payload), encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
  if (r.error || r.stdout.trim() === "") return { ok: false, erro: r.stderr || String(r.error) };
  const saida = JSON.parse(r.stdout.trim()) as { ok: boolean; caminho_relativo?: string; erro?: string };
  return { ok: saida.ok, caminho: saida.caminho_relativo, erro: saida.erro };
}

test("TypeScript e Python calculam o mesmo caminho e o mesmo nome", (t) => {
  const empresa = empresaParaTeste();
  if (!empresa) {
    t.skip("sem pasta de cliente no disco desta máquina");
    return;
  }
  const pasta = mkdtempSync(path.join(tmpdir(), "gemeos-"));
  const arquivo = path.join(pasta, "documento.pdf");
  writeFileSync(arquivo, "%PDF teste");

  // Sonda: sem Python (ou sem a pasta do cliente no disco) não há o que comparar.
  const sonda = pythonSimula({
    arquivo, regra: CASOS[0].regra.codigo, empresa_codigo: empresa.codigo, empresa_nome: empresa.nome,
    empresa_ativa: true, competencia: "2026-09", tipo_documento: "X", instituicao: null,
    estrutura: "existente", simular: true,
  });
  if (!sonda.ok) {
    t.skip(`mini-sistema indisponível para comparação: ${sonda.erro ?? "sem resposta"}`);
    return;
  }

  for (const caso of CASOS) {
    const adaptada = regraParaPastaExistente(caso.regra);
    const contexto = {
      empresaId: "id-teste", empresaCodigo: empresa.codigo, empresaNome: empresa.nome,
      pastaEmpresa: empresa.pasta, pastaClientes: "01_CLIENTES_ATIVOS", competencia: "2026-09",
      instituicao: caso.instituicao, tipoDocumento: caso.tipoDocumento, extensao: "pdf", versao: 1,
    };
    const destino = expandirDestino(adaptada, contexto);
    const nome = montarNomeArquivo(adaptada, contexto);
    assert.ok(destino.ok && nome.ok, `${caso.nome}: o TypeScript não montou o caminho`);
    const doTypeScript = `${destino.ok ? destino.caminhoLogico : ""}/${nome.ok ? nome.nome : ""}`;

    const doPython = pythonSimula({
      arquivo, regra: caso.regra.codigo, empresa_codigo: empresa.codigo, empresa_nome: empresa.nome,
      empresa_ativa: true, competencia: "2026-09", tipo_documento: caso.tipoDocumento,
      instituicao: caso.instituicao, estrutura: "existente", simular: true,
    });

    assert.ok(doPython.ok, `${caso.nome}: ${doPython.erro}`);
    assert.equal(doPython.caminho, doTypeScript, `${caso.nome}: os dois lados discordam do destino`);
  }
});

test("o arquivador recusa o destino divergente dizendo qual é a diferença", (t) => {
  const empresa = empresaParaTeste();
  if (!empresa) {
    t.skip("sem pasta de cliente no disco desta máquina");
    return;
  }
  const pasta = mkdtempSync(path.join(tmpdir(), "gemeos-"));
  const arquivo = path.join(pasta, "documento.pdf");
  writeFileSync(arquivo, "%PDF teste");

  const r = pythonSimula({
    arquivo, regra: "CLIENTE_DOCUMENTO", empresa_codigo: empresa.codigo, empresa_nome: empresa.nome,
    empresa_ativa: true, competencia: "2026-09", tipo_documento: "NOTA_FISCAL", instituicao: null,
    estrutura: "existente", simular: true, caminho_confirmado: "01_CLIENTES_ATIVOS/outro/lugar.pdf",
  });
  if (!r.erro && !r.ok) {
    t.skip("mini-sistema indisponível");
    return;
  }
  assert.equal(r.ok, false);
  assert.match(r.erro ?? "", /Proposta: 01_CLIENTES_ATIVOS\/outro\/lugar\.pdf/);
  assert.match(r.erro ?? "", /Calculado: 01_CLIENTES_ATIVOS\//);
});
