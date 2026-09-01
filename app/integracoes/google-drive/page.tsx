import Link from "next/link";
import { headers } from "next/headers";
import { usuarioAtual, PAPEIS_ADMINISTRATIVOS } from "@/lib/auth/usuario";
import {
  consumirRefreshToken,
  exibicaoPermitida,
} from "@/lib/integracoes/refresh-token-temporario";
import { lerConfigOAuth, ehConfigFaltando, temRefreshToken } from "@/lib/integracoes/google-oauth";
import { PainelConexao } from "./PainelConexao";

export const dynamic = "force-dynamic";
export const metadata = { title: "Google Drive — Effective AI" };

const MOTIVOS_ERRO: Record<string, string> = {
  sem_permissao: "Apenas administrador ou sócio pode conectar integrações.",
  cancelado: "Autorização cancelada. Nada foi alterado.",
  google: "O Google recusou a autorização. Tente novamente.",
  state_invalido:
    "A verificação de segurança falhou (state inválido ou reutilizado). Comece o fluxo de novo por esta página.",
  sem_codigo: "O Google não enviou o código de autorização.",
  config: "Configuração incompleta. Verifique o .env.local.",
  troca: "Não foi possível trocar o código por tokens.",
  sem_refresh_token:
    "O Google não devolveu um refresh token. Isso acontece quando a conta já autorizou este app antes. " +
    "Remova o acesso em myaccount.google.com/permissions e conecte novamente.",
};

export default async function PaginaGoogleDrive({
  searchParams,
}: PageProps<"/integracoes/google-drive">) {
  const usuario = await usuarioAtual();

  if (!usuario) {
    return <Aviso titulo="Sessão expirada" texto="Entre novamente para continuar." />;
  }
  if (!PAPEIS_ADMINISTRATIVOS.includes(usuario.papel)) {
    return (
      <Aviso
        titulo="Sem permissão"
        texto="Apenas administrador ou sócio pode conectar integrações."
      />
    );
  }

  // Além do ambiente, exigimos que o acesso seja local: a exibição do token
  // não pode acontecer por uma URL alcançável de fora.
  const host = (await headers()).get("host") ?? "";
  const ehLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

  const params = await searchParams;
  const erro = typeof params.erro === "string" ? params.erro : undefined;
  const chave = typeof params.chave === "string" ? params.chave : undefined;

  const token =
    chave && exibicaoPermitida() && ehLocal
      ? consumirRefreshToken(chave, usuario.id)
      : null;

  const config = lerConfigOAuth();

  return (
    <main className="min-h-dvh bg-fundo-conversa px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight text-texto">
          Conectar o Google Drive
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-texto-suave">
          A autorização usa uma conta Google de um colaborador. O app pede
          apenas o escopo <code className="rounded bg-fundo-sutil px-1">drive.file</code>,
          que dá acesso somente aos arquivos criados por ele — nunca ao restante
          do seu Drive.
        </p>

        <PainelConexao
          erro={erro ? (MOTIVOS_ERRO[erro] ?? "Não foi possível concluir.") : null}
          configFaltando={ehConfigFaltando(config) ? config.faltando : null}
          jaTemRefreshToken={temRefreshToken()}
          token={token}
          exibicaoPermitida={exibicaoPermitida() && ehLocal}
          ehLocal={ehLocal}
        />
      </div>
    </main>
  );
}

function Aviso({ titulo, texto }: { titulo: string; texto: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-fundo-conversa px-4">
      <div className="w-full max-w-md rounded-2xl border border-borda bg-fundo-cartao p-6 text-center">
        <h1 className="text-lg font-semibold text-texto">{titulo}</h1>
        <p className="mt-2 text-sm text-texto-suave">{texto}</p>
        <Link
          href="/"
          className="mt-4 inline-block rounded-xl bg-azul px-4 py-2 text-sm font-medium text-white hover:bg-azul-hover"
        >
          Voltar
        </Link>
      </div>
    </main>
  );
}
