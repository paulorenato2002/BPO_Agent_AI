"use client";

import {
  IconeSupabase,
  IconeDrive,
  IconeEscudo,
  IconeMenu,
  IconeAlerta,
} from "./icones";
import type { ItemSaude } from "./tipos";

type Props = {
  titulo: string;
  saude: ItemSaude[] | null;
  carregandoSaude: boolean;
  onAbrirMenu: () => void;
};

export function CabecalhoChat({ titulo, saude, carregandoSaude, onAbrirMenu }: Props) {
  return (
    <header className="border-b border-borda bg-fundo-app px-4 pt-4 pb-3 md:px-8 md:pt-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onAbrirMenu}
            className="rounded-lg p-2 text-texto-suave hover:bg-fundo-sutil md:hidden"
            aria-label="Abrir menu de conversas"
          >
            <IconeMenu className="h-5 w-5 rotate-90" />
          </button>

          <h1 className="flex-1 truncate text-xl font-semibold tracking-tight md:text-[28px]">
            {titulo}
          </h1>

          <button
            className="rounded-xl border border-borda p-2.5 text-texto-suave transition-colors hover:bg-fundo-sutil"
            aria-label="Informações de segurança"
            title="A service_role fica só no servidor. Bucket privado."
          >
            <IconeEscudo />
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {carregandoSaude && (
            <>
              <PastilhaEsqueleto />
              <PastilhaEsqueleto />
            </>
          )}
          {!carregandoSaude &&
            saude?.map((item) => <PastilhaSaude key={item.chave} item={item} />)}
        </div>
      </div>
    </header>
  );
}

function PastilhaEsqueleto() {
  return (
    <div
      className="h-[42px] w-44 animate-pulse rounded-xl border border-borda bg-fundo-sutil"
      aria-hidden
    />
  );
}

/**
 * Reflete o health check REAL. Verde só aparece quando a integração respondeu
 * de fato — nunca é estático.
 */
function PastilhaSaude({ item }: { item: ItemSaude }) {
  const Icone =
    item.chave === "drive" ? IconeDrive : item.chave === "storage" ? IconeSupabase : IconeSupabase;

  const rotulo =
    item.estado === "conectado"
      ? `${item.nome} conectado`
      : item.estado === "nao_configurado"
        ? `${item.nome} não configurado`
        : `${item.nome} indisponível`;

  const estilos =
    item.estado === "conectado"
      ? "border-borda bg-fundo-app text-texto"
      : item.estado === "nao_configurado"
        ? "border-ambar/30 bg-ambar-suave text-ambar"
        : "border-vermelho/30 bg-vermelho-suave text-vermelho";

  return (
    <div
      className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm ${estilos}`}
      title={item.detalhe}
    >
      {item.estado === "conectado" ? (
        <Icone />
      ) : (
        <IconeAlerta className="h-4 w-4" />
      )}
      <span className="font-medium">{rotulo}</span>
      <span
        className={`h-2 w-2 rounded-full ${
          item.estado === "conectado"
            ? "bg-verde"
            : item.estado === "nao_configurado"
              ? "bg-ambar"
              : "bg-vermelho"
        }`}
        aria-hidden
      />
      <span className="sr-only">{item.detalhe}</span>
    </div>
  );
}
