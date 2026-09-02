/**
 * Teste REAL controlado do arquivador, de ponta a ponta.
 *
 * Roda o fluxo inteiro contra o banco e o Drive de produção:
 *
 *   empresa fictícia -> arquivo fictício -> anexo -> análise (modelo real)
 *   -> proposta -> confirmação -> upload no Drive -> registro no banco
 *   -> verificação independente
 *
 * NENHUM dado de cliente real é usado. A empresa se chama ZZ_TESTE_AUTOMATIZADO
 * e o CNPJ tem dígito válido mas não pertence a ninguém. Tudo que o script cria
 * é rastreável e removível por `--limpar`.
 *
 * PADRÃO É SIMULAÇÃO. Sem `--aplicar` nada é criado.
 *
 * Uso:
 *   npm run teste:ponta-a-ponta               # mostra o que faria
 *   npm run teste:ponta-a-ponta -- --aplicar  # executa de verdade
 *   npm run teste:ponta-a-ponta -- --limpar   # desfaz tudo que criou
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const raizProjeto = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const arquivo of [".env", ".env.local"]) {
  const caminho = path.join(raizProjeto, arquivo);
  if (!fs.existsSync(caminho)) continue;
  for (const linha of fs.readFileSync(caminho, "utf8").split(/\r?\n/)) {
    const m = linha.match(/^([A-Za-z_0-9]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}

const verde = (s: string) => `\x1b[32m${s}\x1b[0m`;
const vermelho = (s: string) => `\x1b[31m${s}\x1b[0m`;
const amarelo = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cinza = (s: string) => `\x1b[90m${s}\x1b[0m`;
const negrito = (s: string) => `\x1b[1m${s}\x1b[0m`;

const aplicar = process.argv.includes("--aplicar");
const limpar = process.argv.includes("--limpar");

const { supabaseAdmin } = await import("../lib/supabase-admin");
const { salvarArquivo } = await import("../lib/file-store");
const { calcularHashSha256 } = await import("../lib/documentos/inspecao");
const { analisarDocumentos } = await import("../lib/arquivador/analise");
const { portasAnalisePadrao } = await import("../lib/arquivador/portas-analise");
const { arquivarDocumentos } = await import("../lib/arquivador/arquivamento");
const { portasArquivamentoPadrao } = await import("../lib/arquivador/portas-arquivamento");
const { obterAccessToken } = await import("../lib/integracoes/google-oauth");

// --- Dados fictícios ---------------------------------------------------------

const CODIGO = "ZZTESTE";
// `empresas.cnpj` é varchar(14): guarda só dígitos. O texto do documento usa
// a forma formatada de propósito, para exercitar a normalização.
const CNPJ_DIGITOS = "77888999000181"; // dígito verificador válido, de ninguém
const CNPJ_FORMATADO = "77.888.999/0001-81";
const RAZAO = "ZZ Teste Automatizado Ltda";
const COMPETENCIA = "2026-09";
const NOME_ARQUIVO = `ZZTESTE_${COMPETENCIA}_NOTA_FISCAL.txt`;

const CONTEUDO = `NOTA FISCAL DE SERVICOS ELETRONICA
Prestador: Fornecedor Ficticio Ltda
Tomador: ${RAZAO}
CNPJ do tomador: ${CNPJ_FORMATADO}
Competencia: ${COMPETENCIA}
Numero: 000123
Descricao: servico de teste automatizado do arquivador
Valor total: 1.000,00

DOCUMENTO FICTICIO GERADO POR TESTE. NAO TEM VALOR FISCAL.
`;

function sair(mensagem: string, codigo = 1): never {
  console.log(`\n${vermelho("✗")} ${mensagem}\n`);
  process.exit(codigo);
}

// --- Limpeza -----------------------------------------------------------------

async function limparTudo(): Promise<void> {
  console.log(negrito("\nDesfazendo o que o teste criou\n"));

  const { data: empresa } = await supabaseAdmin
    .from("empresas")
    .select("id")
    .eq("codigo", CODIGO)
    .maybeSingle();

  const empresaId = (empresa as { id: string } | null)?.id ?? null;

  if (empresaId) {
    const { data: docs } = await supabaseAdmin
      .from("documentos_operacionais")
      .select("id")
      .eq("empresa_id", empresaId);

    const ids = ((docs ?? []) as { id: string }[]).map((d) => d.id);

    if (ids.length > 0) {
      // Manda os arquivos do Drive para a lixeira antes de perder o vínculo.
      const { data: locs } = await supabaseAdmin
        .from("documento_localizacoes")
        .select("identificador_externo")
        .in("documento_id", ids);

      const auth = await obterAccessToken();
      if (auth.ok) {
        for (const l of (locs ?? []) as { identificador_externo: string | null }[]) {
          if (!l.identificador_externo) continue;
          await fetch(
            `https://www.googleapis.com/drive/v3/files/${l.identificador_externo}?supportsAllDrives=true`,
            {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${auth.accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ trashed: true }),
            }
          );
          console.log(`  ${verde("lixeira")} arquivo ${l.identificador_externo}`);
        }
      }

      await supabaseAdmin.from("documento_localizacoes").delete().in("documento_id", ids);
      await supabaseAdmin.from("documentos_operacionais").delete().in("id", ids);
      console.log(`  ${verde("removidos")} ${ids.length} documento(s)`);
    }
  }

  const { data: anexos } = await supabaseAdmin
    .from("anexos_agente")
    .select("id,arquivo_id,nome_original")
    .eq("nome_original", NOME_ARQUIVO);

  const listaAnexos = (anexos ?? []) as { id: string; arquivo_id: string; nome_original: string }[];

  if (listaAnexos.length > 0) {
    const anexoIds = listaAnexos.map((a) => a.id);
    await supabaseAdmin
      .from("propostas_arquivamento")
      .delete()
      .overlaps("anexo_ids", anexoIds);

    for (const a of listaAnexos) {
      await supabaseAdmin.storage
        .from("anexos-agente")
        .remove([`${a.arquivo_id}/${a.nome_original}`]);
    }
    await supabaseAdmin.from("anexos_agente").delete().in("id", anexoIds);
    console.log(`  ${verde("removidos")} ${listaAnexos.length} anexo(s) e as propostas`);
  }

  // As PASTAS do Drive ficam. Apagar pasta de cliente automaticamente é o tipo
  // de coisa que um dia apaga a errada; a de teste é vazia e inofensiva.
  const { data: pastas } = await supabaseAdmin
    .from("pastas_drive")
    .select("id,caminho_logico")
    .like("caminho_logico", `%/${CODIGO}%`);

  for (const p of (pastas ?? []) as { caminho_logico: string }[]) {
    console.log(`  ${amarelo("mantida")} pasta ${p.caminho_logico} ${cinza("(vazia, remova à mão se quiser)")}`);
  }

  if (empresaId) {
    await supabaseAdmin.from("empresas").delete().eq("id", empresaId);
    console.log(`  ${verde("removida")} empresa ${CODIGO}`);
  }

  console.log(`\n${verde("=== LIMPEZA CONCLUÍDA ===")}\n`);
}

if (limpar) {
  await limparTudo();
  process.exit(0);
}

// --- 1. Pré-condições --------------------------------------------------------

console.log(negrito("\n1. Pré-condições"));

const { data: perfil } = await supabaseAdmin
  .from("perfis_usuarios")
  .select("usuario_id,nome,papel")
  .eq("ativo", true)
  .limit(1)
  .maybeSingle();

if (!perfil) sair("Nenhum usuário interno ativo. O teste precisa de um dono para o anexo.");
const usuario = perfil as { usuario_id: string; nome: string; papel: string };
console.log(`  ${verde("OK")}   usuário: ${usuario.nome} (${usuario.papel})`);

const { count: fixas } = await supabaseAdmin
  .from("estrutura_fixa_drive")
  .select("*", { count: "exact", head: true })
  .eq("ativo", true);
if (!fixas) sair("estrutura_fixa_drive vazia. Rode `npm run drive:estrutura -- --aplicar`.");
console.log(`  ${verde("OK")}   estrutura fixa: ${fixas} pastas`);

const hash = calcularHashSha256(Buffer.from(CONTEUDO, "utf8"));
console.log(`  ${cinza("·")}    arquivo fictício: ${NOME_ARQUIVO} (sha256 ${hash.slice(0, 12)}…)`);
console.log(`  ${cinza("·")}    empresa fictícia: ${CODIGO} / ${CNPJ_FORMATADO}`);

if (!aplicar) {
  console.log(negrito("\n2. Simulação"));
  console.log(
    `  ${amarelo("SIMULACAO")} nada foi criado.\n` +
      `  Para executar de verdade: ${negrito("npm run teste:ponta-a-ponta -- --aplicar")}\n` +
      `  Para desfazer depois:     ${negrito("npm run teste:ponta-a-ponta -- --limpar")}\n`
  );
  process.exit(0);
}

// --- 2. Empresa fictícia -----------------------------------------------------

console.log(negrito("\n2. Empresa fictícia"));

let empresaId: string;
const { data: existente } = await supabaseAdmin
  .from("empresas")
  .select("id")
  .eq("codigo", CODIGO)
  .maybeSingle();

if (existente) {
  empresaId = (existente as { id: string }).id;
  console.log(`  ${cinza("·")}    já existia: ${empresaId}`);
} else {
  const { data, error } = await supabaseAdmin
    .from("empresas")
    .insert({
      codigo: CODIGO,
      razao_social: RAZAO,
      nome_fantasia: "ZZ Teste",
      cnpj: CNPJ_DIGITOS,
      ativo: true,
      observacoes: "EMPRESA FICTICIA criada por teste automatizado. Pode ser removida.",
    })
    .select("id")
    .single();

  if (error) sair(`Falha ao criar empresa fictícia: ${error.message}`);
  empresaId = (data as { id: string }).id;
  console.log(`  ${verde("CRIADA")} ${CODIGO} -> ${empresaId}`);
}

// --- 3. Anexo ----------------------------------------------------------------

console.log(negrito("\n3. Anexo"));

const arquivoId = randomUUID();
await salvarArquivo(arquivoId, NOME_ARQUIVO, Buffer.from(CONTEUDO, "utf8"), "text/plain");

const { data: anexoCriado, error: erroAnexo } = await supabaseAdmin
  .from("anexos_agente")
  .insert({
    arquivo_id: arquivoId,
    usuario_id: usuario.usuario_id,
    nome_original: NOME_ARQUIVO,
    extensao: "txt",
    mime_type: "text/plain",
    tamanho_bytes: Buffer.byteLength(CONTEUDO, "utf8"),
    hash_sha256: hash,
  })
  .select("id")
  .single();

if (erroAnexo) sair(`Falha ao registrar anexo: ${erroAnexo.message}`);
const anexoId = (anexoCriado as { id: string }).id;
console.log(`  ${verde("OK")}   anexo ${anexoId}`);

// --- 4. Análise (modelo REAL) ------------------------------------------------

console.log(negrito("\n4. Análise"));

const analise = await analisarDocumentos(
  { anexoIds: [anexoId] },
  usuario.usuario_id,
  portasAnalisePadrao()
);

if (!analise.ok) sair(`Análise falhou: ${analise.erro}`);
const item = analise.proposta.itens[0];

console.log(`  ${verde("OK")}   proposta ${analise.proposta.propostaId} (${analise.proposta.status})`);
console.log(`  ${cinza("·")}    empresa:     ${item.empresa.valor ?? "—"} [${item.empresa.confianca}]`);
console.log(`  ${cinza("·")}    competência: ${item.competencia.valor ?? "—"} [${item.competencia.confianca}]`);
console.log(`  ${cinza("·")}    regra:       ${item.regra.valor ?? "—"} [${item.regra.confianca}]`);
console.log(`  ${cinza("·")}    tipo:        ${item.tipoDocumento.valor ?? "—"}`);
for (const e of item.evidencias) console.log(`  ${cinza("·")}    evidência:   ${e.detalhe}`);
console.log(`  ${cinza("·")}    destino:     ${item.caminhoSugerido ?? "—"}`);

if (item.status !== "analisado") {
  sair(
    `O item não ficou pronto (${item.status}). Faltando: ${item.camposFaltantes.join(", ") || "—"}. ` +
      "Nada foi arquivado."
  );
}

// --- 5. Arquivamento ---------------------------------------------------------

console.log(negrito("\n5. Arquivamento"));

const arquivamento = await arquivarDocumentos(
  { propostaId: analise.proposta.propostaId, confirmar: true, anexosConfirmados: [anexoId] },
  usuario.usuario_id,
  portasArquivamentoPadrao()
);

if (!arquivamento.ok) sair(`Arquivamento falhou: ${arquivamento.erro}`);
const arquivado = arquivamento.itens[0];

if (arquivado.status === "erro") sair(`Item com erro: ${arquivado.erro}`);

console.log(`  ${verde("OK")}   status: ${arquivado.status}`);
console.log(`  ${cinza("·")}    documento:  ${arquivado.documentoId}`);
console.log(`  ${cinza("·")}    drive:      ${arquivado.identificadorExterno}`);
console.log(`  ${cinza("·")}    caminho:    ${arquivado.caminhoFinal}`);
console.log(`  ${cinza("·")}    proposta:   ${arquivamento.statusProposta}`);

// --- 6. Verificação independente ---------------------------------------------

console.log(negrito("\n6. Verificação independente"));

let ok = 0;
let falhas = 0;
const checar = (cond: boolean, msg: string, detalhe = "") => {
  if (cond) {
    ok++;
    console.log(`  ${verde("OK")}   ${msg}`);
  } else {
    falhas++;
    console.log(`  ${vermelho("FALHA")} ${msg}${detalhe ? ` — ${detalhe}` : ""}`);
  }
};

const auth = await obterAccessToken();
if (!auth.ok) sair(`Sem token do Drive: ${auth.erro}`);

const meta = (await (
  await fetch(
    `https://www.googleapis.com/drive/v3/files/${arquivado.identificadorExterno}` +
      `?fields=id,name,size,parents,trashed&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${auth.accessToken}` } }
  )
).json()) as { id?: string; name?: string; size?: string; trashed?: boolean };

checar(Boolean(meta.id), "o arquivo existe no Drive");
checar(meta.trashed !== true, "não está na lixeira");
checar(
  meta.name === arquivado.caminhoFinal?.split("/").pop(),
  "o nome no Drive é o nome final calculado",
  `Drive: ${meta.name}`
);
checar(
  Number(meta.size ?? 0) === Buffer.byteLength(CONTEUDO, "utf8"),
  "o tamanho bate com o conteúdo enviado",
  `Drive: ${meta.size}`
);

const { data: doc } = await supabaseAdmin
  .from("documentos_operacionais")
  .select("id,hash_sha256,status,origem,versao,caminho_logico,nome_final,nome_original,proposta_id")
  .eq("id", arquivado.documentoId!)
  .maybeSingle();

const linhaDoc = doc as Record<string, unknown> | null;
checar(Boolean(linhaDoc), "documento registrado no banco");
checar(linhaDoc?.hash_sha256 === hash, "hash gravado é o do conteúdo");
checar(linhaDoc?.status === "armazenado", "status do documento", String(linhaDoc?.status));
checar(linhaDoc?.nome_original === NOME_ARQUIVO, "nome ORIGINAL preservado");
checar(linhaDoc?.nome_final !== NOME_ARQUIVO, "nome final é diferente do original");
checar(linhaDoc?.proposta_id === analise.proposta.propostaId, "documento aponta para a proposta");

const { data: loc } = await supabaseAdmin
  .from("documento_localizacoes")
  .select("identificador_externo,status,provedor")
  .eq("documento_id", arquivado.documentoId!)
  .maybeSingle();

const linhaLoc = loc as Record<string, unknown> | null;
checar(Boolean(linhaLoc), "localização registrada");
checar(linhaLoc?.identificador_externo === arquivado.identificadorExterno, "id do Drive confere");
checar(linhaLoc?.status === "armazenado", "status da localização", String(linhaLoc?.status));

// --- 7. Idempotência real ----------------------------------------------------

console.log(negrito("\n7. Idempotência (repetindo a confirmação)"));

const repetido = await arquivarDocumentos(
  { propostaId: analise.proposta.propostaId, confirmar: true, anexosConfirmados: [anexoId] },
  usuario.usuario_id,
  portasArquivamentoPadrao()
);

checar(
  !repetido.ok && repetido.codigo === "proposta_resolvida",
  "repetir a mesma proposta é recusado",
  repetido.ok ? "aceitou de novo" : repetido.codigo
);

// Uma análise NOVA do mesmo arquivo tem de reconhecer o conteúdo já arquivado.
const analise2 = await analisarDocumentos(
  { anexoIds: [anexoId] },
  usuario.usuario_id,
  portasAnalisePadrao()
);

if (analise2.ok) {
  checar(
    analise2.proposta.itens[0].possivelDuplicata !== null,
    "nova análise detecta o documento já arquivado como duplicata"
  );

  const arquivamento2 = await arquivarDocumentos(
    { propostaId: analise2.proposta.propostaId, confirmar: true, anexosConfirmados: [anexoId] },
    usuario.usuario_id,
    portasArquivamentoPadrao()
  );

  checar(
    arquivamento2.ok && arquivamento2.itens[0].status === "ja_arquivado",
    "confirmar de novo NÃO cria segundo arquivo",
    arquivamento2.ok ? arquivamento2.itens[0].status : arquivamento2.erro
  );
}

const { count: quantosDocs } = await supabaseAdmin
  .from("documentos_operacionais")
  .select("*", { count: "exact", head: true })
  .eq("empresa_id", empresaId)
  .eq("hash_sha256", hash);

checar(quantosDocs === 1, "existe UM único documento com este conteúdo", `achei ${quantosDocs}`);

// --- 8. Resumo ---------------------------------------------------------------

console.log(negrito("\n8. Resumo"));
console.log(`  ${ok} ok, ${falhas} falha(s)`);
console.log(
  `\n  Para desfazer: ${negrito("npm run teste:ponta-a-ponta -- --limpar")}\n`
);

process.exit(falhas > 0 ? 1 : 0);
