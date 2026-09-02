import { propostaAindaValida, propostaExpirada, type ItemAnalisado } from "./analise";
import type { SegmentoDestino } from "./caminhos";

/**
 * Confirmação de uma proposta e arquivamento efetivo no Drive.
 *
 * É o único ponto do sistema que produz efeito externo irreversível: sobe
 * arquivo para o Drive do cliente. Por isso ele é chato de propósito.
 *
 * O que ele NÃO aceita:
 *
 * - confirmação implícita. É preciso `confirmar: true` E a lista explícita dos
 *   itens. Um "ok" do usuário no chat não chega aqui como confirmação; quem
 *   traduz "ok" em ids é o agente, e o agente erra.
 * - item que não estava pronto. `incompleto` ou `bloqueado` não arquiva.
 * - proposta vencida, de outro usuário, ou já resolvida.
 * - arquivo que mudou desde a análise. A proposta descrevia outro conteúdo.
 *
 * IDEMPOTÊNCIA: a operação é retomável item a item. Se o terceiro arquivo
 * falha, os dois primeiros continuam arquivados e a proposta vira `parcial`.
 * Repetir a confirmação não sobe nada de novo — cada item já arquivado é
 * reconhecido pelo par (empresa, hash) e pulado.
 */

export type ItemArquivado = {
  anexoId: string;
  status: "arquivado" | "ja_arquivado" | "pulado" | "erro";
  documentoId: string | null;
  identificadorExterno: string | null;
  caminhoFinal: string | null;
  versao: number | null;
  erro: string | null;
};

export type ResultadoArquivamento =
  | {
      ok: true;
      propostaId: string;
      statusProposta: "arquivada" | "parcial";
      itens: ItemArquivado[];
      resumo: { arquivados: number; jaArquivados: number; pulados: number; erros: number };
    }
  | { ok: false; erro: string; codigo: string };

export type PropostaPersistida = {
  id: string;
  usuarioId: string;
  status: string;
  expiraEm: string;
  itens: ItemAnalisado[];
  hashes: { anexoId: string; hash: string }[];
  anexoIds: string[];
};

export type PortasArquivamento = {
  buscarProposta(propostaId: string): Promise<PropostaPersistida | null>;
  /** Hash ATUAL de cada anexo, recalculado do conteúdo. */
  hashesAtuais(anexoIds: string[]): Promise<{ anexoId: string; hash: string }[]>;
  lerConteudoParaEnvio(
    anexoId: string
  ): Promise<{ conteudo: Buffer; mimeType: string; nomeOriginal: string; extensao: string }>;
  /** Segmentos da árvore de destino, já expandidos a partir da regra. */
  segmentosDoItem(item: ItemAnalisado): Promise<SegmentoDestino[] | null>;
  resolverPasta(
    segmentos: SegmentoDestino[],
    empresaId: string | null
  ): Promise<{ ok: true; externalId: string } | { ok: false; erro: string }>;
  enviarArquivo(params: {
    paiId: string;
    nome: string;
    conteudo: Buffer;
    mimeType: string;
  }): Promise<
    | { ok: true; identificadorExterno: string; jaExistia: boolean }
    | { ok: false; erro: string }
  >;
  /** Documento já arquivado com este conteúdo para esta empresa, se houver. */
  documentoPorHash(
    empresaId: string,
    hash: string
  ): Promise<{ id: string; identificadorExterno: string | null; caminho: string | null } | null>;
  /** Próxima versão livre para um caminho lógico dentro da empresa. */
  proximaVersao(empresaId: string, caminhoLogico: string): Promise<number>;
  registrarDocumento(dados: {
    propostaId: string;
    item: ItemAnalisado;
    hash: string;
    versao: number;
    caminhoLogico: string;
    nomeFinal: string;
    identificadorExterno: string;
    pastaExternalId: string;
    mimeType: string;
    tamanhoBytes: number;
    confirmadoPor: string;
  }): Promise<{ documentoId: string }>;
  atualizarProposta(
    propostaId: string,
    dados: { status: string; confirmadaPor: string; erroMensagem?: string | null }
  ): Promise<void>;
};

export type EntradaArquivamento = {
  propostaId: string;
  /** Precisa ser literalmente true. Não há confirmação implícita. */
  confirmar: boolean;
  /** Itens que o usuário confirmou, por anexoId. Vazio = nada é arquivado. */
  anexosConfirmados: string[];
};

/** Só item analisado e sem pendência pode virar arquivo no Drive. */
function itemArquivavel(item: ItemAnalisado): { pode: boolean; motivo?: string } {
  if (item.status === "bloqueado") {
    return { pode: false, motivo: item.bloqueio?.motivo ?? "Arquivo bloqueado." };
  }
  if (item.status !== "analisado") {
    return {
      pode: false,
      motivo: `Item incompleto: falta ${item.camposFaltantes.join(", ") || "informação"}.`,
    };
  }
  if (item.conflitos.length > 0) {
    return { pode: false, motivo: `Conflito não resolvido: ${item.conflitos[0].motivo}` };
  }
  if (!item.caminhoSugerido || !item.nomeSugerido) {
    return { pode: false, motivo: "Item sem caminho ou nome calculado." };
  }
  return { pode: true };
}

export async function arquivarDocumentos(
  entrada: EntradaArquivamento,
  usuarioId: string,
  portas: PortasArquivamento
): Promise<ResultadoArquivamento> {
  if (!usuarioId) {
    return { ok: false, codigo: "sem_usuario", erro: "Arquivamento exige usuário autenticado." };
  }

  // Confirmação é explícita. Não existe "entendi que o usuário concordou".
  if (entrada.confirmar !== true) {
    return {
      ok: false,
      codigo: "sem_confirmacao",
      erro:
        "Arquivamento exige confirmação explícita (confirmar: true) e a lista de anexos. " +
        "Uma resposta ambígua do usuário não é confirmação — pergunte de novo.",
    };
  }

  if (entrada.anexosConfirmados.length === 0) {
    return {
      ok: false,
      codigo: "nada_confirmado",
      erro: "Nenhum anexo foi confirmado. Nada foi arquivado.",
    };
  }

  const proposta = await portas.buscarProposta(entrada.propostaId);
  if (!proposta) {
    return { ok: false, codigo: "proposta_inexistente", erro: "Proposta não encontrada." };
  }

  // Proposta é privada de quem a criou.
  if (proposta.usuarioId !== usuarioId) {
    return {
      ok: false,
      codigo: "proposta_de_outro",
      erro: "Esta proposta pertence a outro usuário.",
    };
  }

  if (proposta.status !== "aguardando") {
    return {
      ok: false,
      codigo: "proposta_resolvida",
      erro: `Esta proposta já está "${proposta.status}". Refaça a análise se precisar arquivar de novo.`,
    };
  }

  if (propostaExpirada(proposta.expiraEm)) {
    await portas.atualizarProposta(proposta.id, {
      status: "expirada",
      confirmadaPor: usuarioId,
    });
    return {
      ok: false,
      codigo: "proposta_expirada",
      erro: "A proposta venceu. Refaça a análise antes de arquivar.",
    };
  }

  // O conteúdo pode ter mudado entre analisar e confirmar. O que foi proposto
  // valia para AQUELE conteúdo.
  const atuais = await portas.hashesAtuais(proposta.anexoIds);
  const validade = propostaAindaValida(proposta.hashes, atuais);
  if (!validade.valida) {
    await portas.atualizarProposta(proposta.id, {
      status: "invalidada",
      confirmadaPor: usuarioId,
      erroMensagem: validade.motivo,
    });
    return { ok: false, codigo: "arquivo_alterado", erro: validade.motivo };
  }

  const hashPorAnexo = new Map(atuais.map((h) => [h.anexoId, h.hash]));
  const confirmados = new Set(entrada.anexosConfirmados);
  const resultados: ItemArquivado[] = [];

  for (const item of proposta.itens) {
    if (!confirmados.has(item.anexoId)) {
      resultados.push({
        anexoId: item.anexoId,
        status: "pulado",
        documentoId: null,
        identificadorExterno: null,
        caminhoFinal: null,
        versao: null,
        erro: "Não confirmado pelo usuário.",
      });
      continue;
    }

    const permitido = itemArquivavel(item);
    if (!permitido.pode) {
      resultados.push({
        anexoId: item.anexoId,
        status: "erro",
        documentoId: null,
        identificadorExterno: null,
        caminhoFinal: null,
        versao: null,
        erro: permitido.motivo ?? "Item não pode ser arquivado.",
      });
      continue;
    }

    const hash = hashPorAnexo.get(item.anexoId) ?? item.hashSha256;
    const empresaId = item.empresa.empresaId;

    try {
      // Retentativa: mesmo conteúdo já arquivado para esta empresa não sobe
      // de novo. É o que torna a operação repetível sem duplicar arquivo.
      if (empresaId) {
        const jaTem = await portas.documentoPorHash(empresaId, hash);
        if (jaTem) {
          resultados.push({
            anexoId: item.anexoId,
            status: "ja_arquivado",
            documentoId: jaTem.id,
            identificadorExterno: jaTem.identificadorExterno,
            caminhoFinal: jaTem.caminho,
            versao: null,
            erro: null,
          });
          continue;
        }
      }

      const segmentos = await portas.segmentosDoItem(item);
      if (!segmentos || segmentos.length === 0) {
        throw new Error("Não foi possível recalcular o destino a partir da regra.");
      }

      const pasta = await portas.resolverPasta(segmentos, empresaId);
      if (!pasta.ok) throw new Error(pasta.erro);

      const arquivo = await portas.lerConteudoParaEnvio(item.anexoId);

      // A versão é decidida agora, não na análise: outro documento pode ter
      // ocupado a v1 entre analisar e confirmar.
      const caminhoPasta = segmentos[segmentos.length - 1].caminhoLogico;
      const versao = empresaId ? await portas.proximaVersao(empresaId, caminhoPasta) : 1;

      const nomeFinal =
        versao === 1
          ? item.nomeSugerido!
          : item.nomeSugerido!.replace(/_v\d+(\.[^.]+)$/, `_v${versao}$1`);

      const envio = await portas.enviarArquivo({
        paiId: pasta.externalId,
        nome: nomeFinal,
        conteudo: arquivo.conteudo,
        mimeType: arquivo.mimeType,
      });
      if (!envio.ok) throw new Error(envio.erro);

      const registro = await portas.registrarDocumento({
        propostaId: proposta.id,
        item,
        hash,
        versao,
        caminhoLogico: caminhoPasta,
        nomeFinal,
        identificadorExterno: envio.identificadorExterno,
        pastaExternalId: pasta.externalId,
        mimeType: arquivo.mimeType,
        tamanhoBytes: arquivo.conteudo.length,
        confirmadoPor: usuarioId,
      });

      resultados.push({
        anexoId: item.anexoId,
        // `jaExistia` significa que o arquivo já estava lá: quase sempre uma
        // retentativa depois de o upload ter dado certo e o registro falhado.
        status: envio.jaExistia ? "ja_arquivado" : "arquivado",
        documentoId: registro.documentoId,
        identificadorExterno: envio.identificadorExterno,
        caminhoFinal: `${caminhoPasta}/${nomeFinal}`,
        versao,
        erro: null,
      });
    } catch (e) {
      // Falha de um item não derruba os outros: o que já subiu está subido.
      resultados.push({
        anexoId: item.anexoId,
        status: "erro",
        documentoId: null,
        identificadorExterno: null,
        caminhoFinal: null,
        versao: null,
        erro: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const resumo = {
    arquivados: resultados.filter((r) => r.status === "arquivado").length,
    jaArquivados: resultados.filter((r) => r.status === "ja_arquivado").length,
    pulados: resultados.filter((r) => r.status === "pulado").length,
    erros: resultados.filter((r) => r.status === "erro").length,
  };

  // "arquivada" só quando nada falhou E nada ficou de fora. Com pendência, o
  // estado é `parcial` — a proposta continua contando a verdade.
  const statusProposta: "arquivada" | "parcial" =
    resumo.erros === 0 && resumo.pulados === 0 ? "arquivada" : "parcial";

  await portas.atualizarProposta(proposta.id, {
    status: statusProposta,
    confirmadaPor: usuarioId,
    erroMensagem:
      resumo.erros > 0
        ? resultados
            .filter((r) => r.status === "erro")
            .map((r) => `${r.anexoId}: ${r.erro}`)
            .join(" | ")
            .slice(0, 500)
        : null,
  });

  return { ok: true, propostaId: proposta.id, statusProposta, itens: resultados, resumo };
}
