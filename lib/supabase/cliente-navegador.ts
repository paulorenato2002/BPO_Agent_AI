"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Cliente Supabase do NAVEGADOR.
 *
 * Usa a chave pública (anon). Isso é seguro porque a chave, sozinha, não dá
 * acesso a nada: as 26 tabelas de cadastro tiveram o acesso anônimo revogado
 * (migration 20260827100200) e as tabelas novas nunca o tiveram. O que libera
 * dados é o JWT do usuário autenticado, avaliado pela RLS.
 *
 * A `service_role` NUNCA aparece aqui — ela só existe no servidor.
 */
export function criarClienteNavegador() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !chave) {
    throw new Error(
      "Faltam NEXT_PUBLIC_SUPABASE_URL ou NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }

  return createBrowserClient(url, chave);
}
