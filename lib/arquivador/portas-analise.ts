import "server-only";
import { supabaseAdmin } from "../supabase-admin";
import { openai, CHAT_MODEL, REASONING_EFFORT } from "../openai-client";
import { lerArquivo } from "../file-store";
import { parseArquivo } from "../file-extract";
import { calcularHashSha256 } from "../documentos/inspecao";
import { buscarAnexosDoUsuario } from "../repositorios/anexos";
import { nomePastaClientes } from "./estrutura-fixa";
import type {
  AnexoRegistrado,
  ClassificacaoModelo,
  ItemAnalisado,
  PortasAnalise,
  PropostaGerada,
} from "./analise";
import type { RegraArquivamento } from "./caminhos";
import type { EmpresaCandidata } from "./identificar-empresa";

/**
 * Ligação da análise com Supabase, Storage e modelo.
 *
 * Separado do orquestrador pelo mesmo motivo do resolvedor de pastas:
 * `supabase-admin` exige credenciais já na carga do módulo, e a lógica de
 * análise é justamente a parte que precisa rodar em teste sem .env.
 */

/**
 * Instrução do classificador.
 *
 * O modelo escolhe CÓDIGO de regra e preenche campos. Ele não vê caminho,
 * não vê pasta e não vê id do Drive — o destino é calculado pelo código, a
 * partir da regra que veio do banco.
 */
const INSTRUCAO = `Você classifica documentos de um BPO financeiro brasileiro.

Responda SOMENTE com JSON no formato:
{"regraCodigo": string|null, "tipoDocumento": string|null, "instituicao": string|null,
 "dataDocumento": "AAAA-MM-DD"|null, "competencia": "AAAA-MM"|null, "justificativa": string}

Regras:
- regraCodigo TEM de ser um dos códigos da lista fornecida. Se nenhum servir, use null.
- Nunca invente caminho de pasta, nome de arquivo ou identificador do Drive.
- Campo que você não conseguir determinar com segurança: null. Não chute.
- tipoDocumento é curto e em maiúsculas (ex.: NOTA_FISCAL, EXTRATO, BOLETO).
- instituicao só quando o documento for de um banco/adquirente identificável.`;

async function lerConteudo(
  anexo: AnexoRegistrado
): Promise<{ texto: string; hashAtual: string }> {
  const buffer = await lerArquivo(anexo.arquivo_id, anexo.nome_original);

  // Hash RECALCULADO do conteúdo atual: o arquivo no Storage pode ter sido
  // substituído desde o upload, e é isso que invalida uma proposta.
  const hashAtual = calcularHashSha256(buffer);
  const parsed = await parseArquivo(anexo.nome_original, buffer);

  const texto =
    parsed.tipo === "tabular"
      ? `${parsed.colunas.join(" | ")}\n${JSON.stringify(parsed.linhas.slice(0, 200))}`
      : parsed.texto;

  return { texto, hashAtual };
}

async function listarEmpresasVisiveis(usuarioId: string): Promise<EmpresaCandidata[]> {
  // Hoje todo usuário interno ativo enxerga a carteira inteira — é o que a RLS
  // de `empresas` já define. A assinatura recebe o usuário para que restringir
  // por carteira depois seja uma mudança aqui, e não no orquestrador.
  void usuarioId;

  const { data, error } = await supabaseAdmin
    .from("empresas")
    .select("id,codigo,razao_social,nome_fantasia,cnpj,ativo");

  if (error) throw new Error(`Falha ao listar empresas: ${error.message}`);
  return (data ?? []) as unknown as EmpresaCandidata[];
}

async function listarRegrasAtivas(): Promise<RegraArquivamento[]> {
  const { data, error } = await supabaseAdmin
    .from("regras_arquivamento")
    .select(
      "id,codigo,nome,escopo,caminho_modelo,padrao_nome," +
        "exige_empresa,exige_competencia,exige_instituicao,projeto,subcategoria"
    )
    .eq("ativo", true)
    .order("codigo");

  if (error) throw new Error(`Falha ao listar regras: ${error.message}`);
  return (data ?? []) as unknown as RegraArquivamento[];
}

async function conversaPertenceAoUsuario(
  conversaId: string,
  usuarioId: string
): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("conversas_agente")
    .select("id")
    .eq("id", conversaId)
    .eq("usuario_id", usuarioId)
    .maybeSingle();
  return Boolean(data);
}

async function mensagemPertenceAConversa(
  mensagemId: string,
  conversaId: string
): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("mensagens_agente")
    .select("id")
    .eq("id", mensagemId)
    .eq("conversa_id", conversaId)
    .maybeSingle();
  return Boolean(data);
}

async function buscarDocumentoPorHash(
  empresaId: string,
  hash: string
): Promise<{ id: string; nome: string } | null> {
  const { data } = await supabaseAdmin
    .from("documentos_operacionais")
    .select("id,nome_final,nome_original")
    .eq("empresa_id", empresaId)
    .eq("hash_sha256", hash)
    .eq("ativo", true)
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  const linha = data as { id: string; nome_final: string | null; nome_original: string };
  return { id: linha.id, nome: linha.nome_final ?? linha.nome_original };
}

function montarProposta(linha: {
  id: string;
  expira_em: string;
  itens: unknown;
}): PropostaGerada {
  const itens = (Array.isArray(linha.itens) ? linha.itens : []) as ItemAnalisado[];
  return {
    propostaId: linha.id,
    status: "aguardando",
    expiraEm: linha.expira_em,
    itens,
    resumo: {
      total: itens.length,
      prontos: itens.filter((i) => i.status === "analisado").length,
      incompletos: itens.filter((i) => i.status === "incompleto").length,
      bloqueados: itens.filter((i) => i.status === "bloqueado").length,
      empresasDistintas: new Set(
        itens.map((i) => i.empresa?.empresaId).filter(Boolean)
      ).size,
    },
  };
}

async function propostaPorChaveIdempotencia(chave: string): Promise<PropostaGerada | null> {
  const { data } = await supabaseAdmin
    .from("propostas_arquivamento")
    .select("id,expira_em,itens,status")
    .eq("chave_idempotencia", chave)
    .maybeSingle();

  if (!data) return null;
  const linha = data as { id: string; expira_em: string; itens: unknown; status: string };

  // Proposta já resolvida não é reaproveitável: repetir a chave depois de
  // confirmar não pode ressuscitar o estado "aguardando".
  if (linha.status !== "aguardando") return null;
  return montarProposta(linha);
}

async function salvarProposta(dados: {
  usuarioId: string;
  conversaId: string | null;
  mensagemId: string | null;
  anexoIds: string[];
  itens: ItemAnalisado[];
  hashes: { anexoId: string; hash: string }[];
  chaveIdempotencia: string | null;
}): Promise<{ id: string; expiraEm: string }> {
  const { data, error } = await supabaseAdmin
    .from("propostas_arquivamento")
    .insert({
      usuario_id: dados.usuarioId,
      conversa_id: dados.conversaId,
      mensagem_id: dados.mensagemId,
      anexo_ids: dados.anexoIds,
      status: "aguardando",
      itens: dados.itens,
      hashes: dados.hashes,
      chave_idempotencia: dados.chaveIdempotencia,
    })
    .select("id,expira_em")
    .single();

  if (error) throw new Error(`Falha ao salvar proposta: ${error.message}`);
  const linha = data as { id: string; expira_em: string };
  return { id: linha.id, expiraEm: linha.expira_em };
}

async function classificar(pedido: {
  nomeArquivo: string;
  texto: string;
  regrasDisponiveis: { codigo: string; nome: string; escopo: string }[];
}): Promise<ClassificacaoModelo> {
  const catalogo = pedido.regrasDisponiveis
    .map((r) => `- ${r.codigo} (${r.escopo}): ${r.nome}`)
    .join("\n");

  try {
    const resposta = await openai.chat.completions.create({
      model: CHAT_MODEL,
      reasoning_effort: REASONING_EFFORT,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${INSTRUCAO}\n\nRegras disponíveis:\n${catalogo}` },
        {
          role: "user",
          content: `Arquivo: ${pedido.nomeArquivo}\n\nConteúdo:\n"""\n${pedido.texto}\n"""`,
        },
      ],
    });

    const bruto = resposta.choices[0]?.message?.content ?? "{}";
    const json = JSON.parse(bruto) as Record<string, unknown>;

    const texto = (chave: string): string | null => {
      const v = json[chave];
      return typeof v === "string" && v.trim() ? v.trim() : null;
    };

    return {
      regraCodigo: texto("regraCodigo"),
      tipoDocumento: texto("tipoDocumento"),
      instituicao: texto("instituicao"),
      dataDocumento: texto("dataDocumento"),
      competencia: texto("competencia"),
      justificativa: texto("justificativa"),
    };
  } catch {
    // Falha do modelo não pode virar classificação inventada. Sem código de
    // regra, o item fica incompleto e o humano decide.
    return {
      regraCodigo: null,
      tipoDocumento: null,
      justificativa: "O classificador não respondeu; nenhum campo foi inferido.",
    };
  }
}

export function portasAnalisePadrao(): PortasAnalise {
  return {
    buscarAnexosDoUsuario,
    conversaPertenceAoUsuario,
    mensagemPertenceAConversa,
    lerConteudo,
    listarEmpresasVisiveis,
    listarRegrasAtivas,
    nomePastaClientes,
    buscarDocumentoPorHash,
    propostaPorChaveIdempotencia,
    salvarProposta,
    classificar,
  };
}
