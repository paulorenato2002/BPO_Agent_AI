import type { RegraArquivamento } from "./caminhos";

/**
 * Adaptação reversível do teste local. Não altera o catálogo do Supabase.
 *
 * ESTE PADRÃO TEM UM GÊMEO. A mesma adaptação existe em
 * `Mini-Sistemas/arquivador_docs/arquivador/config.py`, porque o worker
 * recalcula o destino antes de copiar e RECUSA o item se o resultado divergir
 * do que foi mostrado ao colaborador. Os dois precisam mudar juntos: mexer só
 * de um lado não gera arquivo no lugar errado — gera "a regra ou o nome da
 * empresa mudou" em todos os arquivamentos, e a causa não aparece no erro.
 */
export function regraParaPastaExistente(regra: RegraArquivamento): RegraArquivamento {
  if (!regra.exige_empresa) return regra;
  return { ...regra, caminho_modelo: ["{ANO}", "{COMPETENCIA_PASTA}"],
    exige_competencia: true, projeto: null,
    padrao_nome: "{CODIGO}_{EMPRESA}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}" };
}
