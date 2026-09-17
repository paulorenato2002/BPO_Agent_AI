import "server-only";
import type {
  ContextoExecucao,
  DefinicaoFerramenta,
  ResultadoFerramenta,
} from "./tipos";

/**
 * Registro central de ferramentas (ToolRegistry).
 *
 * Responsabilidades, sempre na mesma ordem:
 *   1. validar a entrada;
 *   2. registrar a execução em `execucoes_ferramenta` (antes de executar);
 *   3. respeitar idempotência — a mesma chave nunca executa duas vezes;
 *   4. exigir aprovação quando a ferramenta for sensível;
 *   5. executar com timeout e tentativas;
 *   6. normalizar a saída;
 *   7. registrar resultado ou erro;
 *   8. registrar evento no histórico append-only.
 *
 * NESTA FASE nenhuma ferramenta de negócio está registrada. O registro existe
 * vazio, pronto para receber a primeira — ver docs/como_adicionar_nova_ferramenta.md.
 */

/**
 * Acesso ao banco, carregado sob demanda.
 *
 * `supabase-admin` valida credenciais na carga do modulo. Enumerar o catalogo
 * de ferramentas nao deveria exigir isso — so a EXECUCAO fala com o Supabase.
 */
async function bd() {
  const { supabaseAdmin } = await import("../supabase-admin");
  return supabaseAdmin;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QualquerFerramenta = DefinicaoFerramenta<any, any>;

class RegistroFerramentas {
  private readonly ferramentas = new Map<string, QualquerFerramenta>();

  registrar(ferramenta: QualquerFerramenta): void {
    const chave = ferramenta.codigo;
    if (this.ferramentas.has(chave)) {
      throw new Error(`Ferramenta "${chave}" já registrada. Códigos devem ser únicos.`);
    }
    this.ferramentas.set(chave, ferramenta);
  }

  /**
   * Troca a definição de uma ferramenta que JÁ existe (recarga de módulo em
   * desenvolvimento). Código novo continua passando por `registrar`.
   */
  substituir(ferramenta: QualquerFerramenta): void {
    if (!this.ferramentas.has(ferramenta.codigo)) {
      throw new Error(`Ferramenta "${ferramenta.codigo}" não está registrada para ser substituída.`);
    }
    this.ferramentas.set(ferramenta.codigo, ferramenta);
  }

  obter(codigo: string): QualquerFerramenta | undefined {
    return this.ferramentas.get(codigo);
  }

  listar(): QualquerFerramenta[] {
    return [...this.ferramentas.values()];
  }

  /** Só as ferramentas que o agente pode enxergar/chamar. */
  listarParaAgente(): QualquerFerramenta[] {
    return this.listar().filter((f) => f.disponivelParaAgente);
  }

  /** Converte o catálogo para o formato de tools da OpenAI. */
  comoToolsOpenAI() {
    return this.listarParaAgente().map((f) => ({
      type: "function" as const,
      function: {
        name: f.codigo,
        description: f.descricao,
        parameters: f.schemaEntrada,
      },
    }));
  }

  /** Usado nos testes para isolar casos. */
  _limpar(): void {
    this.ferramentas.clear();
  }
}

export const registroFerramentas = new RegistroFerramentas();

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

type RegistroExecucao = { id: string; jaConcluida: boolean; saidaAnterior?: unknown };

async function abrirExecucao(
  ferramenta: QualquerFerramenta,
  entrada: unknown,
  contexto: ContextoExecucao
): Promise<RegistroExecucao> {
  // Idempotência: se já existe execução concluída com a mesma chave, devolve a
  // anterior em vez de executar de novo.
  if (contexto.chaveIdempotencia) {
    const { data } = await (await bd())
      .from("execucoes_ferramenta")
      .select("id, status, saida")
      .eq("chave_idempotencia", contexto.chaveIdempotencia)
      .maybeSingle();

    if (data) {
      return {
        id: data.id as string,
        jaConcluida: data.status === "concluida",
        saidaAnterior: data.saida,
      };
    }
  }

  const { data, error } = await (await bd())
    .from("execucoes_ferramenta")
    .insert({
      ferramenta_codigo: ferramenta.codigo,
      ferramenta_versao: ferramenta.versao,
      usuario_id: contexto.usuarioId,
      empresa_id: contexto.empresaId ?? null,
      competencia_id: contexto.competenciaId ?? null,
      tarefa_operacional_id: contexto.tarefaOperacionalId ?? null,
      entrada: entrada as Record<string, unknown>,
      status: "validando",
      chave_idempotencia: contexto.chaveIdempotencia ?? null,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Não foi possível registrar a execução: ${error.message}`);
  return { id: data.id as string, jaConcluida: false };
}

async function atualizarExecucao(
  id: string,
  campos: Record<string, unknown>
): Promise<void> {
  const { error } = await (await bd())
    .from("execucoes_ferramenta")
    .update(campos)
    .eq("id", id);
  if (error) {
    // Não derruba a execução por falha de telemetria, mas deixa rastro.
    console.error(`[ferramentas] falha ao atualizar execução ${id}: ${error.message}`);
  }
}

export async function registrarEvento(evento: {
  tipoEvento: string;
  descricao: string;
  severidade?: "debug" | "info" | "aviso" | "erro" | "critico";
  empresaId?: string | null;
  competenciaId?: string | null;
  usuarioId?: string | null;
  documentoId?: string | null;
  execucaoFerramentaId?: string | null;
  entidadeTipo?: string | null;
  entidadeId?: string | null;
  dados?: Record<string, unknown>;
  origem?: "agente" | "aplicacao" | "usuario" | "sistema" | "integracao";
}): Promise<void> {
  const { error } = await (await bd()).from("eventos_operacionais").insert({
    tipo_evento: evento.tipoEvento,
    descricao: evento.descricao,
    severidade: evento.severidade ?? "info",
    empresa_id: evento.empresaId ?? null,
    competencia_id: evento.competenciaId ?? null,
    usuario_id: evento.usuarioId ?? null,
    documento_id: evento.documentoId ?? null,
    execucao_ferramenta_id: evento.execucaoFerramentaId ?? null,
    entidade_tipo: evento.entidadeTipo ?? null,
    entidade_id: evento.entidadeId ?? null,
    dados: evento.dados ?? {},
    origem: evento.origem ?? "agente",
  });
  if (error) {
    console.error(`[eventos] falha ao registrar "${evento.tipoEvento}": ${error.message}`);
  }
}

function comTimeout<T>(promessa: Promise<T>, ms: number, codigo: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Ferramenta "${codigo}" excedeu o timeout de ${ms}ms.`)),
      ms
    );
    promessa.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

/**
 * Executa uma ferramenta pelo código, com todo o ciclo de registro.
 *
 * Nunca lança para erro previsível: devolve `{ ok: false, erro }`, para que o
 * agente possa explicar o problema ao usuário em vez de quebrar a conversa.
 */
export async function executarFerramenta(
  codigo: string,
  entradaBruta: unknown,
  contexto: ContextoExecucao
): Promise<ResultadoFerramenta> {
  const ferramenta = registroFerramentas.obter(codigo);
  if (!ferramenta) {
    return {
      ok: false,
      erro: `Ferramenta "${codigo}" não existe no registro.`,
      codigoErro: "ferramenta_inexistente",
    };
  }

  // 1. Validação — antes de qualquer registro ou efeito colateral.
  const validacao = ferramenta.validarEntrada(entradaBruta);
  if (!validacao.valido) {
    return {
      ok: false,
      erro: `Entrada inválida para "${codigo}": ${validacao.problemas.join("; ")}`,
      codigoErro: "entrada_invalida",
      detalhes: validacao.problemas,
    };
  }

  let execucao: RegistroExecucao;
  try {
    execucao = await abrirExecucao(ferramenta, validacao.dado, contexto);
  } catch (e) {
    return {
      ok: false,
      erro: e instanceof Error ? e.message : String(e),
      codigoErro: "falha_registro_execucao",
    };
  }

  // 2. Idempotência: devolve o resultado anterior sem reexecutar.
  if (execucao.jaConcluida) {
    return {
      ok: true,
      saida: execucao.saidaAnterior,
      resumo: "Execução já realizada anteriormente (idempotência).",
    };
  }

  // 3. Aprovação humana para ações sensíveis.
  if (ferramenta.exigeAprovacao) {
    await atualizarExecucao(execucao.id, { status: "aguardando_aprovacao" });
    const { error } = await (await bd()).from("aprovacoes_operacionais").insert({
      execucao_ferramenta_id: execucao.id,
      empresa_id: contexto.empresaId ?? null,
      acao: ferramenta.codigo,
      nivel_risco: ferramenta.nivelRisco,
      descricao: `Aprovação necessária para executar "${ferramenta.nome}".`,
      payload: validacao.dado as Record<string, unknown>,
      solicitante_id: contexto.usuarioId,
    });
    if (error) {
      await atualizarExecucao(execucao.id, {
        status: "erro",
        erro_mensagem: `Falha ao solicitar aprovação: ${error.message}`,
      });
      return { ok: false, erro: error.message, codigoErro: "falha_aprovacao" };
    }
    return {
      ok: false,
      erro: `"${ferramenta.nome}" exige aprovação. A solicitação foi registrada e aguarda decisão.`,
      codigoErro: "aguardando_aprovacao",
    };
  }

  // 4. Execução com timeout e tentativas.
  const inicio = Date.now();
  await atualizarExecucao(execucao.id, {
    status: "executando",
    iniciada_em: new Date().toISOString(),
  });

  let ultimoErro = "";
  for (let tentativa = 1; tentativa <= Math.max(1, ferramenta.tentativas); tentativa++) {
    try {
      const resultado = await comTimeout(
        ferramenta.handler(validacao.dado, contexto),
        ferramenta.timeoutMs,
        codigo
      );

      if (resultado.ok) {
        await atualizarExecucao(execucao.id, {
          status: "concluida",
          saida: resultado.saida as Record<string, unknown>,
          concluida_em: new Date().toISOString(),
          duracao_ms: Date.now() - inicio,
          tentativas: tentativa,
        });
        await registrarEvento({
          tipoEvento: "execucao_concluida",
          descricao: `Ferramenta "${ferramenta.nome}" concluída.`,
          empresaId: contexto.empresaId,
          usuarioId: contexto.usuarioId,
          execucaoFerramentaId: execucao.id,
          dados: { ferramenta: codigo, tentativas: tentativa },
        });
        return resultado;
      }

      ultimoErro = resultado.erro;
      // Erro de regra de negócio não se resolve repetindo.
      break;
    } catch (e) {
      ultimoErro = e instanceof Error ? e.message : String(e);
      if (tentativa < ferramenta.tentativas) {
        await new Promise((r) => setTimeout(r, 250 * tentativa));
      }
    }
  }

  await atualizarExecucao(execucao.id, {
    status: "erro",
    erro_mensagem: ultimoErro || "Falha desconhecida.",
    concluida_em: new Date().toISOString(),
    duracao_ms: Date.now() - inicio,
    tentativas: ferramenta.tentativas,
  });
  await registrarEvento({
    tipoEvento: "execucao_erro",
    descricao: `Ferramenta "${ferramenta.nome}" falhou: ${ultimoErro}`,
    severidade: "erro",
    empresaId: contexto.empresaId,
    usuarioId: contexto.usuarioId,
    execucaoFerramentaId: execucao.id,
    dados: { ferramenta: codigo },
  });

  return { ok: false, erro: ultimoErro || "Falha desconhecida.", codigoErro: "erro_execucao" };
}
