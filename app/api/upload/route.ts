import { randomUUID } from "node:crypto";
import { extensaoSuportada, parseArquivo, tipoArquivo, MAX_FILE_BYTES } from "@/lib/file-extract";
import { salvarArquivo } from "@/lib/file-store";

export const dynamic = "force-dynamic";

const PREVIA_LINHAS = 8;
const PREVIA_CARACTERES = 1500;

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ erro: "Requisição inválida: esperado multipart/form-data." }, { status: 400 });
  }
  const arquivo = formData.get("arquivo");

  if (!(arquivo instanceof File)) {
    return Response.json({ erro: "Nenhum arquivo enviado." }, { status: 400 });
  }

  if (!extensaoSuportada(arquivo.name)) {
    return Response.json(
      { erro: `Tipo de arquivo não suportado: ${arquivo.name}. Aceitos: csv, xlsx, xls, pdf, txt.` },
      { status: 400 }
    );
  }

  if (arquivo.size > MAX_FILE_BYTES) {
    return Response.json(
      { erro: `Arquivo muito grande (máximo ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB).` },
      { status: 400 }
    );
  }

  try {
    const buffer = Buffer.from(await arquivo.arrayBuffer());
    const arquivoId = randomUUID();

    const [parsed] = await Promise.all([
      parseArquivo(arquivo.name, buffer),
      salvarArquivo(arquivoId, arquivo.name, buffer, arquivo.type || "application/octet-stream"),
    ]);

    const cabecalho = `[Arquivo anexado pelo usuário: ${arquivo.name}]\nid: ${arquivoId}`;

    if (parsed.tipo === "tabular") {
      const resumo = `${arquivo.name} — ${parsed.linhas.length} linha(s), colunas: ${parsed.colunas.join(", ") || "(nenhuma coluna encontrada)"}`;
      const previa = parsed.linhas.slice(0, PREVIA_LINHAS);
      const avisoTruncado = parsed.truncado
        ? "\n(o arquivo passou do teto de segurança de linhas e foi cortado — avise o usuário se isso importar)"
        : "";
      const blocoParaModelo = `${cabecalho}\n${resumo}${avisoTruncado}\nPrévia (${previa.length} de ${parsed.linhas.length} linhas):\n\`\`\`json\n${JSON.stringify(previa)}\n\`\`\`\nPara ver mais linhas ou filtrar, use a tool consultar_arquivo_anexado com arquivoId="${arquivoId}" e nomeArquivo="${arquivo.name}". Para somar/contar por categoria sem ler linha por linha, use agregar_arquivo_anexado.`;
      return Response.json({ nome: arquivo.name, arquivoId, tipo: tipoArquivo(arquivo.name), resumo, blocoParaModelo });
    }

    const resumo = `${arquivo.name} — ${parsed.descricaoTipo}, ${parsed.texto.length} caractere(s) extraído(s)`;
    const previa = parsed.texto.slice(0, PREVIA_CARACTERES);
    const avisoTruncado = parsed.truncado
      ? "\n(o texto passou do teto de segurança e foi cortado — avise o usuário se isso importar)"
      : "";
    const blocoParaModelo = `${cabecalho}\n${resumo}${avisoTruncado}\nPrévia (primeiros ${previa.length} de ${parsed.texto.length} caracteres):\n"""\n${previa}\n"""\nPara ler o restante, use a tool ler_arquivo_texto_anexado com arquivoId="${arquivoId}", nomeArquivo="${arquivo.name}" e offset=${previa.length}.`;
    return Response.json({ nome: arquivo.name, arquivoId, tipo: tipoArquivo(arquivo.name), resumo, blocoParaModelo });
  } catch (err) {
    return Response.json(
      { erro: err instanceof Error ? err.message : "Falha ao processar o arquivo." },
      { status: 422 }
    );
  }
}
