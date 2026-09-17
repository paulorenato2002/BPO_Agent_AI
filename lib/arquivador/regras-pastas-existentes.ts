import type { RegraArquivamento } from "./caminhos";

/**
 * Adaptação reversível do teste local. Não altera o catálogo do Supabase.
 *
 * A estrutura que existe hoje no disco é plana: dentro da pasta do cliente vem
 * o ano e a competência ("2026/09.2026"), e o tipo do documento vive no nome
 * do arquivo. Esta função traduz a regra do banco para essa realidade.
 *
 * AS REGRAS `CLIENTE_*` MANTÊM SUAS PASTAS FIXAS. Elas já são escritas para a
 * estrutura de hoje, então uma pasta literal ("AGENDAMENTOS") fica antes do
 * ano — é assim que o histórico de contas a pagar, agendamentos e comprovantes
 * fica separado dentro da pasta do cliente. As regras antigas (`MENSAL_*`,
 * `PROJETO_*`) descrevem a estrutura que ainda não existe no disco e continuam
 * achatadas em ano/competência.
 *
 * ESTE PADRÃO TEM UM GÊMEO. A mesma adaptação existe em
 * `Mini-Sistemas/arquivador_docs/arquivador/config.py`, porque o worker
 * recalcula o destino antes de copiar e RECUSA o item se o resultado divergir
 * do que foi mostrado ao colaborador. Os dois precisam mudar juntos: mexer só
 * de um lado não gera arquivo no lugar errado — gera "o destino mudou desde a
 * proposta" em todos os arquivamentos. O teste `arquivador-caminhos-gemeos`
 * compara as duas implementações para essa divergência não passar calada.
 */
export function regraParaPastaExistente(regra: RegraArquivamento): RegraArquivamento {
  if (!regra.exige_empresa) return regra;
  const fixos = regra.codigo.startsWith("CLIENTE_")
    ? regra.caminho_modelo.filter((s) => !s.includes("{"))
    : [];
  return {
    ...regra,
    caminho_modelo: [...fixos, "{ANO}", "{COMPETENCIA_PASTA}"],
    exige_competencia: true,
    projeto: null,
    padrao_nome: "{CODIGO}_{EMPRESA}_{COMPETENCIA}_{TIPO_DOCUMENTO}_{INSTITUICAO}_v{VERSAO}.{EXTENSAO}",
  };
}
