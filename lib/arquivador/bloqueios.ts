/**
 * Recusa de arquivos que nunca podem ser lidos, extraídos ou enviados ao
 * modelo.
 *
 * Roda ANTES da extração — não adianta bloquear depois de já ter lido o
 * conteúdo para a memória do processo e mandado ao modelo. É a primeira coisa
 * que o upload e a análise fazem.
 *
 * Duas defesas independentes, porque falham por motivos diferentes:
 *
 *   1. EXTENSÃO — certificado e chave privada não têm por que passar por aqui.
 *      O upload já tem uma allowlist (csv/xlsx/xls/pdf/txt), mas a allowlist
 *      protege por omissão: basta alguém acrescentar "json" um dia para o
 *      client_secret.json entrar. Esta lista nega explicitamente.
 *
 *   2. CONTEÚDO — um `.txt` é aceito pela allowlist e pode conter uma senha
 *      colada. É o vazamento mais provável na prática, e o único que a
 *      extensão não pega.
 *
 * Os padrões de conteúdo são os mesmos do trigger que protege a memória do
 * agente (20260827100000_agente_memoria.sql), de propósito: se um texto não
 * pode virar memória, também não pode ser mandado ao modelo para classificar.
 *
 * Módulo PURO: sem I/O, sem banco. Dá para testar cada padrão isoladamente.
 */

/** Extensões recusadas sempre, independentemente da allowlist do upload. */
export const EXTENSOES_BLOQUEADAS = [
  "pfx",
  "p12",
  "pem",
  "key",
  "keystore",
  "jks",
  "crt",
  "cer",
  "der",
  "asc",
  "gpg",
  "kdbx",
  "ppk",
] as const;

/**
 * Nomes de arquivo que denunciam credencial mesmo com extensão inofensiva.
 * Comparados sobre o nome inteiro em minúsculas.
 */
const NOMES_BLOQUEADOS = [
  /^client_secret/i,
  /^service[-_]account/i,
  /^credentials?\b/i,
  /^token(s)?\./i,
  /^\.env/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.?htpasswd/i,
  /^authorized_keys/i,
  /^known_hosts/i,
];

/**
 * Padrões de segredo no CONTEÚDO, em dois grupos com tratamentos diferentes.
 *
 * POR QUE DOIS GRUPOS
 * -------------------
 * O tratamento era único: casou, recusa o arquivo inteiro. Isso reprovou um
 * extrato financeiro real por causa de uma linha na coluna "Observações" que
 * dizia `SENHA : 50936` — a senha do boleto, dado legítimo de cobrança, não
 * credencial. O documento inteiro foi perdido por cinco dígitos.
 *
 * A diferença que importa não é a gravidade do segredo, é a CONFIANÇA do
 * padrão:
 *
 *   ESTRUTURAIS  reconhecem o formato do próprio segredo (`-----BEGIN ... KEY`,
 *                `AKIA` + 16, `sk-` + 16). Praticamente não dão falso positivo,
 *                e um arquivo que os contém É uma credencial, não um documento
 *                de cliente. Continuam RECUSANDO.
 *
 *   LEXICAIS     reconhecem só um rótulo seguido de valor (`senha:`, `token:`).
 *                Falso positivo aqui é rotina em documento financeiro. Passam a
 *                TARJAR: o trecho vira [REDIGIDO], o documento segue para
 *                classificação, e o valor nunca chega ao modelo.
 *
 * Tarjar é mais seguro que recusar, não menos. Recusar não remove o segredo de
 * lugar nenhum — só faz o usuário perder o documento e, na prática, procurar
 * outro caminho para arquivá-lo. Tarjar remove o valor do que sai daqui.
 */
const PADROES_ESTRUTURAIS: { nome: string; regex: RegExp }[] = [
  {
    // `Authorization: Bearer <token>` não casa nos lexicais — ali o rótulo
    // precisa vir seguido de ":" ou "=", e aqui o "Bearer" é seguido de espaço.
    // É a forma mais comum de token vazado; ficar de fora seria o pior furo.
    nome: "token Bearer",
    regex: /\bbearer\s+[A-Za-z0-9._~+/-]{10,}=*/i,
  },
  { nome: "chave estilo OpenAI", regex: /sk-[a-zA-Z0-9_-]{16,}/ },
  { nome: "chave privada PEM", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { nome: "credencial em URL", regex: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i },
  { nome: "chave de service account Google", regex: /"private_key_id"\s*:/ },
  { nome: "chave AWS", regex: /\bAKIA[0-9A-Z]{16}\b/ },
];

/**
 * Rótulo seguido de valor. Deliberadamente colados nesse formato: procurar só
 * a palavra "senha" tarjaria um documento que apenas fala sobre política de
 * senhas, que é conteúdo legítimo de BPO.
 *
 * O `g` é necessário porque `redigirSegredos` percorre todas as ocorrências —
 * uma planilha pode ter dezenas.
 */
const PADROES_LEXICAIS: { nome: string; regex: RegExp }[] = [
  { nome: "senha", regex: /(senha|password|passwd)(\s*[:=]\s*)(\S+)/gi },
  {
    nome: "token ou chave de API",
    regex: /(token|bearer|api[_ -]?key|secret|chave[_ -]?api)(\s*[:=]\s*)(\S+)/gi,
  },
];

/** O que substitui o valor tarjado. Some no lugar do segredo, não do rótulo. */
export const MARCA_REDIGIDO = "[REDIGIDO]";

/**
 * Devolve o texto com os valores dos padrões lexicais mascarados.
 *
 * Preserva o rótulo de propósito: o modelo continua vendo que ali havia uma
 * senha de boleto — informação útil para classificar — sem ver o valor.
 */
export function redigirSegredos(texto: string): { texto: string; redigidos: number } {
  let redigidos = 0;
  let saida = texto;

  for (const { regex } of PADROES_LEXICAIS) {
    // `replace` com regex global reinicia `lastIndex` sozinho; usar `test`
    // antes deixaria o índice sujo entre chamadas e puliria ocorrências.
    saida = saida.replace(new RegExp(regex.source, regex.flags), (_m, rotulo, sep) => {
      redigidos += 1;
      return `${rotulo}${sep}${MARCA_REDIGIDO}`;
    });
  }

  return { texto: saida, redigidos };
}

export type ResultadoBloqueio =
  | { bloqueado: false }
  | { bloqueado: true; motivo: string; categoria: "extensao" | "nome" | "conteudo" };

/** Extensão em minúsculas, sem ponto. "" quando o nome não tem extensão. */
function extensaoDe(nome: string): string {
  const base = nome.split(/[/\\]/).pop() ?? "";
  const partes = base.split(".");
  return partes.length < 2 ? "" : partes.pop()!.toLowerCase();
}

/**
 * Checagem por NOME. Roda antes de ler o arquivo — é a barreira mais barata e
 * a única que funciona sem tocar no conteúdo.
 */
export function bloqueadoPorNome(nomeArquivo: string): ResultadoBloqueio {
  const base = (nomeArquivo.split(/[/\\]/).pop() ?? "").trim();
  const extensao = extensaoDe(base);

  if (extensao && (EXTENSOES_BLOQUEADAS as readonly string[]).includes(extensao)) {
    return {
      bloqueado: true,
      categoria: "extensao",
      motivo:
        `Arquivos .${extensao} são certificados ou chaves e nunca são processados. ` +
        "O conteúdo não foi lido.",
    };
  }

  for (const padrao of NOMES_BLOQUEADOS) {
    if (padrao.test(base)) {
      return {
        bloqueado: true,
        categoria: "nome",
        motivo:
          `O nome "${base}" indica arquivo de credencial. O conteúdo não foi lido.`,
      };
    }
  }

  return { bloqueado: false };
}

/**
 * Checagem por CONTEÚDO, para os tipos que a allowlist aceita.
 *
 * Recebe o texto já extraído. Devolve o PRIMEIRO padrão encontrado e nunca o
 * trecho casado — ecoar o segredo na mensagem de erro seria vazá-lo no log,
 * que é exatamente o que estamos evitando.
 */
export function bloqueadoPorConteudo(texto: string): ResultadoBloqueio {
  for (const { nome, regex } of PADROES_ESTRUTURAIS) {
    if (regex.test(texto)) {
      return {
        bloqueado: true,
        categoria: "conteudo",
        motivo:
          `O arquivo aparenta conter ${nome}. Não foi enviado ao modelo nem classificado. ` +
          "Remova a credencial e anexe de novo.",
      };
    }
  }

  return { bloqueado: false };
}

/**
 * Barreira completa: nome primeiro, conteúdo depois.
 *
 * `texto` é opcional porque a checagem de nome precisa acontecer ANTES de o
 * arquivo ser lido. Chamar sem texto é o uso correto no upload.
 */
export function verificarBloqueio(
  nomeArquivo: string,
  texto?: string | null
): ResultadoBloqueio {
  const porNome = bloqueadoPorNome(nomeArquivo);
  if (porNome.bloqueado) return porNome;

  if (texto) return bloqueadoPorConteudo(texto);
  return { bloqueado: false };
}
