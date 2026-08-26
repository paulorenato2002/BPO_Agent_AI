import { FormularioLogin } from "./FormularioLogin";

export const metadata = { title: "Entrar — Effective AI" };

/** Mensagens amigáveis para os motivos de redirecionamento. */
const MOTIVOS: Record<string, string> = {
  sessao_expirada: "Sua sessão expirou. Entre novamente.",
  inativo: "Sua conta está desativada. Procure um administrador.",
  sem_perfil: "Sua conta ainda não tem perfil interno. Procure um administrador.",
};

export default async function PaginaLogin({
  searchParams,
}: PageProps<"/login">) {
  const params = await searchParams;
  const proximo = typeof params.proximo === "string" ? params.proximo : "/";
  const motivoBruto = typeof params.motivo === "string" ? params.motivo : undefined;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-fundo-conversa px-4 py-10">
      <FormularioLogin
        proximo={proximo}
        motivo={motivoBruto ? MOTIVOS[motivoBruto] : undefined}
      />
    </main>
  );
}
