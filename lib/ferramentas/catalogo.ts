import "server-only";
import { registroFerramentas } from "./registro";
import { ferramentaAnalisarDocumentos } from "./arquivador";

/**
 * Catálogo de ferramentas de negócio.
 *
 * O registro em si é uma estrutura vazia; é aqui que as ferramentas entram.
 * A função é idempotente de propósito: em desenvolvimento o Next recarrega
 * módulos, e `registrar` lança se o código já existir.
 *
 * Registrar NÃO liga a ferramenta ao chat. O loop de conversa ainda monta a
 * própria lista de tools; plugar o registro nele é a etapa da interface.
 */

let registrado = false;

export function registrarFerramentasDeNegocio(): typeof registroFerramentas {
  if (registrado) return registroFerramentas;

  registroFerramentas.registrar(ferramentaAnalisarDocumentos);

  registrado = true;
  return registroFerramentas;
}

/** Só para teste: permite registrar de novo depois de `_limpar()`. */
export function _resetarCatalogo(): void {
  registrado = false;
}
