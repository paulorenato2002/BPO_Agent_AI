import "server-only";
import { supabaseAdmin } from "../supabase-admin";

/**
 * Nome real da pasta do cliente, lido do mapa no banco.
 *
 * POR QUE NÃO LER O DISCO
 * -----------------------
 * A versão anterior (`pasta-cliente-local.ts`) fazia readdir na pasta do
 * OneDrive. Isso funciona no PC e não funciona na Vercel, onde essa pasta não
 * existe: o readdir estoura, a análise marca `pastaEmpresa` como faltante e
 * nenhum documento chega a ser arquivado.
 *
 * Quem tem o disco (o worker Python) varre e publica o mapa; aqui só se lê.
 * O nome da pasta deixa de ser uma ida ao disco no meio da análise e passa a
 * ser um dado cadastrado — que funciona igual na Vercel, no PC e em teste.
 *
 * O QUE ESTA FUNÇÃO NUNCA FAZ
 * ---------------------------
 * Não adivinha. Sem linha no mapa, ela lança — e a análise transforma isso em
 * "confirme a pasta do cliente" em vez de inventar um caminho. Um palpite aqui
 * arquiva documento de um cliente na pasta de outro.
 */

/**
 * Qual raiz o mapa deve refletir.
 *
 * Duas máquinas podem sincronizar bibliotecas diferentes e mapear a mesma
 * empresa em pastas distintas. `ARQUIVADOR_RAIZ_ID` diz qual delas vale para
 * este ambiente — o mesmo valor que o worker usa em `ARQUIVADOR_WORKER_ID`.
 */
function raizConfigurada(): string | null {
  return process.env.ARQUIVADOR_RAIZ_ID?.trim() || null;
}

export async function pastaClienteDoBanco(container: string, codigo: string): Promise<string> {
  if (!codigo?.trim()) throw new Error("Empresa sem código: não dá para localizar a pasta.");
  if (container.includes("/") || container.includes("\\") || container === "..") {
    throw new Error("Contêiner inválido.");
  }

  const raiz = raizConfigurada();
  let consulta = supabaseAdmin
    .from("empresa_pastas")
    .select("nome_pasta,raiz,conferido_em,empresas!inner(codigo)")
    .eq("container", container)
    .eq("empresas.codigo", codigo);

  if (raiz) consulta = consulta.eq("raiz", raiz);

  const { data, error } = await consulta;
  if (error) throw new Error(`Falha ao ler o mapa de pastas: ${error.message}`);

  const linhas = (data ?? []) as unknown as { nome_pasta: string; raiz: string }[];

  if (linhas.length === 0) {
    throw new Error(
      `A pasta do cliente ${codigo} ainda não foi mapeada em ${container}. ` +
        "O computador responsável precisa estar ligado para conferir as pastas " +
        "(a varredura roda sozinha a cada 15 minutos)."
    );
  }

  // Mais de uma raiz respondeu e nenhuma foi escolhida por configuração.
  // Escolher a primeira gravaria numa biblioteca por sorteio.
  const distintas = [...new Set(linhas.map((l) => l.nome_pasta))];
  if (distintas.length > 1) {
    throw new Error(
      `O cliente ${codigo} está mapeado em pastas diferentes (${distintas.join(", ")}). ` +
        "Defina ARQUIVADOR_RAIZ_ID para dizer qual biblioteca vale aqui."
    );
  }

  return distintas[0];
}
