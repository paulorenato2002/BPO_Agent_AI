import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

/**
 * Cliente Supabase do SERVIDOR, ligado aos cookies da requisição.
 *
 * Server Components, Route Handlers e Server Actions usam este cliente. Ele
 * respeita a RLS do usuário logado — diferente de `supabaseAdmin`, que usa a
 * service_role e ignora RLS.
 *
 * Regra prática: se a operação é "em nome do usuário", use este. Se é uma
 * operação de sistema (registrar evento, ler schema), use supabaseAdmin.
 */
export async function criarClienteServidor() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !chave) {
    throw new Error(
      "Faltam NEXT_PUBLIC_SUPABASE_URL ou NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }

  const armazemCookies = await cookies();

  return createServerClient(url, chave, {
    cookies: {
      getAll() {
        return armazemCookies.getAll();
      },
      setAll(cookiesParaDefinir) {
        try {
          for (const { name, value, options } of cookiesParaDefinir) {
            armazemCookies.set(name, value, options);
          }
        } catch {
          // Server Components não podem escrever cookies. Isso é esperado:
          // a renovação da sessão acontece no proxy.ts, que pode.
        }
      },
    },
  });
}
