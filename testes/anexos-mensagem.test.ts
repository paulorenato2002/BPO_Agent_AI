import { test } from "node:test";
import assert from "node:assert/strict";

import { separarAnexos, TEXTO_PADRAO_ANEXOS } from "../app/componentes/anexos-mensagem";

function bloco(nome: string, previa: string, tabular = false): string {
  const cabecalho = `[Arquivo anexado pelo usuário: ${nome}]\nid: 0000-1111`;
  return tabular
    ? `${cabecalho}\n${nome} — 2 linha(s)\nPrévia (2 de 2 linhas):\n\`\`\`json\n${previa}\n\`\`\`\nPara ver mais linhas ou filtrar, use a tool consultar_arquivo_anexado com arquivoId="x". Para propor o arquivamento, use analisar_documentos com anexoId="y".`
    : `${cabecalho}\n${nome} — PDF\nPrévia (primeiros 10 de 10 caracteres):\n"""\n${previa}\n"""\nPara ler o restante, use a tool ler_arquivo_texto_anexado com arquivoId="x", nomeArquivo="${nome}" e offset=10. Para propor o arquivamento, use analisar_documentos com anexoId="y".`;
}

test("mensagem sem anexo fica como está", () => {
  assert.deepEqual(separarAnexos("confere pra mim"), { texto: "confere pra mim", anexos: [] });
  assert.deepEqual(separarAnexos(null), { texto: "", anexos: [] });
});

test("tira os blocos e mantém o texto digitado", () => {
  const conteudo = `${bloco("A - CONTAS.pdf", "Fornecedor X 100,00\nPara ler o restante do mês")}\n\n${bloco(
    "vt.xlsx",
    '[{"Nome":"Ana"}]',
    true
  )}\n\nconfere esses dois`;
  const r = separarAnexos(conteudo);
  assert.deepEqual(r.anexos, ["A - CONTAS.pdf", "vt.xlsx"]);
  assert.equal(r.texto, "confere esses dois");
});

test("só anexos: o texto padrão não aparece e nada do conteúdo vaza", () => {
  const r = separarAnexos(`${bloco("extrato.pdf", "SALDO 1.000,00")}\n\n${TEXTO_PADRAO_ANEXOS}`);
  assert.deepEqual(r, { texto: "", anexos: ["extrato.pdf"] });
});

test("linha parecida com o fim do bloco dentro da prévia não vaza", () => {
  const previa = 'Total 10,00\n"""\nPara ler o restante, use outra coisa\nSEGREDO';
  const r = separarAnexos(`${bloco("x.pdf", previa)}\n\nok`);
  assert.deepEqual(r, { texto: "ok", anexos: ["x.pdf"] });
});

test("formato inesperado esconde o resto em vez de mostrar a prévia", () => {
  const r = separarAnexos("[Arquivo anexado pelo usuário: x.pdf]\nid: 1\nconteúdo sigiloso sem linha final");
  assert.deepEqual(r, { texto: "", anexos: ["x.pdf"] });
});
