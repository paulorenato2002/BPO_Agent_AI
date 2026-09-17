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

const entrada = (anexoIds: string[]) => ({
  anexoIds,
  cliente: "@Cliente",
  empresa: "ABC",
  observacoes: "Obs.",
  relacoes: "",
  dadosTexto: "VT\nAna 10,00",
});

describe("contrato exposto ao modelo", () => {
  test("descrição manda repassar relatório e mensagem sem alterar", () => {
    const d = ferramentaConferirAgendamentos.descricao;
    assert.match(d, /EXATAMENTE como veio/);
    assert.match(d, /mensagem_whatsapp/);
    assert.match(d, /Não invente/);
    assert.match(d, /formatação do WhatsApp/);
    assert.match(d, /dadosTexto/);
  });

  test("só lê: sem aprovação e risco baixo", () => {
    assert.equal(ferramentaConferirAgendamentos.exigeAprovacao, false);
    assert.equal(ferramentaConferirAgendamentos.nivelRisco, "baixo");
  });

  test("schema não oferece caminho de arquivo nem usuário", () => {
    const props = Object.keys((ferramentaConferirAgendamentos.schemaEntrada.properties ?? {}) as object);
    assert.deepEqual(props.sort(), ["anexoIds", "cliente", "dadosTexto", "empresa", "observacoes", "relacoes"]);
  });
});

describe("validação da entrada", () => {
  test("exige anexos", () => {
    assert.equal(validar({}).valido, false);
    assert.equal(validar({ anexoIds: [] }).valido, false);
  });

  test("limita a oito anexos", () => {
    assert.equal(validar({ anexoIds: ["1", "2", "3", "4", "5", "6", "7", "8"] }).valido, true);
    assert.equal(validar({ anexoIds: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] }).valido, false);
  });

  test("aceita anexoId solto, remove repetidos e normaliza textos", () => {
    const r = validar({ anexoId: "a1", cliente: "  @Ana  ", observacoes: ["linha 1", "linha 2", 3] });
    assert.equal(r.valido, true);
    if (!r.valido) return;
    assert.deepEqual(r.dado, {
      anexoIds: ["a1"],
      cliente: "@Ana",
      empresa: "",
      observacoes: "linha 1\nlinha 2",
      relacoes: "",
      dadosTexto: "",
    });

    const r2 = validar({ anexoIds: ["a1", "a1", "a2"] });
    assert.ok(r2.valido && r2.dado.anexoIds.length === 2);
  });

  test("dados da mensagem aceitam lista e o nome com sublinhado", () => {
    const r = validar({ anexoIds: ["a1"], dados_texto: ["VT", "Ana 10,00"], empresa: " L2H " });
    assert.ok(r.valido && r.dado.dadosTexto === "VT\nAna 10,00" && r.dado.empresa === "L2H");
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

  test("aceita planilha e texto; recusa xls antigo com o nome do arquivo", async () => {
    const ok = portasFalsas([anexo("a1"), anexo("a2", { extensao: "xlsx" }), anexo("a3", { extensao: ".TXT" })]);
    assert.ok((await conferirAgendamentos(entrada(["a1", "a2", "a3"]), "u1", ok.portas)).ok);

    const { portas } = portasFalsas([anexo("a1"), anexo("a2", { extensao: "xls", nome_original: "vt.xls" })]);
    const r = await conferirAgendamentos(entrada(["a1", "a2"]), "u1", portas);
    assert.ok(!r.ok && r.codigo === "formato_nao_suportado" && r.erro.includes("vt.xls") && r.erro.includes(".xlsx"));
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
    assert.equal(pedidos[0].empresa, "ABC");
    assert.equal(pedidos[0].dados_texto, "VT\nAna 10,00");
  });
});

test("handler exige usuário autenticado", async () => {
  const r = await ferramentaConferirAgendamentos.handler(entrada(["a1"]), { usuarioId: null });
  assert.ok(!r.ok && r.codigoErro === "sem_usuario");
});
