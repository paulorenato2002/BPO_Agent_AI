import "server-only";
import { criarClienteServidor } from "../supabase/cliente-servidor";
import { supabaseAdmin } from "../supabase-admin";

/**
 * Identificação do usuário autenticado.
 *
 * Regra de acesso: só usa o sistema quem tem, ao mesmo tempo,
 *   1. conta válida em `auth.users`;
 *   2. perfil correspondente em `perfis_usuarios`;
 *   3. `ativo = true`.
 *
 * Um colaborador desativado continua com a conta e o histórico preservados,
 * mas `usuarioAtual()` devolve null — perdendo acesso a rotas, conversas,
 * consultas e ferramentas.
 */

export type UsuarioAutenticado = {
  id: string;
  email: string | null;
  nome: string;
  papel: PapelUsuario;
  departamento: string | null;
};

export type PapelUsuario =
  | "administrador"
  | "socio"
  | "supervisor"
  | "analista"
  | "estagiaria";

/** Papéis que podem aprovar memória de empresa/organizacional. */
export const PAPEIS_APROVADORES: PapelUsuario[] = [
  "administrador",
  "socio",
  "supervisor",
];

/** Papéis que podem convidar novos colaboradores. */
export const PAPEIS_ADMINISTRATIVOS: PapelUsuario[] = ["administrador", "socio"];

export type MotivoSemAcesso = "sem_sessao" | "sem_perfil" | "inativo";

export type ResultadoUsuario =
  | { autenticado: true; usuario: UsuarioAutenticado }
  | { autenticado: false; motivo: MotivoSemAcesso };

/**
 * Resolve o usuário da requisição atual, com o motivo quando não há acesso.
 *
 * Usa `getUser()` (valida o token no servidor do Supabase), nunca `getSession()`
 * — que apenas lê o cookie e confiaria num token possivelmente forjado.
 */
export async function usuarioAtualDetalhado(): Promise<ResultadoUsuario> {
  try {
    const supabase = await criarClienteServidor();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) return { autenticado: false, motivo: "sem_sessao" };

    // O perfil é lido com service_role de propósito: a política de
    // perfis_usuarios depende de op_usuario_interno_ativo(), que consulta a
    // própria tabela. Ler pelo cliente do usuário aqui seria circular.
    const { data: perfil } = await supabaseAdmin
      .from("perfis_usuarios")
      .select("nome, papel, departamento, ativo")
      .eq("usuario_id", user.id)
      .maybeSingle();

    if (!perfil) return { autenticado: false, motivo: "sem_perfil" };
    if (!perfil.ativo) return { autenticado: false, motivo: "inativo" };

    return {
      autenticado: true,
      usuario: {
        id: user.id,
        email: user.email ?? null,
        nome: perfil.nome as string,
        papel: perfil.papel as PapelUsuario,
        departamento: (perfil.departamento as string | null) ?? null,
      },
    };
  } catch {
    return { autenticado: false, motivo: "sem_sessao" };
  }
}

/** Versão curta: o usuário, ou null. */
export async function usuarioAtual(): Promise<UsuarioAutenticado | null> {
  const r = await usuarioAtualDetalhado();
  return r.autenticado ? r.usuario : null;
}

/** Lança se não houver usuário — para rotas que exigem autenticação. */
export async function exigirUsuario(): Promise<UsuarioAutenticado> {
  const usuario = await usuarioAtual();
  if (!usuario) throw new Error("nao_autenticado");
  return usuario;
}

export function temPapel(
  usuario: UsuarioAutenticado,
  ...papeis: PapelUsuario[]
): boolean {
  return papeis.includes(usuario.papel);
}
