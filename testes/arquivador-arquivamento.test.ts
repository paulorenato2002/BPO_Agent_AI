import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  arquivarDocumentos,
  type PortasArquivamento,
  type PropostaPersistida,
} from "../lib/arquivador/arquivamento";
import type { ItemAnalisado } from "../lib/arquivador/analise";
import type { SegmentoDestino } from "../lib/arquivador/caminhos";

/**
 * Este é o único ponto do sistema com efeito externo irreversível. Os testes
 * abaixo existem sobretudo para provar o que ele RECUSA.
 */

const USUARIO = "11111111-1111-1111-1111-111111111111";
const OUTRO = "22222222-2222-2222-2222-222222222222";
const EMPRESA = "aaaa1111-0000-0000-0000-000000000001";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const SEGMENTOS: SegmentoDestino[] = [
  { nome: "01_CLIENTES_ATIVOS", escopo: "estrutural", chaveLogica: "estrutural:01_CLIENTES_ATIVOS", caminhoLogico: "01_CLIENTES_ATIVOS" },
  { nome: "ALF", escopo: "empresa", chaveLogica: `empresa:${EMPRESA}`, caminhoLogico: "01_CLIENTES_ATIVOS/ALF" },
  { nome: "05_NOTAS_FISCAIS", escopo: "categoria", chaveLogica: `empresa:${EMPRESA}:05_NOTAS_FISCAIS`, caminhoLogico: "01_CLIENTES_ATIVOS/ALF/05_NOTAS_FISCAIS" },
];

function item(over: Partial<ItemAnalisado> = {}): ItemAnalisado {
  return {
    anexoId: "anx-1",
    nomeOriginal: "NF.pdf",
    hashSha256: HASH_A,
    status: "analisado",
    bloqueio: null,
    empresa: { valor: "ALF", confianca: "confirmado", empresaId: EMPRESA, rotulo: "Alfa" },
    competencia: { valor: "2026-09", confianca: "confirmado" },
    regra: { valor: "MENSAL_NOTAS_FISCAIS", nome: "Notas fiscais", confianca: "provavel" },
    tipoDocumento: { valor: "NOTA_FISCAL", confianca: "provavel" },
    instituicao: { valor: null, confianca: "ausente" },
    camposFaltantes: [],
    conflitos: [],
    evidencias: [],
    nomeSugerido: "ALF_2026-09_NOTA_FISCAL_v1.pdf",
    caminhoSugerido: "01_CLIENTES_ATIVOS/ALF/05_NOTAS_FISCAIS/ALF_2026-09_NOTA_FISCAL_v1.pdf",
    possivelDuplicata: null,
    ...over,
  };
}

function proposta(over: Partial<PropostaPersistida> = {}): PropostaPersistida {
  const itens = over.itens ?? [item()];
  return {
    id: "prop-1",
    usuarioId: USUARIO,
    status: "aguardando",
    expiraEm: new Date(Date.now() + 3600_000).toISOString(),
    itens,
    hashes: itens.map((i) => ({ anexoId: i.anexoId, hash: i.hashSha256 })),
    anexoIds: itens.map((i) => i.anexoId),
    ...over,
  };
}

type Cenario = {
  portas: PortasArquivamento;
  enviados: { nome: string; paiId: string }[];
  registrados: { versao: number; nomeFinal: string }[];
  propostaAtualizada: { status: string; erroMensagem?: string | null } | null;
};

function montar(opcoes: {
  proposta?: PropostaPersistida | null;
  hashesAtuais?: { anexoId: string; hash: string }[];
  documentoExistente?: { id: string; identificadorExterno: string | null; caminho: string | null } | null;
  falhaEnvio?: string | null;
  falhaPasta?: string | null;
  jaExistiaNoDrive?: boolean;
  versaoInicial?: number;
} = {}): Cenario {
  const {
    proposta: p = proposta(),
    hashesAtuais,
    documentoExistente = null,
    falhaEnvio = null,
    falhaPasta = null,
    jaExistiaNoDrive = false,
    versaoInicial = 1,
  } = opcoes;

  const enviados: Cenario["enviados"] = [];
  const registrados: Cenario["registrados"] = [];
  const c: Cenario = { portas: null as never, enviados, registrados, propostaAtualizada: null };

  c.portas = {
    async buscarProposta() {
      return p;
    },
    async hashesAtuais(ids) {
      return hashesAtuais ?? ids.map((id) => ({ anexoId: id, hash: HASH_A }));
    },
    async lerConteudoParaEnvio() {
      return {
        conteudo: Buffer.from("conteudo ficticio"),
        mimeType: "application/pdf",
        nomeOriginal: "NF.pdf",
        extensao: "pdf",
      };
    },
    async entregarArquivo(dados) {
      // Uma porta só cobre "resolver destino" e "entregar": os dois destinos
      // reais (Drive e pasta sincronizada) fazem isso de jeitos diferentes.
      if (falhaPasta) return { ok: false as const, erro: falhaPasta };
      if (falhaEnvio) return { ok: false as const, erro: falhaEnvio };

      const versao = versaoInicial;
      const nomeFinal =
        versao === 1
          ? dados.item.nomeSugerido!
          : dados.item.nomeSugerido!.replace(/_v\d+(\.[^.]+)$/, `_v${versao}$1`);

      enviados.push({ nome: nomeFinal, paiId: "pasta-destino" });

      return {
        ok: true as const,
        identificador: `dest-${enviados.length}`,
        caminhoLogico: SEGMENTOS[SEGMENTOS.length - 1].caminhoLogico,
        nomeFinal,
        versao,
        jaExistia: jaExistiaNoDrive,
        provedor: "pasta_sincronizada",
      };
    },
    async documentoPorHash() {
      return documentoExistente;
    },
    async registrarDocumento(dados) {
      registrados.push({ versao: dados.versao, nomeFinal: dados.nomeFinal });
      return { documentoId: `doc-${registrados.length}` };
    },
    async atualizarProposta(_id, dados) {
      c.propostaAtualizada = { status: dados.status, erroMensagem: dados.erroMensagem };
    },
  };

  return c;
}

describe("confirmação explícita", () => {
  test("sem confirmar:true não arquiva nada", async () => {
    const c = montar();
    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: false, anexosConfirmados: ["anx-1"] },
      USUARIO,
      c.portas
    );

    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.codigo, "sem_confirmacao");
    assert.equal(c.enviados.length, 0);
    assert.match(r.ok === false ? r.erro : "", /não é confirmação/);
  });

  test("confirmar:true sem lista de anexos não arquiva", async () => {
    const c = montar();
    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: true, anexosConfirmados: [] },
      USUARIO,
      c.portas
    );

    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.codigo, "nada_confirmado");
    assert.equal(c.enviados.length, 0);
  });

  test("item não confirmado é pulado, mesmo estando pronto", async () => {
    const c = montar({
      proposta: proposta({
        itens: [item({ anexoId: "a1" }), item({ anexoId: "a2" })],
      }),
    });
    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: true, anexosConfirmados: ["a1"] },
      USUARIO,
      c.portas
    );

    assert.ok(r.ok);
    assert.equal(c.enviados.length, 1, "só o confirmado podia subir");
    assert.equal(r.itens.find((i) => i.anexoId === "a2")?.status, "pulado");
    assert.equal(r.statusProposta, "parcial", "com item de fora não é 'arquivada'");
  });
});

describe("recusas antes de qualquer envio", () => {
  test("proposta de outro usuário", async () => {
    const c = montar();
    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: true, anexosConfirmados: ["anx-1"] },
      OUTRO,
      c.portas
    );

    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.codigo, "proposta_de_outro");
    assert.equal(c.enviados.length, 0);
  });

  test("proposta expirada é marcada e recusada", async () => {
    const c = montar({
      proposta: proposta({ expiraEm: new Date(Date.now() - 1000).toISOString() }),
    });
    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: true, anexosConfirmados: ["anx-1"] },
      USUARIO,
      c.portas
    );

    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.codigo, "proposta_expirada");
    assert.equal(c.enviados.length, 0);
    assert.equal(c.propostaAtualizada?.status, "expirada");
  });

  test("proposta já resolvida não arquiva de novo", async () => {
    const c = montar({ proposta: proposta({ status: "arquivada" }) });
    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: true, anexosConfirmados: ["anx-1"] },
      USUARIO,
      c.portas
    );

    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.codigo, "proposta_resolvida");
    assert.equal(c.enviados.length, 0);
  });

  test("arquivo alterado invalida a proposta e não envia nada", async () => {
    const c = montar({ hashesAtuais: [{ anexoId: "anx-1", hash: HASH_B }] });
    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: true, anexosConfirmados: ["anx-1"] },
      USUARIO,
      c.portas
    );

    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.codigo, "arquivo_alterado");
    assert.equal(c.enviados.length, 0);
    assert.equal(c.propostaAtualizada?.status, "invalidada");
  });

  test("proposta inexistente", async () => {
    const c = montar({ proposta: null });
    const r = await arquivarDocumentos(
      { propostaId: "sumida", confirmar: true, anexosConfirmados: ["anx-1"] },
      USUARIO,
      c.portas
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.codigo, "proposta_inexistente");
  });
});

describe("item que não pode ser arquivado", () => {
  test("item incompleto vira erro, não arquivo", async () => {
    const c = montar({
      proposta: proposta({
        itens: [item({ status: "incompleto", camposFaltantes: ["competencia"], caminhoSugerido: null })],
      }),
    });
    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: true, anexosConfirmados: ["anx-1"] },
      USUARIO,
      c.portas
    );

    assert.ok(r.ok);
    assert.equal(r.itens[0].status, "erro");
    assert.match(r.itens[0].erro ?? "", /competencia/);
    assert.equal(c.enviados.length, 0);
  });

  test("item bloqueado nunca sobe", async () => {
    const c = montar({
      proposta: proposta({
        itens: [
          item({
            status: "bloqueado",
            bloqueio: { motivo: "Arquivos .pfx nunca são processados.", categoria: "extensao" },
          }),
        ],
      }),
    });
    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: true, anexosConfirmados: ["anx-1"] },
      USUARIO,
      c.portas
    );

    assert.ok(r.ok);
    assert.equal(r.itens[0].status, "erro");
    assert.equal(c.enviados.length, 0);
  });

  test("conflito não resolvido impede o arquivamento", async () => {
    const c = montar({
      proposta: proposta({
        itens: [item({ conflitos: [{ campo: "empresa", motivo: "duas empresas no documento" }] })],
      }),
    });
    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: true, anexosConfirmados: ["anx-1"] },
      USUARIO,
      c.portas
    );

    assert.ok(r.ok);
    assert.equal(r.itens[0].status, "erro");
    assert.equal(c.enviados.length, 0);
  });
});

describe("caminho feliz", () => {
  test("arquiva, registra e marca a proposta", async () => {
    const c = montar();
    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: true, anexosConfirmados: ["anx-1"] },
      USUARIO,
      c.portas
    );

    assert.ok(r.ok);
    assert.equal(r.itens[0].status, "arquivado");
    assert.equal(r.itens[0].documentoId, "doc-1");
    assert.equal(r.statusProposta, "arquivada");
    assert.equal(c.enviados[0].paiId, "pasta-destino", "entregou no destino resolvido");
    assert.equal(c.propostaAtualizada?.status, "arquivada");
  });

  test("a versão é decidida na confirmação, não na análise", async () => {
    // Outro documento ocupou a v1 entre analisar e confirmar.
    const c = montar({ versaoInicial: 3 });
    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: true, anexosConfirmados: ["anx-1"] },
      USUARIO,
      c.portas
    );

    assert.ok(r.ok);
    assert.equal(r.itens[0].versao, 3);
    assert.equal(c.enviados[0].nome, "ALF_2026-09_NOTA_FISCAL_v3.pdf");
    assert.equal(c.registrados[0].versao, 3);
  });
});

describe("idempotência e retentativa", () => {
  test("conteúdo já arquivado para a empresa não sobe de novo", async () => {
    const c = montar({
      documentoExistente: {
        id: "doc-antigo",
        identificadorExterno: "drv-antigo",
        caminho: "01_CLIENTES_ATIVOS/ALF/05_NOTAS_FISCAIS/ALF_2026-09_NOTA_FISCAL_v1.pdf",
      },
    });
    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: true, anexosConfirmados: ["anx-1"] },
      USUARIO,
      c.portas
    );

    assert.ok(r.ok);
    assert.equal(r.itens[0].status, "ja_arquivado");
    assert.equal(r.itens[0].documentoId, "doc-antigo");
    assert.equal(c.enviados.length, 0, "não podia reenviar");
    assert.equal(r.statusProposta, "arquivada");
  });

  test("arquivo já no Drive (upload deu certo, registro falhou antes) é reconhecido", async () => {
    const c = montar({ jaExistiaNoDrive: true });
    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: true, anexosConfirmados: ["anx-1"] },
      USUARIO,
      c.portas
    );

    assert.ok(r.ok);
    assert.equal(r.itens[0].status, "ja_arquivado");
    assert.ok(r.itens[0].documentoId, "o registro precisava ser criado agora");
  });
});

describe("falha parcial", () => {
  test("um item falha e os outros continuam arquivados", async () => {
    let chamada = 0;
    const c = montar({
      proposta: proposta({ itens: [item({ anexoId: "a1" }), item({ anexoId: "a2" })] }),
    });
    c.portas.entregarArquivo = async (dados) => {
      chamada++;
      if (chamada === 2) return { ok: false as const, erro: "HTTP 500 quota" };
      c.enviados.push({ nome: dados.item.nomeSugerido!, paiId: "pasta-destino" });
      return {
        ok: true as const,
        identificador: "dest-1",
        caminhoLogico: "01_CLIENTES_ATIVOS/ALF/05_NOTAS_FISCAIS",
        nomeFinal: dados.item.nomeSugerido!,
        versao: 1,
        jaExistia: false,
        provedor: "pasta_sincronizada",
      };
    };

    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: true, anexosConfirmados: ["a1", "a2"] },
      USUARIO,
      c.portas
    );

    assert.ok(r.ok);
    assert.equal(r.resumo.arquivados, 1);
    assert.equal(r.resumo.erros, 1);
    assert.equal(r.statusProposta, "parcial");
    assert.match(c.propostaAtualizada?.erroMensagem ?? "", /quota/);
  });

  test("falha ao resolver o destino não deixa arquivo órfão", async () => {
    const c = montar({ falhaPasta: "Drive indisponível" });
    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: true, anexosConfirmados: ["anx-1"] },
      USUARIO,
      c.portas
    );

    assert.ok(r.ok);
    assert.equal(r.itens[0].status, "erro");
    assert.equal(c.enviados.length, 0, "não podia entregar sem destino resolvido");
    assert.equal(c.registrados.length, 0, "nem registrar");
  });

  test("falha no envio não registra documento", async () => {
    const c = montar({ falhaEnvio: "HTTP 403" });
    const r = await arquivarDocumentos(
      { propostaId: "prop-1", confirmar: true, anexosConfirmados: ["anx-1"] },
      USUARIO,
      c.portas
    );

    assert.ok(r.ok);
    assert.equal(r.itens[0].status, "erro");
    assert.equal(c.registrados.length, 0, "registrar sem arquivo seria mentira no banco");
  });
});
