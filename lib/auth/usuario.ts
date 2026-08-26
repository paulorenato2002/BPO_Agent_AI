import "server-only";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "../supabase-admin";

/**
 * Identificação do usuário autenticado.
 *
 * ESTADO ATUAL: `auth.users` está vazio e `perfis_usuarios` ainda não existe
 * (as migrations não foram aplicadas). Portanto `usuarioAtual()` devolve `null`
 * neste momento — de propósito. Nada aqui inventa um usuário: a interface
 * mostra o estado "não autenticado" em vez de um nome fictício.
 *
 * Quando houver login configurado, o token do Supabase Auth chega pelo cookie
 * e este módulo passa a resolver o usuário e o perfil interno normalmente.
 */

export type UsuarioAutenticado = {
  id: string;
  email: string | null;
  /** Vem de perfis_usuarios; null se o usuário ainda não tem perfil interno. */
  nome: string | null;
  papel: string | null;
  departamento: string | null;
  ativo: boolean;
};

const NOME_COOKIE_TOKEN = "sb-access-token";

/**
 * Resolve o usuário a partir do token de acesso presente no cookie.
 * Retorna null quando não há sessão — sem lançar.
 */
export async function usuarioAtual(): Promise<UsuarioAutenticado | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;

  const token = (await cookies()).get(NOME_COOKIE_TOKEN)?.value;
  if (!token) return null;

  try {
    // Cliente com a chave pública: valida o token do próprio usuário.
    // A service_role NUNCA é usada para autenticar alguém.
    const cliente = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data, error } = await cliente.auth.getUser(token);
    if (error || !data.user) return null;

    const perfil = await carregarPerfil(data.user.id);

    return {
      id: data.user.id,
      email: data.user.email ?? null,
      nome: perfil?.nome ?? null,
      papel: perfil?.papel ?? null,
      departamento: perfil?.departamento ?? null,
      ativo: perfil?.ativo ?? false,
    };
  } catch {
    return null;
  }
}

async function carregarPerfil(usuarioId: string): Promise<{
  nome: string;
  papel: string;
  departamento: string | null;
  ativo: boolean;
} | null> {
  const { data, error } = await supabaseAdmin
    .from("perfis_usuarios")
    .select("nome, papel, departamento, ativo")
    .eq("usuario_id", usuarioId)
    .maybeSingle();

  // Tabela ainda não migrada (PGRST205) não é erro fatal aqui.
  if (error || !data) return null;

  return {
    nome: data.nome as string,
    papel: data.papel as string,
    departamento: (data.departamento as string | null) ?? null,
    ativo: Boolean(data.ativo),
  };
}
