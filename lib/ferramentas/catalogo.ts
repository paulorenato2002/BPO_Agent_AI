import "server-only";
import { registroFerramentas } from "./registro";
import { ferramentaAnalisarDocumentos, ferramentaArquivarDocumentos, ferramentaProcessarDocumentos } from "./arquivador";
import { ferramentaLinkPainel } from "./painel";
import { ferramentaConferirAgendamentos } from "./conferimento";

/**
 * Catálogo de ferramentas de negócio.
 *
 * O registro em si é uma estrutura vazia; é aqui que as ferramentas entram.
 * A função é idempotente de propósito: pode ser chamada várias vezes.
 *
 * Em desenvolvimento, editar uma ferramenta recarrega este módulo, mas não o
 * registro. A mesma ferramenta chega então com uma definição nova: ela
 * SUBSTITUI a antiga. Antes disso, a recarga tentava registrar de novo, o
 * registro recusava o código repetido e o chat inteiro caía com erro 500 até
 * reiniciar o servidor.
 *
 * Registrar NÃO liga a ferramenta ao chat. O loop de conversa ainda monta a
 * própria lista de tools; plugar o registro nele é a etapa da interface.
 */

const FERRAMENTAS = [
  ferramentaAnalisarDocumentos,
  ferramentaArquivarDocumentos,
  ferramentaProcessarDocumentos,
  ferramentaLinkPainel,
  ferramentaConferirAgendamentos,
];

export function registrarFerramentasDeNegocio(): typeof registroFerramentas {
  for (const ferramenta of FERRAMENTAS) {
    const atual = registroFerramentas.obter(ferramenta.codigo);
    if (atual === ferramenta) continue;
    if (atual) registroFerramentas.substituir(ferramenta);
    else registroFerramentas.registrar(ferramenta);
  }
  return registroFerramentas;
}

/** Só para teste: mantido por compatibilidade; o registro já é idempotente. */
export function _resetarCatalogo(): void {}
