import "server-only";
import { supabaseAdmin } from "../supabase-admin";
import { googleDrive } from "../storage/google-drive";
import { lerArquivo } from "../file-store";
import { calcularHashSha256 } from "../documentos/inspecao";
import { expandirDestino, type ContextoArquivamento, type RegraArquivamento } from "./caminhos";
import { nomePastaClientes } from "./estrutura-fixa";
import { resolverArvore } from "./resolvedor-pastas";
import type { ItemAnalisado } from "./analise";
import type { PortasArquivamento, PropostaPersistida } from "./arquivamento";

/**
 * Ligação do arquivamento com Supabase, Storage e Drive.
 *
 * Separado do orquestrador pelo mesmo motivo dos outros: `supabase-admin`
 * valida credenciais na carga do módulo, e a lógica de confirmação precisa
 * rodar em teste sem .env.
 */

async function buscarProposta(propostaId: string): Promise<PropostaPersistida | null> {
  const { data, error } = await supabaseAdmin
    .from("propostas_arquivamento")
    .select("id,usuario_id,status,expira_em,itens,hashes,anexo_ids")
    .eq("id", propostaId)
    .maybeSingle();

  if (error) throw new Error(`Falha ao buscar proposta: ${error.message}`);
  if (!data) return null;

  const linha = data as {
    id: string;
    usuario_id: string;
    status: string;
    expira_em: string;
    itens: unknown;
    hashes: unknown;
    anexo_ids: string[] | null;
  };

  return {
    id: linha.id,
    usuarioId: linha.usuario_id,
    status: linha.status,
    expiraEm: linha.expira_em,
    itens: (Array.isArray(linha.itens) ? linha.itens : []) as ItemAnalisado[],
    hashes: (Array.isArray(linha.hashes) ? linha.hashes : []) as {
      anexoId: string;
      hash: string;
    }[],
    anexoIds: linha.anexo_ids ?? [],
  };
}

type LinhaAnexo = {
  id: string;
  arquivo_id: string;
  nome_original: string;
  extensao: string;
  mime_type: string | null;
};

async function carregarAnexos(ids: string[]): Promise<LinhaAnexo[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from("anexos_agente")
    .select("id,arquivo_id,nome_original,extensao,mime_type")
    .in("id", ids);

  if (error) throw new Error(`Falha ao carregar anexos: ${error.message}`);
  return (data ?? []) as unknown as LinhaAnexo[];
}

/**
 * Hash ATUAL de cada anexo, recalculado do conteúdo no Storage.
 *
 * Anexo que sumiu não entra na lista: a ausência já invalida a proposta, e é
 * assim que `propostaAindaValida` enxerga isso.
 */
async function hashesAtuais(anexoIds: string[]): Promise<{ anexoId: string; hash: string }[]> {
  const anexos = await carregarAnexos(anexoIds);
  const resultado: { anexoId: string; hash: string }[] = [];

  for (const a of anexos) {
    try {
      const buffer = await lerArquivo(a.arquivo_id, a.nome_original);
      resultado.push({ anexoId: a.id, hash: calcularHashSha256(buffer) });
    } catch {
      // Arquivo sumiu do Storage. Deixar de fora invalida a proposta, que é
      // o comportamento certo — não dá para arquivar o que não existe mais.
    }
  }

  return resultado;
}

async function lerConteudoParaEnvio(anexoId: string) {
  const [anexo] = await carregarAnexos([anexoId]);
  if (!anexo) throw new Error(`Anexo ${anexoId} não encontrado.`);

  const conteudo = await lerArquivo(anexo.arquivo_id, anexo.nome_original);
  return {
    conteudo,
    mimeType: anexo.mime_type ?? "application/octet-stream",
    nomeOriginal: anexo.nome_original,
    extensao: anexo.extensao,
  };
}

/**
 * Recalcula a árvore de destino a partir da REGRA, não do caminho gravado na
 * proposta.
 *
 * A proposta guarda um caminho em texto; confiar nele deixaria o destino
 * refém de um campo que alguém pode ter editado. Reexpandir pela regra faz o
 * caminho ser sempre consequência da configuração atual.
 */
async function segmentosDoItem(item: ItemAnalisado) {
  if (!item.regra.valor) return null;

  const { data, error } = await supabaseAdmin
    .from("regras_arquivamento")
    .select(
      "id,codigo,nome,escopo,caminho_modelo,padrao_nome," +
        "exige_empresa,exige_competencia,exige_instituicao,projeto,subcategoria"
    )
    .eq("codigo", item.regra.valor)
    .eq("ativo", true)
    .maybeSingle();

  if (error) throw new Error(`Falha ao carregar a regra: ${error.message}`);
  if (!data) return null;

  const regra = data as unknown as RegraArquivamento;

  let empresaCodigo: string | null = null;
  let empresaNome: string | null = null;
  let pastaClientes: string | null = null;

  if (item.empresa.empresaId) {
    const { data: emp } = await supabaseAdmin
      .from("empresas")
      .select("codigo,razao_social,nome_fantasia,ativo")
      .eq("id", item.empresa.empresaId)
      .maybeSingle();

    if (!emp) throw new Error("Empresa da proposta não existe mais.");
    const e = emp as {
      codigo: string | null;
      razao_social: string | null;
      nome_fantasia: string | null;
      ativo: boolean;
    };

    empresaCodigo = e.codigo;
    empresaNome = e.nome_fantasia ?? e.razao_social;
    // Lido AGORA: o cliente pode ter virado inativo entre analisar e confirmar.
    pastaClientes = await nomePastaClientes(e.ativo);
  }

  const contexto: ContextoArquivamento = {
    empresaId: item.empresa.empresaId,
    empresaCodigo,
    empresaNome,
    pastaClientes,
    competencia: item.competencia.valor,
    instituicao: item.instituicao.valor,
    tipoDocumento: item.tipoDocumento.valor,
  };

  const destino = expandirDestino(regra, contexto);
  return destino.ok ? destino.segmentos : null;
}

async function proximaVersao(empresaId: string, caminhoLogico: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("documentos_operacionais")
    .select("versao")
    .eq("empresa_id", empresaId)
    .eq("caminho_logico", caminhoLogico)
    .eq("ativo", true)
    .order("versao", { ascending: false })
    .limit(1);

  if (error) throw new Error(`Falha ao calcular versão: ${error.message}`);
  const topo = (data ?? [])[0] as { versao: number } | undefined;
  return (topo?.versao ?? 0) + 1;
}

async function documentoPorHash(empresaId: string, hash: string) {
  const { data } = await supabaseAdmin
    .from("documentos_operacionais")
    .select("id,caminho_logico,nome_final")
    .eq("empresa_id", empresaId)
    .eq("hash_sha256", hash)
    .eq("ativo", true)
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  const doc = data as { id: string; caminho_logico: string | null; nome_final: string | null };

  const { data: loc } = await supabaseAdmin
    .from("documento_localizacoes")
    .select("identificador_externo")
    .eq("documento_id", doc.id)
    .limit(1)
    .maybeSingle();

  return {
    id: doc.id,
    identificadorExterno:
      (loc as { identificador_externo: string | null } | null)?.identificador_externo ?? null,
    caminho: doc.caminho_logico && doc.nome_final ? `${doc.caminho_logico}/${doc.nome_final}` : null,
  };
}

async function registrarDocumento(dados: {
  propostaId: string;
  item: ItemAnalisado;
  hash: string;
  versao: number;
  caminhoLogico: string;
  nomeFinal: string;
  identificadorExterno: string;
  provedor: string;
  mimeType: string;
  tamanhoBytes: number;
  confirmadoPor: string;
}): Promise<{ documentoId: string }> {
  const { item } = dados;

  const { data, error } = await supabaseAdmin
    .from("documentos_operacionais")
    .insert({
      empresa_id: item.empresa.empresaId,
      tipo_documento: item.tipoDocumento.valor ?? "NAO_CLASSIFICADO",
      nome_original: item.nomeOriginal,
      // nome_original nunca é sobrescrito; o nome do destino é campo à parte.
      nome_final: dados.nomeFinal,
      extensao: dados.nomeFinal.split(".").pop() ?? "",
      mime_type: dados.mimeType,
      tamanho_bytes: dados.tamanhoBytes,
      hash_sha256: dados.hash,
      versao: dados.versao,
      // CHECK de documentos_operacionais.status: recebido | classificado |
      // armazenado | armazenado_parcial | ...  "arquivado" NÃO existe.
      status: "armazenado",
      origem: "agente",
      instituicao: item.instituicao.valor,
      caminho_logico: dados.caminhoLogico,
      evidencias: item.evidencias,
      classificacao_sugerida: {
        empresa: item.empresa,
        competencia: item.competencia,
        regra: item.regra,
        tipoDocumento: item.tipoDocumento,
      },
      classificacao_confirmada: {
        regra: item.regra.valor,
        competencia: item.competencia.valor,
        tipoDocumento: item.tipoDocumento.valor,
      },
      confirmado_por: dados.confirmadoPor,
      confirmado_em: new Date().toISOString(),
      proposta_id: dados.propostaId,
      created_by: dados.confirmadoPor,
    })
    .select("id")
    .single();

  if (error) throw new Error(`Falha ao registrar documento: ${error.message}`);
  const documentoId = (data as { id: string }).id;

  const { error: erroLoc } = await supabaseAdmin.from("documento_localizacoes").insert({
    documento_id: documentoId,
    // O provedor vem de quem entregou. Fixar "google_drive" faria o banco
    // mentir sobre onde o documento está desde que a rota mudou.
    provedor: dados.provedor ?? "pasta_sincronizada",
    bucket_ou_pasta: dados.caminhoLogico,
    caminho: `${dados.caminhoLogico}/${dados.nomeFinal}`,
    identificador_externo: dados.identificadorExterno,
    nome_utilizado: dados.nomeFinal,
    // CHECK de documento_localizacoes.status: pendente | enviando |
    // armazenado | erro | removido | nao_configurado.
    status: "armazenado",
    armazenado_em: new Date().toISOString(),
    created_by: dados.confirmadoPor,
  });

  if (erroLoc) throw new Error(`Falha ao registrar localização: ${erroLoc.message}`);
  return { documentoId };
}

async function atualizarProposta(
  propostaId: string,
  dados: { status: string; confirmadaPor: string; erroMensagem?: string | null }
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("propostas_arquivamento")
    .update({
      status: dados.status,
      confirmada_por: dados.confirmadaPor,
      confirmada_em: new Date().toISOString(),
      erro_mensagem: dados.erroMensagem ?? null,
    })
    .eq("id", propostaId);

  if (error) throw new Error(`Falha ao atualizar proposta: ${error.message}`);
}

/**
 * Entrega no Google Drive: resolve a árvore de pastas por id e sobe o arquivo.
 *
 * Continua aqui porque a rota volta a fazer sentido se o acesso de aplicativo
 * ao tenant sair um dia. Hoje o destino padrão é a pasta sincronizada.
 */
async function entregarNoDrive(dados: {
  item: ItemAnalisado;
  conteudo: Buffer;
  mimeType: string;
  nomeOriginal: string;
  extensao: string;
}): Promise<
  | {
      ok: true;
      identificador: string;
      caminhoLogico: string;
      nomeFinal: string;
      versao: number;
      jaExistia: boolean;
      provedor: string;
    }
  | { ok: false; erro: string }
> {
  const { item } = dados;

  const segmentos = await segmentosDoItem(item);
  if (!segmentos || segmentos.length === 0) {
    return { ok: false, erro: "Não foi possível recalcular o destino a partir da regra." };
  }

  const arvore = await resolverArvore(segmentos, {
    empresaId: item.empresa.empresaId,
    criar: true,
  });
  if (!arvore.ok) return { ok: false, erro: arvore.erro };

  const caminhoLogico = segmentos[segmentos.length - 1].caminhoLogico;
  const versao = item.empresa.empresaId
    ? await proximaVersao(item.empresa.empresaId, caminhoLogico)
    : 1;

  const nomeFinal =
    versao === 1
      ? item.nomeSugerido!
      : item.nomeSugerido!.replace(/_v\d+(\.[^.]+)$/, `_v${versao}$1`);

  const envio = await googleDrive.enviarNaPasta({
    paiId: arvore.folha.externalId,
    nome: nomeFinal,
    conteudo: dados.conteudo,
    mimeType: dados.mimeType,
  });
  if (!envio.ok) return { ok: false, erro: envio.erro };

  return {
    ok: true,
    identificador: envio.identificadorExterno,
    caminhoLogico,
    nomeFinal,
    versao,
    jaExistia: envio.jaExistia,
    provedor: "google_drive",
  };
}

export function portasArquivamentoPadrao(): PortasArquivamento {
  return {
    buscarProposta,
    hashesAtuais,
    lerConteudoParaEnvio,
    entregarArquivo: entregarNoDrive,
    documentoPorHash,
    registrarDocumento,
    atualizarProposta,
  };
}

/**
 * Portas compartilhadas entre os destinos.
 *
 * Buscar proposta, conferir hash, ler conteúdo e registrar no banco é igual
 * seja qual for o destino — só a ENTREGA muda.
 */
export const portasComuns = {
  buscarProposta,
  hashesAtuais,
  lerConteudoParaEnvio,
  documentoPorHash,
  registrarDocumento,
  atualizarProposta,
};
