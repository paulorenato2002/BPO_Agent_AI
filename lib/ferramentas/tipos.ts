import "server-only";

/**
 * Contrato das ferramentas que o agente pode executar.
 *
 * O catálogo vive no CÓDIGO (ToolRegistry), nunca no banco — o banco guarda
 * apenas o registro das execuções (`execucoes_ferramenta`) e o código da
 * ferramenta referenciado pelas etapas de rotina. Nenhum código executável é
 * armazenado no banco.
 */

export type NivelRisco = "baixo" | "medio" | "alto" | "critico";
export type ModoExecucao = "sincrono" | "assincrono";

/** Contexto de quem está executando. Nunca contém segredos. */
export type ContextoExecucao = {
  usuarioId: string | null;
  /**
   * Conversa e mensagem em que a ferramenta foi chamada.
   *
   * Vêm do SERVIDOR, nunca do modelo: ele não tem como saber esses ids, e
   * deixá-lo informar seria abrir caminho para uma ferramenta agir sobre a
   * conversa de outra pessoa.
   */
  conversaId?: string | null;
  mensagemId?: string | null;
  empresaId?: string | null;
  competenciaId?: string | null;
  tarefaOperacionalId?: string | null;
  /** Repetir a mesma chave não cria uma segunda execução. */
  chaveIdempotencia?: string | null;
};

/** Arquivo produzido por uma ferramenta, para registro em documentos_operacionais. */
export type ArquivoProduzido = {
  nomeOriginal: string;
  conteudo: Buffer;
  mimeType: string;
  tipoDocumento: string;
};

export type ResultadoFerramenta<S = unknown> =
  | { ok: true; saida: S; arquivos?: ArquivoProduzido[]; resumo: string }
  | { ok: false; erro: string; codigoErro?: string; detalhes?: unknown };

/**
 * Validador de entrada/saída. Recebe dado desconhecido e devolve o dado tipado
 * ou a lista de problemas. Deliberadamente simples: não amarra o projeto a uma
 * biblioteca de schema específica.
 */
export type Validador<T> = (dado: unknown) =>
  | { valido: true; dado: T }
  | { valido: false; problemas: string[] };

export type DefinicaoFerramenta<E = unknown, S = unknown> = {
  /** Identificador estável. Usado em etapas_modelo_rotina.ferramenta_codigo. */
  codigo: string;
  nome: string;
  /** Descrição que o MODELO lê para decidir quando usar. Seja específico. */
  descricao: string;
  versao: string;
  /** Schema JSON exposto ao modelo (formato de function calling da OpenAI). */
  schemaEntrada: Record<string, unknown>;
  /** Documenta o formato de saída. Não é enviado ao modelo. */
  schemaSaida?: Record<string, unknown>;
  validarEntrada: Validador<E>;
  nivelRisco: NivelRisco;
  modo: ModoExecucao;
  timeoutMs: number;
  tentativas: number;
  /** true => cria aprovacoes_operacionais e aguarda decisão humana. */
  exigeAprovacao: boolean;
  /** Se false, a ferramenta existe no registro mas o agente não a enxerga. */
  disponivelParaAgente: boolean;
  handler: (entrada: E, contexto: ContextoExecucao) => Promise<ResultadoFerramenta<S>>;
};

export class ErroFerramenta extends Error {
  constructor(
    message: string,
    readonly codigo: string = "erro_ferramenta",
    readonly detalhes?: unknown
  ) {
    super(message);
    this.name = "ErroFerramenta";
  }
}
