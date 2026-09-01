/**
 * Cria a pasta raiz BPO_FINANCEIRO no Drive da conta autorizada.
 *
 * Precisa rodar DEPOIS de GOOGLE_DRIVE_REFRESH_TOKEN estar no .env.local.
 *
 * Escopo `drive.file`: o app só enxerga o que ele mesmo criou. Por isso a pasta
 * raiz precisa nascer aqui — uma pasta criada à mão no Drive seria invisível.
 *
 * NÃO cria a árvore de clientes/anos/competências. Só a raiz.
 * NUNCA imprime segredo: apenas o ID da pasta e o e-mail da conta.
 *
 * Uso: npm run drive:bootstrap
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// .env.local tem precedência sobre .env — é onde ficam os segredos locais.
for (const arquivo of [".env", ".env.local"]) {
  const caminho = path.join(raiz, arquivo);
  if (!fs.existsSync(caminho)) continue;
  for (const linha of fs.readFileSync(caminho, "utf8").split(/\r?\n/)) {
    const m = linha.match(/^([A-Za-z_0-9]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}

const verde = (s) => `\x1b[32m${s}\x1b[0m`;
const vermelho = (s) => `\x1b[31m${s}\x1b[0m`;
const amarelo = (s) => `\x1b[33m${s}\x1b[0m`;
const negrito = (s) => `\x1b[1m${s}\x1b[0m`;

const NOME_PASTA = "BPO_FINANCEIRO";
const API = "https://www.googleapis.com/drive/v3";

function sair(mensagem, codigo = 1) {
  console.log(`\n${vermelho("✗")} ${mensagem}\n`);
  process.exit(codigo);
}

// 1. Configuração ------------------------------------------------------------
const faltando = ["GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET", "GOOGLE_DRIVE_REFRESH_TOKEN"]
  .filter((v) => !process.env[v]);

if (faltando.length) {
  sair(
    `Variáveis ausentes: ${faltando.join(", ")}.\n` +
      `  Conecte primeiro em http://localhost:3000/integracoes/google-drive`
  );
}

console.log(negrito("\n1. Autenticando"));

// 2. Access token a partir do refresh token -----------------------------------
const respostaToken = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: process.env.GOOGLE_DRIVE_CLIENT_ID,
    client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  }),
});

if (!respostaToken.ok) {
  sair(
    `Não foi possível renovar o acesso (HTTP ${respostaToken.status}).\n` +
      `  O refresh token pode ter sido revogado. Reconecte pela página de integração.`
  );
}

const { access_token: accessToken } = await respostaToken.json();
const auth = { Authorization: `Bearer ${accessToken}` };

// 3. Conta autorizada --------------------------------------------------------
const respostaConta = await fetch(`${API}/about?fields=user(emailAddress,displayName)`, {
  headers: auth,
});
if (!respostaConta.ok) sair(`Não foi possível identificar a conta (HTTP ${respostaConta.status}).`);

const { user } = await respostaConta.json();
console.log(`  ${verde("OK")}   conta autorizada: ${user?.emailAddress ?? "(desconhecida)"}`);

// 4. Pasta raiz já configurada? ----------------------------------------------
console.log(negrito("\n2. Pasta raiz"));
const idExistente = process.env.GOOGLE_DRIVE_PASTA_RAIZ_ID;

if (idExistente) {
  const r = await fetch(
    `${API}/files/${encodeURIComponent(idExistente)}?fields=id,name,mimeType,trashed`,
    { headers: auth }
  );
  if (r.ok) {
    const pasta = await r.json();
    if (pasta.trashed) {
      console.log(`  ${amarelo("AVISO")} a pasta configurada está na lixeira.`);
    } else if (pasta.mimeType !== "application/vnd.google-apps.folder") {
      sair(`O ID configurado em GOOGLE_DRIVE_PASTA_RAIZ_ID não é uma pasta.`);
    } else {
      console.log(`  ${verde("OK")}   já configurada: "${pasta.name}"`);
      console.log(`\n${verde("Nada a fazer.")} A pasta raiz já existe e está acessível.\n`);
      process.exit(0);
    }
  } else {
    console.log(
      `  ${amarelo("AVISO")} o ID configurado não está acessível (HTTP ${r.status}).` +
        ` Criando uma pasta nova.`
    );
  }
}

// 5. Procura uma pasta que este app já tenha criado ---------------------------
// Só enxergamos o que criamos (drive.file) — não é uma varredura do Drive.
const consulta = [
  `name = '${NOME_PASTA}'`,
  "mimeType = 'application/vnd.google-apps.folder'",
  "trashed = false",
  "'root' in parents",
].join(" and ");

const respostaBusca = await fetch(
  `${API}/files?q=${encodeURIComponent(consulta)}&fields=files(id,name)&pageSize=10`,
  { headers: auth }
);
const { files: encontradas = [] } = respostaBusca.ok
  ? await respostaBusca.json()
  : { files: [] };

let pastaId;
if (encontradas.length > 0) {
  pastaId = encontradas[0].id;
  console.log(`  ${verde("OK")}   pasta "${NOME_PASTA}" já existia — reaproveitada`);
} else {
  const criacao = await fetch(`${API}/files?fields=id,name`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: NOME_PASTA,
      mimeType: "application/vnd.google-apps.folder",
      parents: ["root"],
    }),
  });
  if (!criacao.ok) sair(`Falha ao criar a pasta (HTTP ${criacao.status}).`);
  pastaId = (await criacao.json()).id;
  console.log(`  ${verde("OK")}   pasta "${NOME_PASTA}" criada na raiz do Drive`);
}

// 6. Instrução final ---------------------------------------------------------
console.log(negrito("\n3. Próximo passo"));
console.log(`  Adicione ao ${negrito(".env.local")}:\n`);
console.log(`  ${verde(`GOOGLE_DRIVE_PASTA_RAIZ_ID=${pastaId}`)}\n`);
console.log(`  Depois reinicie o servidor e rode: ${negrito("npm run drive:verificar")}`);
console.log(
  `\n  ${amarelo("Nota:")} a árvore de clientes/anos/competências NÃO foi criada.` +
    ` Isso é do arquivador, ainda não implementado.\n`
);
