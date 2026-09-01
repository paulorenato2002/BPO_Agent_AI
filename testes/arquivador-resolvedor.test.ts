import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  resolverArvore,
  _limparTravas,
  type PortasResolvedor,
  type LinhaPasta,
  type ItemDrive,
} from "../lib/arquivador/resolvedor-pastas";
import type { SegmentoDestino } from "../lib/arquivador/caminhos";

/**
 * O resolvedor existe para impedir pastas duplicadas no Drive. Provocar uma
 * corrida real contra a API do Google não é reproduzível, então o Drive e o
 * banco são encenados aqui — inclusive a unique de chave_logica, que é o
 * árbitro entre instâncias diferentes.
 */

const RAIZ = "raiz-drive";

type Cenario = {
  portas: PortasResolvedor;
  drive: Map<string, { nome: string; paiId: string; createdTime: string }>;
  linhas: Map<string, LinhaPasta>;
  orfas: { chave: string; externalId: string }[];
  chamadas: { criar: number; listar: number; buscar: number };
};

/**
 * Drive + banco falsos.
 *
 * `atrasoCriacao` abre a janela de corrida de propósito, para o teste de
 * concorrência não depender de sorte de agendamento.
 */
function montarCenario(
  opcoes: {
    raiz?: string | null;
    atrasoCriacao?: number;
    /** Pastas que já existem no Drive antes de começarmos. */
    preexistentes?: { id: string; nome: string; paiId: string; createdTime: string }[];
    /** Linhas já gravadas em pastas_drive. */
    mapeamentos?: LinhaPasta[];
    /**
     * Encena outra INSTÂNCIA gravando a chave entre a nossa leitura e a nossa
     * escrita — a corrida que a trava em memória não cobre e só a unique do
     * banco resolve.
     */
    corridaBanco?: { chave: string; externalId: string };
  } = {}
): Cenario {
  const {
    raiz = RAIZ,
    atrasoCriacao = 0,
    preexistentes = [],
    mapeamentos = [],
  } = opcoes;

  // Mutável: a corrida encenada acontece uma vez só.
  let corridaBanco = opcoes.corridaBanco;

  const drive = new Map<string, { nome: string; paiId: string; createdTime: string }>();
  for (const p of preexistentes) {
    drive.set(p.id, { nome: p.nome, paiId: p.paiId, createdTime: p.createdTime });
  }

  const linhas = new Map<string, LinhaPasta>();
  for (const l of mapeamentos) linhas.set(l.chave_logica, l);

  const orfas: { chave: string; externalId: string }[] = [];
  const chamadas = { criar: 0, listar: 0, buscar: 0 };

  let sequencia = 0;
  let relogio = 100;

  const portas: PortasResolvedor = {
    pastaRaizId: () => raiz,

    async listarPastasPorNome(nome, paiId): Promise<ItemDrive[]> {
      chamadas.listar++;
      return [...drive.entries()]
        .filter(([, p]) => p.nome === nome && p.paiId === paiId)
        .map(([id, p]) => ({ id, createdTime: p.createdTime }))
        .sort((a, b) =>
          a.createdTime === b.createdTime
            ? a.id.localeCompare(b.id)
            : a.createdTime.localeCompare(b.createdTime)
        );
    },

    async criarPasta(nome, paiId) {
      chamadas.criar++;
      if (atrasoCriacao > 0) await new Promise((r) => setTimeout(r, atrasoCriacao));
      const id = `drv${++sequencia}`;
      drive.set(id, { nome, paiId, createdTime: String(++relogio) });
      return id;
    },

    async buscarMapeamento(chave) {
      chamadas.buscar++;
      return linhas.get(chave) ?? null;
    },

    async inserirMapeamento({ segmento, externalId }) {
      // Outra instância grava exatamente agora, depois da nossa leitura.
      if (corridaBanco && corridaBanco.chave === segmento.chaveLogica) {
        linhas.set(corridaBanco.chave, {
          id: "row-da-outra-instancia",
          chave_logica: corridaBanco.chave,
          external_id: corridaBanco.externalId,
          nome: segmento.nome,
          caminho_logico: segmento.caminhoLogico,
          status: "ativa",
        });
        corridaBanco = undefined; // acontece uma vez só
        return { conflito: true as const };
      }

      // A unique de (provedor, chave_logica) é o árbitro entre instâncias.
      if (linhas.has(segmento.chaveLogica)) return { conflito: true as const };

      const linha: LinhaPasta = {
        id: `row${++sequencia}`,
        chave_logica: segmento.chaveLogica,
        external_id: externalId,
        nome: segmento.nome,
        caminho_logico: segmento.caminhoLogico,
        status: "ativa",
      };
      linhas.set(linha.chave_logica, linha);
      return { linha, conflito: false as const };
    },

    async reapontarMapeamento({ segmento, externalId }) {
      const atual = linhas.get(segmento.chaveLogica);
      if (!atual) throw new Error("reapontar sem linha existente");
      const linha: LinhaPasta = { ...atual, external_id: externalId, status: "ativa" };
      linhas.set(linha.chave_logica, linha);
      return linha;
    },

    async registrarOrfa(segmento, externalId) {
      orfas.push({ chave: segmento.chaveLogica, externalId });
    },
  };

  return { portas, drive, linhas, orfas, chamadas };
}

const SEGMENTOS: SegmentoDestino[] = [
  { nome: "TL", escopo: "empresa", chaveLogica: "empresa:u1", caminhoLogico: "TL" },
  {
    nome: "01_DOCUMENTOS_MENSAIS",
    escopo: "categoria",
    chaveLogica: "empresa:u1:01_DOCUMENTOS_MENSAIS",
    caminhoLogico: "TL/01_DOCUMENTOS_MENSAIS",
  },
  {
    nome: "2026-09",
    escopo: "periodo",
    chaveLogica: "empresa:u1:01_DOCUMENTOS_MENSAIS:2026-09",
    caminhoLogico: "TL/01_DOCUMENTOS_MENSAIS/2026-09",
  },
];

beforeEach(() => _limparTravas());

describe("resolverArvore — caminho feliz", () => {
  test("cria um nível por segmento e devolve a folha", async () => {
    const c = montarCenario();
    const r = await resolverArvore(SEGMENTOS, { empresaId: "u1" }, c.portas);

    assert.ok(r.ok, r.ok ? "" : r.erro);
    assert.equal(r.pastas.length, 3);
    assert.equal(c.chamadas.criar, 3);
    assert.equal(r.folha.caminhoLogico, "TL/01_DOCUMENTOS_MENSAIS/2026-09");
    assert.ok(r.pastas.every((p) => p.criada));
  });

  test("encadeia o pai: cada pasta é criada dentro da anterior", async () => {
    const c = montarCenario();
    const r = await resolverArvore(SEGMENTOS, { empresaId: "u1" }, c.portas);
    assert.ok(r.ok);

    assert.equal(c.drive.get(r.pastas[0].externalId)?.paiId, RAIZ);
    assert.equal(c.drive.get(r.pastas[1].externalId)?.paiId, r.pastas[0].externalId);
    assert.equal(c.drive.get(r.pastas[2].externalId)?.paiId, r.pastas[1].externalId);
  });
});

describe("resolverArvore — idempotência", () => {
  test("a segunda chamada não cria nada e devolve os mesmos ids", async () => {
    const c = montarCenario();

    const primeira = await resolverArvore(SEGMENTOS, { empresaId: "u1" }, c.portas);
    const criadasNaPrimeira = c.chamadas.criar;
    const segunda = await resolverArvore(SEGMENTOS, { empresaId: "u1" }, c.portas);

    assert.ok(primeira.ok && segunda.ok);
    assert.equal(c.chamadas.criar, criadasNaPrimeira, "não podia criar de novo");
    assert.deepEqual(
      segunda.pastas.map((p) => p.externalId),
      primeira.pastas.map((p) => p.externalId)
    );
    assert.ok(segunda.pastas.every((p) => !p.criada));
    assert.equal(c.drive.size, 3, "sobrou pasta duplicada no Drive");
  });

  test("com o mapeamento gravado, nem consulta o Drive", async () => {
    const c = montarCenario();
    await resolverArvore(SEGMENTOS, { empresaId: "u1" }, c.portas);

    const listagensAntes = c.chamadas.listar;
    await resolverArvore(SEGMENTOS, { empresaId: "u1" }, c.portas);

    assert.equal(c.chamadas.listar, listagensAntes, "pastas_drive é a fonte de verdade");
  });

  test("adota pasta que já existia no Drive em vez de criar irmã", async () => {
    const c = montarCenario({
      preexistentes: [{ id: "antiga", nome: "TL", paiId: RAIZ, createdTime: "001" }],
    });

    const r = await resolverArvore([SEGMENTOS[0]], { empresaId: "u1" }, c.portas);

    assert.ok(r.ok, r.ok ? "" : r.erro);
    assert.equal(r.folha.externalId, "antiga");
    assert.equal(r.folha.criada, false);
    assert.equal(c.chamadas.criar, 0, "não podia criar: a pasta já existia");
  });
});

describe("resolverArvore — concorrência", () => {
  test("duas resoluções simultâneas produzem UMA pasta por nível", async () => {
    const c = montarCenario({ atrasoCriacao: 5 });

    const [a, b] = await Promise.all([
      resolverArvore(SEGMENTOS, { empresaId: "u1" }, c.portas),
      resolverArvore(SEGMENTOS, { empresaId: "u1" }, c.portas),
    ]);

    assert.ok(a.ok && b.ok, "as duas deveriam concluir");
    assert.equal(c.drive.size, 3, `criou pasta duplicada: ${c.drive.size}`);
    assert.equal(c.chamadas.criar, 3);
    assert.deepEqual(
      a.pastas.map((p) => p.externalId),
      b.pastas.map((p) => p.externalId),
      "as duas execuções têm de convergir para as mesmas pastas"
    );
  });

  test("dez resoluções simultâneas continuam produzindo uma pasta por nível", async () => {
    const c = montarCenario({ atrasoCriacao: 2 });

    const todas = await Promise.all(
      Array.from({ length: 10 }, () => resolverArvore(SEGMENTOS, { empresaId: "u1" }, c.portas))
    );

    assert.ok(todas.every((r) => r.ok));
    assert.equal(c.drive.size, 3, `criou pastas a mais: ${c.drive.size}`);

    const ids = new Set(todas.map((r) => (r.ok ? r.folha.externalId : "")));
    assert.equal(ids.size, 1, "todas tinham de terminar na mesma pasta");
  });

  test("perdendo a corrida do banco, adota o vencedor e registra a órfã", async () => {
    // Outra instância grava a chave depois da nossa leitura e antes da nossa
    // escrita: nós já teremos criado uma pasta que não vai ser a oficial.
    const c = montarCenario({
      corridaBanco: { chave: "empresa:u1", externalId: "pasta-da-outra-instancia" },
    });

    const r = await resolverArvore([SEGMENTOS[0]], { empresaId: "u1" }, c.portas);

    assert.ok(r.ok, r.ok ? "" : r.erro);
    assert.equal(
      r.folha.externalId,
      "pasta-da-outra-instancia",
      "quem gravou primeiro venceu"
    );
    assert.equal(r.folha.criada, false, "a nossa não virou a oficial");
    assert.equal(c.linhas.size, 1, "não pode haver duas linhas para a mesma chave");

    // A pasta que criamos e perdeu precisa ficar rastreável — e continuar
    // existindo no Drive, porque apagar sozinho lá é risco que não compensa.
    assert.equal(c.orfas.length, 1, "a pasta perdedora tinha de virar órfã registrada");
    assert.equal(c.orfas[0].chave, "empresa:u1");
    assert.ok(c.drive.has(c.orfas[0].externalId), "a órfã não pode ter sido apagada");
  });

  test("duas pastas iguais no Drive: converge na mais antiga, sem apagar nada", async () => {
    const c = montarCenario({
      preexistentes: [
        { id: "nova", nome: "TL", paiId: RAIZ, createdTime: "222" },
        { id: "antiga", nome: "TL", paiId: RAIZ, createdTime: "111" },
      ],
    });

    const r = await resolverArvore([SEGMENTOS[0]], { empresaId: "u1" }, c.portas);

    assert.ok(r.ok);
    assert.equal(r.folha.externalId, "antiga", "a mais antiga é a oficial");
    assert.equal(c.drive.size, 2, "a duplicata não pode ser apagada automaticamente");
  });
});

describe("resolverArvore — mapeamento quebrado", () => {
  test("pasta inacessível é reapontada, não duplicada em pastas_drive", async () => {
    const c = montarCenario({
      mapeamentos: [
        {
          id: "row1",
          chave_logica: "empresa:u1",
          external_id: "id-morto",
          nome: "TL",
          caminho_logico: "TL",
          status: "inacessivel",
        },
      ],
    });

    const r = await resolverArvore([SEGMENTOS[0]], { empresaId: "u1" }, c.portas);

    assert.ok(r.ok, r.ok ? "" : r.erro);
    assert.equal(c.linhas.size, 1);
    assert.notEqual(r.folha.externalId, "id-morto", "tinha de apontar para a pasta nova");
    assert.equal(c.linhas.get("empresa:u1")?.status, "ativa");
  });
});

describe("resolverArvore — recusas", () => {
  test("sem Drive configurado, reporta e não toca em nada", async () => {
    const c = montarCenario({ raiz: null });
    const r = await resolverArvore(SEGMENTOS, { empresaId: "u1" }, c.portas);

    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.naoConfigurado === true);
    assert.equal(c.chamadas.criar, 0);
    assert.equal(c.linhas.size, 0);
  });

  test("criar:false recusa em vez de criar a pasta que falta", async () => {
    const c = montarCenario();
    const r = await resolverArvore(SEGMENTOS, { empresaId: "u1", criar: false }, c.portas);

    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.erro : "", /não existe no Drive/);
    assert.equal(c.chamadas.criar, 0, "não podia criar nada");
  });

  test("lista de segmentos vazia é recusada", async () => {
    const c = montarCenario();
    const r = await resolverArvore([], { empresaId: "u1" }, c.portas);
    assert.equal(r.ok, false);
  });

  test("falha do Drive vira erro explícito, não sucesso silencioso", async () => {
    const c = montarCenario();
    c.portas.criarPasta = async () => {
      throw new Error("HTTP 500 quota");
    };

    const r = await resolverArvore(SEGMENTOS, { empresaId: "u1" }, c.portas);
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.erro : "", /quota/);
  });

  test("uma falha não deixa a chave travada para a próxima chamada", async () => {
    const c = montarCenario();
    const criarReal = c.portas.criarPasta;

    c.portas.criarPasta = async () => {
      throw new Error("falha transitória");
    };
    const primeira = await resolverArvore(SEGMENTOS, { empresaId: "u1" }, c.portas);
    assert.equal(primeira.ok, false);

    c.portas.criarPasta = criarReal;
    const segunda = await resolverArvore(SEGMENTOS, { empresaId: "u1" }, c.portas);
    assert.ok(segunda.ok, segunda.ok ? "" : segunda.erro);
  });
});
