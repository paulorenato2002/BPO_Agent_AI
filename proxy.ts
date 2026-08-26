import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Proxy (antigo `middleware`, renomeado no Next 16).
 *
 * Faz duas coisas em toda requisição:
 *   1. renova a sessão do Supabase — o token expira e precisa ser rotacionado
 *      num lugar que possa ESCREVER cookies (Server Component não pode);
 *   2. protege as rotas internas, redirecionando quem não está autenticado.
 *
 * IMPORTANTE: usa `getUser()`, não `getSession()`. `getSession()` só lê o
 * cookie e confia nele; `getUser()` valida o token no servidor do Supabase.
 * Confiar no cookie sem validar é o erro clássico que permite forjar sessão.
 */

/** Rotas que podem ser abertas sem estar logado. */
const ROTAS_PUBLICAS = ["/login", "/recuperar-senha", "/definir-senha"];

function ehRotaPublica(caminho: string): boolean {
  return ROTAS_PUBLICAS.some((r) => caminho === r || caminho.startsWith(`${r}/`));
}

export async function proxy(request: NextRequest) {
  let resposta = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Sem configuração não há como validar sessão; não trave o app em branco.
  if (!url || !chave) return resposta;

  const supabase = createServerClient(url, chave, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesParaDefinir) {
        for (const { name, value } of cookiesParaDefinir) {
          request.cookies.set(name, value);
        }
        resposta = NextResponse.next({ request });
        for (const { name, value, options } of cookiesParaDefinir) {
          resposta.cookies.set(name, value, options);
        }
      },
    },
  });

  // Valida o token de verdade (e renova quando necessário).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const caminho = request.nextUrl.pathname;

  // Já logado tentando abrir o login: manda para a raiz.
  if (user && caminho === "/login") {
    const destino = request.nextUrl.clone();
    destino.pathname = "/";
    destino.search = "";
    return NextResponse.redirect(destino);
  }

  // Não logado em rota protegida: manda para o login guardando o destino,
  // para voltar depois de entrar.
  if (!user && !ehRotaPublica(caminho)) {
    const destino = request.nextUrl.clone();
    destino.pathname = "/login";
    destino.search = "";
    if (caminho !== "/") {
      destino.searchParams.set("proximo", caminho + request.nextUrl.search);
    }
    return NextResponse.redirect(destino);
  }

  return resposta;
}

export const config = {
  /**
   * Roda em tudo, menos assets estáticos e imagens — não faz sentido validar
   * sessão para servir um .png, e isso custaria latência em toda requisição.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
