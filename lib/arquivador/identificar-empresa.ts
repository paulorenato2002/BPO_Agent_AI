/**
 * Identificação da empresa a partir do conteúdo e do contexto.
 *
 * Módulo PURO: recebe as empresas candidatas já filtradas (só as que o usuário
 * pode ver) e os sinais extraídos do arquivo. Não consulta banco.
 *
 * A regra que manda em tudo: NUNCA INVENTAR EMPRESA. Quando o sinal é fraco,
 * ambíguo ou ausente, isso é dito — `ausente` ou `conflitante` — e a decisão
 * volta para o humano. Um palpite errado aqui arquiva documento de um cliente
 * na pasta de outro, que é o pior defeito possível neste sistema.
 *
 * Cada resposta vem com EVIDÊNCIA concreta: o que casou, e onde. "Achei a
 * empresa" sem dizer por quê não dá para conferir.
 */

export type NivelConfianca = "confirmado" | "provavel" | "ausente" | "conflitante";

export type EmpresaCandidata = {
  id: string;
  codigo: string | null;
  razao_social: string | null;
  nome_fantasia: string | null;
  cnpj: string | null;
  ativo: boolean;
  /** Apelidos adicionais. Hoje derivados dos nomes; ver pendência no README. */
  aliases?: string[];
};

export type Evidencia = {
  campo: string;
  valor: string;
  origem: "conteudo" | "nome_arquivo" | "contexto";
  detalhe: string;
};

export type ResultadoIdentificacao = {
  confianca: NivelConfianca;
  empresa: EmpresaCandidata | null;
  evidencias: Evidencia[];
  /** Preenchido quando mais de uma empresa casou com sinais fortes. */
  conflitos: { empresaId: string; rotulo: string; motivo: string }[];
};

/** Sinais brutos extraídos de um arquivo, antes de virarem identificação. */
export type SinaisArquivo = {
  cnpjs: string[];
  texto: string;
  nomeArquivo: string;
};

// --- CNPJ --------------------------------------------------------------------

export function normalizarCnpj(valor: string): string {
  return valor.replace(/\D/g, "");
}

/**
 * Valida os dígitos verificadores.
 *
 * Sem isso, qualquer sequência de 14 dígitos num extrato — número de contrato,
 * código de barras, nosso número — viraria "CNPJ encontrado" e apontaria para
 * a empresa errada com confiança máxima.
 */
export function cnpjValido(valor: string): boolean {
  const d = normalizarCnpj(valor);
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;

  const digito = (ate: number): number => {
    let peso = ate - 7;
    let soma = 0;
    for (let i = 0; i < ate; i++) {
      soma += Number(d[i]) * peso--;
      if (peso < 2) peso = 9;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  return digito(12) === Number(d[12]) && digito(13) === Number(d[13]);
}

/** Todos os CNPJs válidos e distintos presentes num texto. */
export function extrairCnpjs(texto: string): string[] {
  const encontrados = new Set<string>();

  // Formatado (00.000.000/0000-00) e cru (14 dígitos seguidos).
  const padroes = [/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g, /(?<!\d)\d{14}(?!\d)/g];

  for (const padrao of padroes) {
    for (const achado of texto.matchAll(padrao)) {
      const limpo = normalizarCnpj(achado[0]);
      if (cnpjValido(limpo)) encontrados.add(limpo);
    }
  }

  return [...encontrados];
}

// --- Texto -------------------------------------------------------------------

/** Sem acento, maiúsculo, pontuação virando espaço. Para comparar nomes. */
function normalizar(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // marcas de acentuação
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * Palavras que não distinguem uma empresa de outra. Casar por "LTDA" acharia
 * metade da carteira.
 */
const PALAVRAS_VAZIAS = new Set([
  "LTDA", "ME", "EPP", "EIRELI", "SA", "S", "A", "CIA", "COMPANHIA",
  "COMERCIO", "COMERCIAL", "INDUSTRIA", "SERVICOS", "SERVICO", "DE", "DA",
  "DO", "DAS", "DOS", "E", "EM", "EMPRESA", "GRUPO", "BRASIL",
]);

/** Termos que realmente identificam: sem palavra vazia, sem token curto. */
function termosSignificativos(nome: string): string[] {
  return normalizar(nome)
    .split(" ")
    .filter((t) => t.length >= 4 && !PALAVRAS_VAZIAS.has(t));
}

function rotulo(e: EmpresaCandidata): string {
  return e.codigo ?? e.nome_fantasia ?? e.razao_social ?? e.id;
}

// --- Identificação -----------------------------------------------------------

type Casamento = {
  empresa: EmpresaCandidata;
  forte: boolean;
  evidencia: Evidencia;
};

/**
 * Identifica a empresa entre as candidatas.
 *
 * `empresaDoContexto` é a empresa que o usuário já indicou na conversa. Ela
 * NÃO decide sozinha: se o conteúdo apontar outra, isso é conflito, não
 * confirmação. O documento manda mais que a lembrança do chat.
 */
export function identificarEmpresa(
  candidatas: EmpresaCandidata[],
  sinais: SinaisArquivo,
  empresaDoContexto?: string | null
): ResultadoIdentificacao {
  const casamentos: Casamento[] = [];

  const textoNorm = normalizar(sinais.texto);
  const nomeNorm = normalizar(sinais.nomeArquivo);
  const siglas = candidatas.filter(empresa =>
    [empresa.nome_fantasia, empresa.razao_social, ...(empresa.aliases ?? [])].some(nome => {
      const primeiro = normalizar(nome ?? "").split(" ")[0];
      return /^[A-Z]{2,3}$/.test(primeiro) && !PALAVRAS_VAZIAS.has(primeiro)
        && (` ${textoNorm} `.includes(` ${primeiro} `) || ` ${nomeNorm} `.includes(` ${primeiro} `));
    })
  );

  for (const empresa of candidatas) {
    // 1. CNPJ — o sinal mais forte que existe. Já validado por dígito.
    if (empresa.cnpj) {
      const cnpjEmpresa = normalizarCnpj(empresa.cnpj);
      if (cnpjEmpresa && sinais.cnpjs.includes(cnpjEmpresa)) {
        casamentos.push({
          empresa,
          forte: true,
          evidencia: {
            campo: "empresa",
            valor: rotulo(empresa),
            origem: "conteudo",
            detalhe: `CNPJ ${empresa.cnpj} encontrado no conteúdo do arquivo.`,
          },
        });
        continue;
      }
    }

    // 2. Código curto — forte, mas só como palavra inteira. "TL" não pode
    //    casar dentro de "CONTROLE".
    if (empresa.codigo && empresa.codigo.length >= 2) {
      const cod = normalizar(empresa.codigo);
      const comoPalavra = new RegExp(`(^|\\s)${cod}(\\s|$)`);
      const ondeNome = comoPalavra.test(nomeNorm);
      const ondeTexto = comoPalavra.test(textoNorm);

      if (ondeNome || ondeTexto) {
        casamentos.push({
          empresa,
          forte: true,
          evidencia: {
            campo: "empresa",
            valor: rotulo(empresa),
            origem: ondeNome ? "nome_arquivo" : "conteudo",
            detalhe: `Código "${empresa.codigo}" encontrado ${
              ondeNome ? "no nome do arquivo" : "no conteúdo"
            }.`,
          },
        });
        continue;
      }
    }

    // 3. Razão social, nome fantasia e apelidos — sinal FRACO. Nome comercial
    //    se parece com o de outros clientes, então nunca vira "confirmado".
    const nomes = [empresa.razao_social, empresa.nome_fantasia, ...(empresa.aliases ?? [])]
      .filter((n): n is string => Boolean(n));

    let casouNome = false;
    for (const nome of nomes) {
      const termos = termosSignificativos(nome);
      if (termos.length === 0) continue;

      const casados = termos.filter(
        (t) => textoNorm.includes(t) || nomeNorm.includes(t)
      );

      // Exige TODOS os termos significativos: casar só "TRANSPORTADORA"
      // acharia qualquer transportadora da carteira.
      if (casados.length === termos.length) {
        casamentos.push({
          empresa,
          forte: false,
          evidencia: {
            campo: "empresa",
            valor: rotulo(empresa),
            origem: textoNorm.includes(casados[0]) ? "conteudo" : "nome_arquivo",
            detalhe: `Nome "${nome}" reconhecido (termos: ${casados.join(", ")}).`,
          },
        });
        casouNome = true;
        break;
      }
    }

    if (casouNome) continue;

    // 4. Contexto da conversa — fraco por natureza: o usuário pode ter mudado
    //    de assunto sem avisar.
    if (empresaDoContexto && empresa.id === empresaDoContexto) {
      casamentos.push({
        empresa,
        forte: false,
        evidencia: {
          campo: "empresa",
          valor: rotulo(empresa),
          origem: "contexto",
          detalhe: "Empresa já em uso nesta conversa. O conteúdo não confirmou.",
        },
      });
    }
  }

  // "TL" pode ser o nome curto de mais de um cliente. Isso é uma opção para
  // perguntar, nunca confirmação. Um CNPJ continua prevalecendo sobre a sigla.
  const temCnpj = casamentos.some(c => c.forte && c.evidencia.detalhe.startsWith("CNPJ "));
  if (!temCnpj) {
    for (const empresa of siglas) {
      if (!casamentos.some(c => c.empresa.id === empresa.id)) {
        const noNome = [empresa.nome_fantasia, empresa.razao_social, ...(empresa.aliases ?? [])]
          .some(nome => {
            const sigla = normalizar(nome ?? "").split(" ")[0];
            return /^[A-Z]{2,3}$/.test(sigla) && ` ${nomeNorm} `.includes(` ${sigla} `);
          });
        casamentos.push({ empresa, forte: false, evidencia: {
          campo: "empresa", valor: rotulo(empresa), origem: noNome ? "nome_arquivo" : "conteudo",
          detalhe: `Sigla compatível com ${empresa.codigo ?? ""}-${empresa.nome_fantasia ?? empresa.razao_social}. Confirme qual empresa é.`,
        } });
      }
    }
    const ids = new Set(casamentos.map(c => c.empresa.id));
    if (siglas.length > 0 && ids.size > 1 && casamentos.some(c => c.empresa.codigo && c.empresa.codigo.length <= 3)) {
      return { confianca: "conflitante", empresa: null, evidencias: casamentos.map(c => c.evidencia),
        conflitos: [...new Map(casamentos.map(c => [c.empresa.id, {
          empresaId: c.empresa.id,
          rotulo: `${c.empresa.codigo ?? ""}-${c.empresa.nome_fantasia ?? c.empresa.razao_social ?? ""}`,
          motivo: c.evidencia.detalhe,
        }])).values()] };
    }
  }
  const distintas = [...new Map(casamentos.map((c) => [c.empresa.id, c])).values()];

  if (distintas.length === 0) {
    return { confianca: "ausente", empresa: null, evidencias: [], conflitos: [] };
  }

  const fortes = distintas.filter((c) => c.forte);

  // Mais de uma empresa com sinal forte: o arquivo cita duas. Não escolhemos.
  if (fortes.length > 1) {
    return {
      confianca: "conflitante",
      empresa: null,
      evidencias: fortes.map((c) => c.evidencia),
      conflitos: fortes.map((c) => ({
        empresaId: c.empresa.id,
        rotulo: rotulo(c.empresa),
        motivo: c.evidencia.detalhe,
      })),
    };
  }

  if (fortes.length === 1) {
    // Um sinal forte manda, mesmo que outra empresa tenha casado por nome:
    // CNPJ vale mais que semelhança de razão social.
    return {
      confianca: "confirmado",
      empresa: fortes[0].empresa,
      evidencias: [fortes[0].evidencia],
      conflitos: [],
    };
  }

  // Só sinais fracos. Mais de um => conflito; um só => provável.
  if (distintas.length > 1) {
    return {
      confianca: "conflitante",
      empresa: null,
      evidencias: distintas.map((c) => c.evidencia),
      conflitos: distintas.map((c) => ({
        empresaId: c.empresa.id,
        rotulo: rotulo(c.empresa),
        motivo: c.evidencia.detalhe,
      })),
    };
  }

  return {
    confianca: "provavel",
    empresa: distintas[0].empresa,
    evidencias: [distintas[0].evidencia],
    conflitos: [],
  };
}

// --- Competência -------------------------------------------------------------

const MESES: Record<string, string> = {
  JANEIRO: "01", FEVEREIRO: "02", MARCO: "03", ABRIL: "04",
  MAIO: "05", JUNHO: "06", JULHO: "07", AGOSTO: "08",
  SETEMBRO: "09", OUTUBRO: "10", NOVEMBRO: "11", DEZEMBRO: "12",
  JAN: "01", FEV: "02", MAR: "03", ABR: "04", MAI: "05", JUN: "06",
  JUL: "07", AGO: "08", SET: "09", OUT: "10", NOV: "11", DEZ: "12",
};

/**
 * Encontra a competência (AAAA-MM) no nome do arquivo ou no conteúdo.
 *
 * Devolve `conflitante` quando acha mais de uma: um extrato que cita três
 * meses não tem competência óbvia, e chutar a primeira arquivaria no mês
 * errado.
 */
export function identificarCompetencia(
  texto: string,
  nomeArquivo: string
): { confianca: NivelConfianca; competencia: string | null; evidencias: Evidencia[] } {
  const achados = new Map<string, Evidencia>();

  const registrar = (comp: string, origem: Evidencia["origem"], detalhe: string) => {
    if (!achados.has(comp)) {
      achados.set(comp, { campo: "competencia", valor: comp, origem, detalhe });
    }
  };

  const fontes: { valor: string; origem: Evidencia["origem"] }[] = [
    { valor: nomeArquivo, origem: "nome_arquivo" },
    { valor: texto, origem: "conteudo" },
  ];

  for (const { valor, origem } of fontes) {
    // AAAA-MM / AAAA_MM
    for (const m of valor.matchAll(/(?<!\d)(20\d{2})[-_](0[1-9]|1[0-2])(?!\d)/g)) {
      registrar(`${m[1]}-${m[2]}`, origem, `Competência ${m[1]}-${m[2]} em ${origem}.`);
    }
    // MM/AAAA
    for (const m of valor.matchAll(/(?<!\d)(0[1-9]|1[0-2])\/(20\d{2})(?!\d)/g)) {
      registrar(`${m[2]}-${m[1]}`, origem, `Data ${m[0]} em ${origem}.`);
    }
    // "SETEMBRO 2026" / "SET/2026"
    const norm = normalizar(valor);
    for (const m of norm.matchAll(/\b([A-Z]{3,9})\s+(20\d{2})\b/g)) {
      const mes = MESES[m[1]];
      if (mes) registrar(`${m[2]}-${mes}`, origem, `Mês por extenso "${m[1]} ${m[2]}".`);
    }
  }

  const lista = [...achados.entries()];
  if (lista.length === 0) {
    return { confianca: "ausente", competencia: null, evidencias: [] };
  }
  if (lista.length > 1) {
    return {
      confianca: "conflitante",
      competencia: null,
      evidencias: lista.map(([, e]) => e),
    };
  }

  const [comp, evidencia] = lista[0];
  // Vindo do nome do arquivo é mais confiável: alguém nomeou de propósito.
  return {
    confianca: evidencia.origem === "nome_arquivo" ? "confirmado" : "provavel",
    competencia: comp,
    evidencias: [evidencia],
  };
}
