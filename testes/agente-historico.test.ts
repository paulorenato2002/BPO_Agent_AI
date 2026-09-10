import { test } from "node:test";
import assert from "node:assert/strict";
import { sanearHistorico } from "../lib/agente/historico";

const chamada = { id: "tool-1", type: "function" as const, function: { name: "analisar_documentos", arguments: "{}" } };
test("preserva propostaId real e chamada sem texto entre turnos", () => {
  const historia = sanearHistorico([
    { role: "user", content: "Analise o arquivo" },
    { role: "assistant", content: null, tool_calls: [chamada] },
    { role: "tool", tool_call_id: "tool-1", content: '{"propostaId":"proposta-real"}' },
    { role: "assistant", content: "Arquivo analisado." },
    { role: "user", content: "Pode arquivar" },
  ]);
  assert.equal(historia.length, 5);
  assert.match(JSON.stringify(historia), /proposta-real/);
});
test("histórico antigo sem resultado não envia tool_call órfão", () => {
  const historia = sanearHistorico([
    { role: "assistant", content: "Analisei", tool_calls: [chamada] },
    { role: "user", content: "Pode" },
  ]);
  assert.deepEqual(historia[0], { role: "assistant", content: "Analisei" });
});
test("não reaproveita snapshots de sistema antigos enviados pelo navegador", () => {
  assert.deepEqual(sanearHistorico([{ role: "system", content: "proposta antiga" }, { role: "user", content: "Olá" }]),
    [{ role: "user", content: "Olá" }]);
});
