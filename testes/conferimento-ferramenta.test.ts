import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ferramentaConferirAgendamentos } from "../lib/ferramentas/conferimento";
import {
  conferirAgendamentos,
  type AnexoParaConferir,
  type PortasConferimento,
  type RespostaConferidor,
} from "../lib/conferimento/conferimento";

const validar = ferramentaConferirAgendamentos.validarEntrada;

function anexo(id: string, extra: Partial<AnexoParaConferir> = {}): AnexoParaConferir {
  return {
    id,
    arquivo_id: `arq-${id}`,
    nome_original: `${id}.pdf`,
    extensao: "pdf",
    bloqueado: false,
    motivo_bloqueio: null,
    ...extra,
  };
}

function portasFalsas(anexos: AnexoParaConferir[], resposta: RespostaConferidor = { ok: true, erros: [] }) {
  const pedidos: Parameters<PortasConferimento["conferir"]>[0][] = [];
  const buscas: { ids: string[]; usuarioId: string }[] = [];
  const portas: PortasConferimento = {
    async buscarAnexos(ids, usuarioId) {
      buscas.push({ ids, usuarioId });
      return anexos.filter((a) => ids.includes(a.id));
    },
    async lerConteudo(a) {
      return Buffer.from(`%PDF conteudo de ${a.id}`);
    },
    async conferir(pedido) {
      pedidos.push(pedido);
      return resposta;
    },
  };
  return { portas, pedidos, buscas };
}

const entrada = (anexoIds: string[]) => ({ anexoIds, cliente: "@Cliente", observacoes: "Obs.", relacoes: "" });

describe("contrato exposto ao modelo", () => {
  test("descrição manda repassar relatório e mensagem sem alterar", () => {
    const d = ferramentaConferirAgendamentos.descricao;
    assert.match(d, /EXATAMENTE como veio/);
    assert.match(d, /mensagem_whatsapp/);
    assert.match(d, /Não invente/);
  });

  test("só lê: sem aprovação e risco baixo", () => {
    assert.equal(ferramentaConferirAgendamentos.exigeAprovacao, false);
    assert.equal(ferramentaConferirAgendamentos.nivelRisco, "baixo");
  });

  test("schema não oferece caminho de arquivo nem usuário", () => {
    const props = Object.keys((ferramentaConferirAgendamentos.schemaEntrada.properties ?? {}) as object);
    assert.deepEqual(props.sort(), ["anexoIds", "cliente", "observacoes", "relacoes"]);
  });
});

describe("validação da entrada", () => {
  test("exige anexos", () => {
    assert.equal(validar({}).valido, false);
    assert.equal(validar({ anexoIds: [] }).valido, false);
  });

  test("limita a cinco anexos", () => {
    const r = validar({ anexoIds: ["1", "2", "3", "4", "5", "6"] });
    assert.equal(r.valido, false);
  });

  test("aceita anexoId solto, remove repetidos e normaliza textos", () => {
    const r = validar({ anexoId: "a1", cliente: "  @Ana  ", observacoes: ["linha 1", "linha 2", 3] });
    assert.equal(r.valido, true);
    if (!r.valido) return;
    assert.deepEqual(r.dado, { anexoIds: ["a1"], cliente: "@Ana", observacoes: "linha 1\nlinha 2", relacoes: "" });

    const r2 = validar({ anexoIds: ["a1", "a1", "a2"] });
    assert.ok(r2.valido && r2.dado.anexoIds.length === 2);
  });

  test("corta observação gigante", () => {
    const r = validar({ anexoIds: ["a1"], observacoes: "x".repeat(10_000) });
    assert.ok(r.valido && r.dado.observacoes.length === 4000);
  });
});

describe("regras antes do mini-sistema", () => {
  test("anexo de outro usuário recusa o lote inteiro", async () => {
    const { portas, pedidos, buscas } = portasFalsas([anexo("a1")]);
    const r = await conferirAgendamentos(entrada(["a1", "alheio"]), "u1", portas);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.codigo === "anexo_nao_encontrado");
    assert.equal(pedidos.length, 0);
    assert.equal(buscas[0].usuarioId, "u1");
  });

  test("anexo bloqueado não é conferido", async () => {
    const { portas, pedidos } = portasFalsas([anexo("a1", { bloqueado: true, motivo_bloqueio: "tipo proibido" })]);
    const r = await conferirAgendamentos(entrada(["a1"]), "u1", portas);
    assert.ok(!r.ok && r.codigo === "anexo_bloqueado");
    assert.equal(pedidos.length, 0);
  });

  test("planilha é recusada com o nome do arquivo", async () => {
    const { portas } = portasFalsas([anexo("a1"), anexo("a2", { extensao: "xlsx", nome_original: "contas.xlsx" })]);
    const r = await conferirAgendamentos(entrada(["a1", "a2"]), "u1", portas);
    assert.ok(!r.ok && r.codigo === "formato_nao_suportado" && r.erro.includes("contas.xlsx"));
  });

  test("envia conteúdo em base64, na ordem pedida, com cliente e observações", async () => {
    const resposta: RespostaConferidor = { ok: true, erros: [], divergencias: 1, mensagem_whatsapp: "Bom dia" };
    const { portas, pedidos } = portasFalsas([anexo("a1"), anexo("a2", { extensao: ".PDF" })], resposta);
    const r = await conferirAgendamentos(entrada(["a2", "a1"]), "u1", portas);
    assert.ok(r.ok);
    assert.deepEqual(r.ok && r.resposta, resposta);
    assert.deepEqual(pedidos[0].arquivos.map((a) => a.nome), ["a2.pdf", "a1.pdf"]);
    assert.equal(Buffer.from(pedidos[0].arquivos[0].base64, "base64").toString(), "%PDF conteudo de a2");
    assert.equal(pedidos[0].cliente, "@Cliente");
    assert.equal(pedidos[0].observacoes, "Obs.");
  });
});

test("handler exige usuário autenticado", async () => {
  const r = await ferramentaConferirAgendamentos.handler(entrada(["a1"]), { usuarioId: null });
  assert.ok(!r.ok && r.codigoErro === "sem_usuario");
});
