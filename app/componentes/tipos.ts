/** Tipos compartilhados entre os componentes da interface (lado cliente). */

export type EstadoIntegracao = "conectado" | "indisponivel" | "nao_configurado";

export type ItemSaude = {
  chave: string;
  nome: string;
  estado: EstadoIntegracao;
  detalhe: string;
};

export type Conversa = {
  id: string;
  titulo: string;
  status: "ativa" | "arquivada" | "excluida";
  iniciadaEm: string;
  ultimaAtividadeEm: string;
};

export type MotivoIndisponivel = "banco_nao_migrado" | "sem_autenticacao" | "erro";

export type EstadoHistorico =
  | { disponivel: true; dados: Conversa[] }
  | { disponivel: false; motivo: MotivoIndisponivel; detalhe: string };

export type UsuarioSessao =
  | { autenticado: true; usuario: { id: string; email: string | null; nome: string | null; papel: string | null } }
  | { autenticado: false; detalhe: string };

/** Estado de um destino de armazenamento no cartão de arquivo. */
export type EstadoDestino = "aguardando" | "enviando" | "sucesso" | "erro" | "nao_configurado";

export type DestinoArmazenamento = {
  provedor: "supabase_storage" | "google_drive";
  nome: string;
  estado: EstadoDestino;
  detalhe?: string;
  local?: string;
  url?: string;
};

export type CartaoArquivoDados = {
  nomeOriginal: string;
  nomePadronizado?: string;
  extensao: string;
  tamanhoBytes?: number;
  empresa?: string;
  competencia?: string;
  tipoDocumento?: string;
  destinos: DestinoArmazenamento[];
};

export type Anexo = {
  nome: string;
  resumo: string;
  extensao: string;
  tamanhoBytes: number;
};

export type ToolCall = { id: string; function: { name: string; arguments: string } };

export type Mensagem = {
  id?: string;
  papel: "usuario" | "agente" | "sistema" | "ferramenta";
  conteudo: string | null;
  /** Texto que o usuário digitou (sem o bloco de arquivo injetado no modelo). */
  textoExibido?: string;
  anexos?: Anexo[];
  cartoes?: CartaoArquivoDados[];
  tipo?: "texto" | "arquivo" | "resultado" | "status" | "erro" | "aprovacao";
  criadaEm?: string;
  /** Presente quando a mensagem falhou e pode ser reenviada. */
  falhou?: boolean;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export function formatarTamanho(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

export function formatarHora(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** Agrupa conversas por período, como na referência. */
export function agruparPorPeriodo(conversas: Conversa[]): { rotulo: string; itens: Conversa[] }[] {
  const agora = new Date();
  const inicioHoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime();
  const umDia = 86_400_000;

  const grupos: Record<string, Conversa[]> = {
    Hoje: [],
    Ontem: [],
    "Últimos 7 dias": [],
    "Últimos 30 dias": [],
    "Mais antigos": [],
  };

  for (const c of conversas) {
    const t = new Date(c.ultimaAtividadeEm).getTime();
    if (t >= inicioHoje) grupos["Hoje"].push(c);
    else if (t >= inicioHoje - umDia) grupos["Ontem"].push(c);
    else if (t >= inicioHoje - 7 * umDia) grupos["Últimos 7 dias"].push(c);
    else if (t >= inicioHoje - 30 * umDia) grupos["Últimos 30 dias"].push(c);
    else grupos["Mais antigos"].push(c);
  }

  return Object.entries(grupos)
    .filter(([, itens]) => itens.length > 0)
    .map(([rotulo, itens]) => ({ rotulo, itens }));
}
