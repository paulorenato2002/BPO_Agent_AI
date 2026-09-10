import { test } from "node:test";
import assert from "node:assert/strict";
import { ferramentaAnalisarDocumentos, ferramentaArquivarDocumentos, ferramentaProcessarDocumentos } from "../lib/ferramentas/arquivador";
import type { PropostaGerada } from "../lib/arquivador/analise";

function proposta(confianca = "confirmado"): PropostaGerada {
  return { propostaId: "id-real", status: "aguardando", expiraEm: "2099-01-01",
    itens: [{ anexoId: "arquivo-real", status: "analisado", conflitos: [],
      empresa: { empresaId: "empresa-real", confianca }, caminhoSugerido: "CLIENTES/210/07.2026/arquivo.pdf",
      nomeSugerido: "arquivo.pdf" }], resumo: {} } as unknown as PropostaGerada;
}

test("pedido direto analisa e arquiva usando o ID realmente gerado", async () => {
  const analisar = ferramentaAnalisarDocumentos.handler;
  const arquivar = ferramentaArquivarDocumentos.handler;
  const passos: string[] = [];
  try {
    ferramentaAnalisarDocumentos.handler = async () => {
      passos.push("analisar");
      return { ok: true, saida: proposta(), resumo: "" };
    };
    ferramentaArquivarDocumentos.handler = async entrada => {
      passos.push("arquivar");
      assert.equal(entrada.propostaId, "id-real");
      assert.equal(entrada.confirmar, true);
      assert.deepEqual(entrada.anexosConfirmados, ["arquivo-real"]);
      return { ok: true, saida: { status: "enfileirado", propostaId: entrada.propostaId, itens: [] }, resumo: "Enfileirado" };
    };
    const r = await ferramentaProcessarDocumentos.handler({ anexoIds: ["arquivo-real"] }, { usuarioId: "usuario" });
    assert.equal(r.ok, true);
    assert.deepEqual(passos, ["analisar", "arquivar"]);
  } finally {
    ferramentaAnalisarDocumentos.handler = analisar;
    ferramentaArquivarDocumentos.handler = arquivar;
  }
});

test("empresa ambígua continua pedindo apenas a informação faltante", async () => {
  const analisar = ferramentaAnalisarDocumentos.handler;
  const arquivar = ferramentaArquivarDocumentos.handler;
  try {
    ferramentaAnalisarDocumentos.handler = async () => ({ ok: true, saida: proposta("provavel"), resumo: "" });
    ferramentaArquivarDocumentos.handler = async () => { throw new Error("Não deveria arquivar"); };
    const r = await ferramentaProcessarDocumentos.handler({ anexoIds: ["arquivo-real"] }, { usuarioId: "usuario" });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.saida.arquivamento, null);
  } finally {
    ferramentaAnalisarDocumentos.handler = analisar;
    ferramentaArquivarDocumentos.handler = arquivar;
  }
});
