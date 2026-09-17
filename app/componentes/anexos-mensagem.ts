/**
 * O que o usuário escreveu, sem os blocos de arquivo que vão só para o modelo.
 *
 * A mensagem gravada no banco é a que o modelo leu: blocos "[Arquivo anexado
 * pelo usuário: ...]" com a prévia do conteúdo, seguidos do texto digitado.
 * Na tela, o arquivo aparece como cartão e o conteúdo nunca aparece.
 */

const INICIO_BLOCO = "[Arquivo anexado pelo usuário: ";
const CABECALHO = /\[Arquivo anexado pelo usuário: ([^\]\n]+)\]\nid: [^\n]*/g;
// Última linha de cada bloco, logo depois do fecho da prévia (ver app/api/upload/route.ts).
const FIM_BLOCO = /(?:"""|```)\nPara (?:ver mais linhas|ler o restante)[^\n]*/g;

/** Texto que o cliente manda quando o usuário só anexou, sem escrever nada. */
export const TEXTO_PADRAO_ANEXOS = "Processe os arquivos anexados.";

export function separarAnexos(conteudo: string | null | undefined): { texto: string; anexos: string[] } {
  if (!conteudo || !conteudo.includes(INICIO_BLOCO)) return { texto: conteudo ?? "", anexos: [] };

  const cabecalhos = [...conteudo.matchAll(CABECALHO)];
  if (cabecalhos.length === 0) return { texto: conteudo, anexos: [] };

  const antes = conteudo.slice(0, cabecalhos[0].index).trim();
  const ultimo = cabecalhos[cabecalhos.length - 1];
  const trecho = conteudo.slice(ultimo.index);
  const fins = [...trecho.matchAll(FIM_BLOCO)];
  // Sem a linha final conhecida, esconder o resto é mais seguro que mostrar a prévia.
  // A última ocorrência: a prévia pode conter uma linha parecida.
  const fim = fins.at(-1);
  const depois = fim ? trecho.slice(fim.index! + fim[0].length).trim() : "";

  const texto = [antes, depois === TEXTO_PADRAO_ANEXOS ? "" : depois].filter(Boolean).join("\n\n");
  return { texto, anexos: cabecalhos.map((c) => c[1].trim()) };
}

export function extensaoDe(nome: string): string {
  return nome.includes(".") ? nome.split(".").pop()!.toLowerCase() : "";
}
