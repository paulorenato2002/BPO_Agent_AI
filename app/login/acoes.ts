"use server";

import { redirect } from "next/navigation";
import { criarClienteServidor } from "@/lib/supabase/cliente-servidor";
import { registrarEvento } from "@/lib/ferramentas/registro";
import { supabaseAdmin } from "@/lib/supabase-admin";

/**
 * Ações de autenticação.
 *
 * PRIVACIDADE: as mensagens de erro nunca revelam se um e-mail existe. Login
 * inválido e usuário inexistente produzem exatamente a mesma resposta — senão
 * o formulário vira um verificador de e-mails da empresa.
 */

export type EstadoLogin = {
  erro?: string;
  aviso?: string;
};

const ERRO_GENERICO = "E-mail ou senha incorretos.";

/** Só aceita caminho interno — impede open redirect via ?proximo=. */
function destinoSeguro(valor: string | null): string {
  if (!valor) return "/";
  if (!valor.startsWith("/") || valor.startsWith("//")) return "/";
  return valor;
}

export async function entrar(
  _anterior: EstadoLogin,
  formulario: FormData
): Promise<EstadoLogin> {
  const email = String(formulario.get("email") ?? "").trim();
  const senha = String(formulario.get("senha") ?? "");
  const proximo = destinoSeguro(String(formulario.get("proximo") ?? "") || null);

  if (!email || !senha) {
    return { erro: "Informe e-mail e senha." };
  }

  const supabase = await criarClienteServidor();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: senha,
  });

  if (error || !data.user) {
    // Não diferenciamos "senha errada" de "usuário não existe".
    return { erro: ERRO_GENERICO };
  }

  // Autenticou no Supabase, mas ainda precisa ser colaborador interno ativo.
  const { data: perfil } = await supabaseAdmin
    .from("perfis_usuarios")
    .select("nome, ativo")
    .eq("usuario_id", data.user.id)
    .maybeSingle();

  if (!perfil || !perfil.ativo) {
    // Encerra a sessão que acabou de ser criada.
    await supabase.auth.signOut();
    await registrarEvento({
      tipoEvento: "acesso_negado",
      descricao: perfil
        ? "Tentativa de acesso de usuário desativado."
        : "Tentativa de acesso sem perfil interno.",
      severidade: "aviso",
      usuarioId: null,
      origem: "usuario",
      // Nunca registrar senha nem token.
      dados: { motivo: perfil ? "inativo" : "sem_perfil" },
    });
    return {
      erro: "Sua conta não está ativa. Procure um administrador.",
    };
  }

  await registrarEvento({
    tipoEvento: "login",
    descricao: `Login de ${perfil.nome}.`,
    usuarioId: data.user.id,
    origem: "usuario",
  });

  redirect(proximo);
}

export async function sair() {
  const supabase = await criarClienteServidor();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    await registrarEvento({
      tipoEvento: "logout",
      descricao: "Sessão encerrada pelo usuário.",
      usuarioId: user.id,
      origem: "usuario",
    });
  }

  await supabase.auth.signOut();
  redirect("/login");
}

export async function recuperarSenha(
  _anterior: EstadoLogin,
  formulario: FormData
): Promise<EstadoLogin> {
  const email = String(formulario.get("email") ?? "").trim();

  if (!email) return { erro: "Informe o e-mail." };

  const supabase = await criarClienteServidor();
  const origem = process.env.NEXT_PUBLIC_URL_APP ?? "http://localhost:3000";

  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origem}/definir-senha`,
  });

  // Resposta idêntica exista ou não o e-mail — não confirmamos cadastro.
  return {
    aviso:
      "Se este e-mail estiver cadastrado, você receberá as instruções em instantes.",
  };
}
