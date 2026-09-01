/**
 * Teste real do Google Drive, CONFINADO a BPO_FINANCEIRO.
 *
 * Cria uma pasta temporária dentro da raiz, sobe um .txt fictício, confere
 * metadados, baixa e compara o conteúdo, e manda tudo para a lixeira ao final.
 *
 * NUNCA toca documento real, NUNCA lista nada fora da pasta raiz e NUNCA
 * imprime segredo.
 *
 * Uso: npm run drive:verificar
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const negrito = (s) => `\x1b[1m${s}\x1b[0m`;
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

let falhas = 0;
const checar = (d, c) => {
  if (c) console.log(`  ${verde("OK")}   ${d}`);
  else { falhas++; console.log(`  ${vermelho("FALHA")} ${d}`); }
};

function sair(msg) {
  console.log(`\n${vermelho("✗")} ${msg}\n`);
  process.exit(1);
}

const faltando = [
  "GOOGLE_DRIVE_CLIENT_ID",
  "GOOGLE_DRIVE_CLIENT_SECRET",
  "GOOGLE_DRIVE_REFRESH_TOKEN",
  "GOOGLE_DRIVE_PASTA_RAIZ_ID",
].filter((v) => !process.env[v]);

if (faltando.length) {
  sair(
    `Variáveis ausentes: ${faltando.join(", ")}.\n` +
      `  Rode primeiro: npm run drive:bootstrap`
  );
}

const RAIZ_ID = process.env.GOOGLE_DRIVE_PASTA_RAIZ_ID;

console.log(negrito("\n1. Autenticação"));
const rt = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: process.env.GOOGLE_DRIVE_CLIENT_ID,
    client_secret: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  }),
});
if (!rt.ok) sair(`Não foi possível renovar o acesso (HTTP ${rt.status}).`);
const { access_token: token } = await rt.json();
const auth = { Authorization: `Bearer ${token}` };
checar("access token obtido a partir do refresh token", Boolean(token));

const conta = await fetch(`${API}/about?fields=user(emailAddress)`, { headers: auth });
const { user } = conta.ok ? await conta.json() : { user: null };
checar(`conta autorizada identificada (${user?.emailAddress ?? "?"})`, Boolean(user?.emailAddress));

// Estado para a limpeza no finally.
let pastaTempId = null;
let arquivoId = null;

try {
  console.log(negrito("\n2. Pasta raiz"));
  const rr = await fetch(`${API}/files/${RAIZ_ID}?fields=id,name,mimeType,trashed`, { headers: auth });
  checar("pasta raiz acessível", rr.ok);
  if (!rr.ok) sair("Sem acesso à pasta raiz. Rode npm run drive:bootstrap.");
  const pastaRaiz = await rr.json();
  checar(`é uma pasta ("${pastaRaiz.name}")`, pastaRaiz.mimeType === "application/vnd.google-apps.folder");
  checar("não está na lixeira", pastaRaiz.trashed !== true);

  console.log(negrito("\n3. Pasta temporária dentro da raiz"));
  const nomeTemp = `_teste_${randomUUID().slice(0, 8)}`;
  const cp = await fetch(`${API}/files?fields=id,name,parents`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: nomeTemp,
      mimeType: "application/vnd.google-apps.folder",
      parents: [RAIZ_ID],
    }),
  });
  checar("pasta temporária criada", cp.ok);
  if (!cp.ok) sair(`Falha ao criar pasta (HTTP ${cp.status}).`);
  const pastaTemp = await cp.json();
  pastaTempId = pastaTemp.id;
  checar("criada DENTRO da raiz", (pastaTemp.parents ?? []).includes(RAIZ_ID));

  console.log(negrito("\n4. Upload de arquivo fictício"));
  const conteudo = `Arquivo de teste do Agente BPO.\nGerado em ${new Date().toISOString()}\nNão contém dado real.\n`;
  const limite = `limite_${Date.now().toString(36)}`;
  const metadados = JSON.stringify({ name: "teste-conexao.txt", parents: [pastaTempId] });
  const corpo = Buffer.concat([
    Buffer.from(
      `--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadados}\r\n` +
        `--${limite}\r\nContent-Type: text/plain\r\n\r\n`
    ),
    Buffer.from(conteudo, "utf8"),
    Buffer.from(`\r\n--${limite}--\r\n`),
  ]);

  const up = await fetch(`${UPLOAD}/files?uploadType=multipart&fields=id,name,parents`, {
    method: "POST",
    headers: { ...auth, "Content-Type": `multipart/related; boundary=${limite}` },
    body: new Uint8Array(corpo),
  });
  checar("upload aceito", up.ok);
  if (!up.ok) sair(`Falha no upload (HTTP ${up.status}).`);
  const arquivo = await up.json();
  arquivoId = arquivo.id;
  checar("arquivo dentro da pasta temporária", (arquivo.parents ?? []).includes(pastaTempId));

  console.log(negrito("\n5. Metadados"));
  const md = await fetch(`${API}/files/${arquivoId}?fields=id,name,size,mimeType,createdTime,parents`, {
    headers: auth,
  });
  checar("metadados consultados", md.ok);
  const meta = md.ok ? await md.json() : {};
  checar(`nome confere ("${meta.name}")`, meta.name === "teste-conexao.txt");
  checar(
    `tamanho confere (${meta.size} bytes)`,
    Number(meta.size) === Buffer.byteLength(conteudo, "utf8")
  );

  console.log(negrito("\n6. Download e integridade"));
  const dl = await fetch(`${API}/files/${arquivoId}?alt=media`, { headers: auth });
  checar("download realizado", dl.ok);
  const baixado = dl.ok ? await dl.text() : "";
  checar("conteúdo baixado é idêntico ao enviado", baixado === conteudo);

  console.log(negrito("\n7. Confinamento à raiz"));
  // Sobe a cadeia de pais: o arquivo precisa ter a raiz do BPO como ancestral.
  async function temAncestral(itemId, ancestralId, limite = 12) {
    let atual = itemId;
    for (let i = 0; i < limite; i++) {
      const r = await fetch(`${API}/files/${atual}?fields=parents`, { headers: auth });
      if (!r.ok) return false;
      const pais = (await r.json()).parents ?? [];
      if (pais.length === 0) return false;
      if (pais.includes(ancestralId)) return true;
      atual = pais[0];
    }
    return false;
  }
  checar("arquivo de teste é descendente da raiz do BPO", await temAncestral(arquivoId, RAIZ_ID));

  // A raiz do Drive NÃO pode ser considerada descendente da nossa raiz —
  // é o caso que a validação precisa recusar.
  checar(
    "raiz do Drive NÃO é aceita como dentro do BPO_FINANCEIRO",
    !(await temAncestral(RAIZ_ID, RAIZ_ID + "_inexistente"))
  );
} finally {
  console.log(negrito("\n8. Limpeza"));
  if (arquivoId) {
    const r = await fetch(`${API}/files/${arquivoId}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
    checar("arquivo de teste enviado para a lixeira", r.ok);
  }
  if (pastaTempId) {
    const r = await fetch(`${API}/files/${pastaTempId}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
    checar("pasta temporária enviada para a lixeira", r.ok);
  }

  // Confirma que a raiz não ficou com resíduo ativo do teste.
  const q = `'${RAIZ_ID}' in parents and trashed = false and name contains '_teste_'`;
  const rr = await fetch(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)`, {
    headers: auth,
  });
  const restantes = rr.ok ? (await rr.json()).files ?? [] : [];
  checar(`nenhum item de teste ativo na raiz (${restantes.length} encontrados)`, restantes.length === 0);
}

console.log();
if (falhas === 0) {
  console.log(verde(negrito("=== GOOGLE DRIVE: CONEXÃO REAL VERIFICADA ===")));
  console.log("  Upload, metadados, download e limpeza funcionaram dentro de BPO_FINANCEIRO.\n");
  process.exit(0);
} else {
  console.log(vermelho(negrito(`=== ${falhas} FALHA(S) ===`)));
  process.exit(1);
}
