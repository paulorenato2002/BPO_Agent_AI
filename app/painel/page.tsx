import { redirect } from "next/navigation";
import { usuarioAtual } from "@/lib/auth/usuario";
import { PainelArquivamento } from "./PainelArquivamento";

export const metadata = {
  title: "Arquivamento em lote — Effective AI",
  description: "Envie vários documentos, revise o destino de cada um e arquive.",
};

export default async function PaginaPainel() {
  const usuario = await usuarioAtual();
  if (!usuario) redirect("/login");
  return <PainelArquivamento />;
}
