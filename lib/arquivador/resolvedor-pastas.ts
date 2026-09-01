import type { SegmentoDestino } from "./caminhos";

/**
 * Resolve uma árvore de pastas no Google Drive de forma IDEMPOTENTE.
 *
 * O problema real: o Drive aceita duas pastas com o mesmo nome no mesmo pai.
 * Um "procurou, não achou, criou" ingênuo produz pastas irmãs idênticas quando
 * duas execuções acontecem juntas — e aí os documentos de um mesmo cliente se
 * espalham por duas pastas visualmente iguais. Isso é corrupção silenciosa: o
 * usuário vê a pasta certa, com metade dos arquivos.
 *
 * A defesa tem três camadas:
 *
 *   1. `pastas_drive` é a FONTE DE VERDADE. Se a chave lógica já está mapeada
 *      e ativa, usamos o external_id gravado e nem consultamos o Drive.
 *   2. Trava em memória por chave lógica: serializa as corridas dentro do
 *      mesmo processo, que é o caso comum (dois uploads na mesma conversa).
 *   3. Convergência determinística: quando duas instâncias criam a mesma pasta
 *      ao mesmo tempo, ambas releem a lista e adotam a MAIS ANTIGA. As duas
 *      chegam à mesma conclusão sem combinar nada.
 *
 * NADA É APAGADO. Se sobra uma pasta órfã de uma corrida, ela é registrada
 * com status 'substituida' e chave própria, para um humano decidir depois.
 * Apagar sozinho no Drive de produção é risco que não compensa.
 *
 * As dependências entram por `portas` para o algoritmo ser testável sem rede
 * e sem banco — a lógica de corrida é justamente a parte que precisa de
 * teste, e ela não pode depender de conseguir provocar uma corrida real.
 */

export type PastaResolvida = {
  chaveLogica: string;
  externalId: string;
  nome: string;
  caminhoLogico: string;
  /** true se ESTA execução criou a pasta no Drive. */
  criada: boolean;
};

export type ResultadoResolucao =
  | { ok: true; pastas: PastaResolvida[]; folha: PastaResolvida }
  | { ok: false; erro: string; naoConfigurado?: boolean };

export type LinhaPasta = {
  id: string;
  chave_logica: string;
  external_id: string;
  nome: string;
  caminho_logico: string;
  status: string;
};

export type ItemDrive = { id: string; createdTime: string };

/** Dependências externas do resolvedor. */
export type PortasResolvedor = {
  pastaRaizId(): string | null;
  listarPastasPorNome(nome: string, paiId: string): Promise<ItemDrive[]>;
  criarPasta(nome: string, paiId: string): Promise<string>;

  buscarMapeamento(chaveLogica: string): Promise<LinhaPasta | null>;
  /**
   * Insere o mapeamento. Se a chave já existir (corrida perdida), devolve
   * `{ conflito: true }` sem sobrescrever — a unique do banco é o árbitro.
   */
  inserirMapeamento(dados: {
    segmento: SegmentoDestino;
    externalId: string;
    parentExternalId: string;
    pastaPaiId: string | null;
    empresaId: string | null;
  }): Promise<{ linha: LinhaPasta; conflito: false } | { conflito: true }>;
  /** Reaponta uma linha existente para um novo external_id, reativando-a. */
  reapontarMapeamento(dados: {
    id: string;
    segmento: SegmentoDestino;
    externalId: string;
    parentExternalId: string;
    pastaPaiId: string | null;
  }): Promise<LinhaPasta>;
  registrarOrfa(segmento: SegmentoDestino, externalId: string): Promise<void>;
};

/**
 * Travas por chave lógica, válidas dentro deste processo.
 *
 * Não substituem a garantia do banco (a unique de chave_logica) — só evitam
 * que a instância corra contra si mesma, que é a corrida mais provável.
 */
const travas = new Map<string, Promise<unknown>>();

async function comTrava<T>(chave: string, tarefa: () => Promise<T>): Promise<T> {
  const anterior = travas.get(chave) ?? Promise.resolve();

  // Encadeia nos dois ramos: uma falha anterior não pode travar a chave
  // para sempre.
  const atual = anterior.then(tarefa, tarefa);

  // O marcador nunca rejeita — senão a próxima da fila herdaria a rejeição.
  const marcador = atual.catch(() => undefined);
  travas.set(chave, marcador);

  try {
    return await atual;
  } finally {
    // Só limpa se ninguém entrou na fila atrás de nós.
    if (travas.get(chave) === marcador) travas.delete(chave);
  }
}

/** Resolve UM nível: devolve a linha de pastas_drive, criando se preciso. */
async function resolverNivel(
  portas: PortasResolvedor,
  params: {
    segmento: SegmentoDestino;
    parentExternalId: string;
    pastaPaiId: string | null;
    empresaId: string | null;
    criar: boolean;
  }
): Promise<{ linha: LinhaPasta; criada: boolean }> {
  const { segmento, parentExternalId, pastaPaiId, empresaId, criar } = params;

  return comTrava(segmento.chaveLogica, async () => {
    // 1. O banco manda. Mapeado e ativo? Nem falamos com o Drive.
    const existente = await portas.buscarMapeamento(segmento.chaveLogica);
    if (existente && existente.status === "ativa") {
      return { linha: existente, criada: false };
    }

    /**
     * Uma linha que existe mas NÃO está ativa (pasta foi para a lixeira, ou
     * ficou inacessível) precisa ser reapontada, não reinserida: a unique de
     * chave_logica rejeitaria o insert e voltaríamos com o external_id morto.
     */
    const gravar = async (externalId: string): Promise<LinhaPasta> => {
      if (existente) {
        return portas.reapontarMapeamento({
          id: existente.id,
          segmento,
          externalId,
          parentExternalId,
          pastaPaiId,
        });
      }

      const r = await portas.inserirMapeamento({
        segmento,
        externalId,
        parentExternalId,
        pastaPaiId,
        empresaId,
      });
      if (!r.conflito) return r.linha;

      // Outra execução gravou esta chave entre a nossa leitura e a escrita.
      // Quem chegou primeiro venceu; adotamos o resultado dela.
      const vencedor = await portas.buscarMapeamento(segmento.chaveLogica);
      if (!vencedor) {
        throw new Error(
          `Conflito ao gravar a pasta "${segmento.caminhoLogico}" sem vencedor legível. ` +
            "Verifique pastas_drive antes de continuar."
        );
      }
      return vencedor;
    };

    // 2. Não mapeado: a pasta pode já existir no Drive de antes. Adotamos a
    //    mais antiga em vez de criar uma nova ao lado.
    const encontradas = await portas.listarPastasPorNome(segmento.nome, parentExternalId);
    if (encontradas.length > 0) {
      return { linha: await gravar(encontradas[0].id), criada: false };
    }

    if (!criar) {
      throw new Error(
        `A pasta "${segmento.caminhoLogico}" não existe no Drive e a criação está desligada.`
      );
    }

    // 3. Criar e reler. Se alguém criou junto, as duas execuções convergem
    //    para a mais antiga, sem precisar combinar nada.
    const criadoId = await portas.criarPasta(segmento.nome, parentExternalId);
    const depois = await portas.listarPastasPorNome(segmento.nome, parentExternalId);
    const vencedoraDrive = depois[0]?.id ?? criadoId;

    const linha = await gravar(vencedoraDrive);

    // Criamos uma pasta que não virou a oficial: registra para auditoria.
    // Não apagamos — é o Drive de produção.
    if (linha.external_id !== criadoId) {
      await portas.registrarOrfa(segmento, criadoId);
    }

    return { linha, criada: linha.external_id === criadoId };
  });
}

/**
 * Resolve a árvore inteira, de cima para baixo, devolvendo a pasta folha.
 *
 * `criar: false` confere a estrutura sem alterar nada no Drive.
 */
export async function resolverArvore(
  segmentos: SegmentoDestino[],
  opcoes: { empresaId?: string | null; criar?: boolean } = {},
  portas?: PortasResolvedor
): Promise<ResultadoResolucao> {
  const { empresaId = null, criar = true } = opcoes;

  // Importa as portas reais só quando ninguém injetou: assim o módulo pode
  // ser carregado em teste sem exigir credenciais de Supabase no ambiente.
  const p = portas ?? (await import("./portas-supabase")).portasPadrao();

  const raizId = p.pastaRaizId();
  if (!raizId) {
    return {
      ok: false,
      naoConfigurado: true,
      erro:
        "Google Drive não configurado. Faltam variáveis de ambiente da integração " +
        "(rode `npm run drive:verificar` para ver quais).",
    };
  }

  if (segmentos.length === 0) {
    return { ok: false, erro: "Nenhum segmento de caminho para resolver." };
  }

  const pastas: PastaResolvida[] = [];
  let parentExternalId = raizId;
  let pastaPaiId: string | null = null;

  for (const segmento of segmentos) {
    try {
      const { linha, criada } = await resolverNivel(p, {
        segmento,
        parentExternalId,
        pastaPaiId,
        empresaId,
        criar,
      });

      pastas.push({
        chaveLogica: linha.chave_logica,
        externalId: linha.external_id,
        nome: linha.nome,
        caminhoLogico: linha.caminho_logico,
        criada,
      });

      parentExternalId = linha.external_id;
      pastaPaiId = linha.id;
    } catch (e) {
      const detalhe = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        erro: `Falha ao resolver "${segmento.caminhoLogico}": ${detalhe}`,
      };
    }
  }

  return { ok: true, pastas, folha: pastas[pastas.length - 1] };
}

/** Só para teste: limpa as travas em memória entre casos. */
export function _limparTravas(): void {
  travas.clear();
}
