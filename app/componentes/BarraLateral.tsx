"use client";

import { useEffect, useRef, useState } from "react";
import {
  IconeLogo,
  IconeMais,
  IconeBusca,
  IconeConversa,
  IconeMenu,
  IconeFechar,
  IconeRecolher,
  IconeChevron,
} from "./icones";
import {
  agruparPorPeriodo,
  type EstadoHistorico,
  type UsuarioSessao,
} from "./tipos";

type Props = {
  historico: EstadoHistorico;
  carregando: boolean;
  conversaAtivaId: string | null;
  sessao: UsuarioSessao | null;
  aberta: boolean;
  onFechar: () => void;
  onRecolher: () => void;
  onNovoChat: () => void;
  onSelecionar: (id: string) => void;
  onRenomear: (id: string, titulo: string) => void;
  onArquivar: (id: string) => void;
};

export function BarraLateral({
  historico,
  carregando,
  conversaAtivaId,
  sessao,
  aberta,
  onFechar,
  onRecolher,
  onNovoChat,
  onSelecionar,
  onRenomear,
  onArquivar,
}: Props) {
  const [busca, setBusca] = useState("");
  const [menuAberto, setMenuAberto] = useState<string | null>(null);
  const [renomeando, setRenomeando] = useState<string | null>(null);
  const [rascunhoTitulo, setRascunhoTitulo] = useState("");

  // Fecha o menu de ações ao clicar fora ou apertar Esc.
  useEffect(() => {
    if (!menuAberto) return;
    const aoClicar = () => setMenuAberto(null);
    const aoTeclar = (e: KeyboardEvent) => e.key === "Escape" && setMenuAberto(null);
    document.addEventListener("click", aoClicar);
    document.addEventListener("keydown", aoTeclar);
    return () => {
      document.removeEventListener("click", aoClicar);
      document.removeEventListener("keydown", aoTeclar);
    };
  }, [menuAberto]);

  const conversas = historico.disponivel ? historico.dados : [];
  const filtradas = busca.trim()
    ? conversas.filter((c) => c.titulo.toLowerCase().includes(busca.trim().toLowerCase()))
    : conversas;
  const grupos = agruparPorPeriodo(filtradas);

  return (
    <>
      {/* Fundo escurecido no mobile, quando a barra vira drawer. */}
      {aberta && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={onFechar}
          aria-hidden
        />
      )}

      <aside
        // O deslocamento no mobile vem das classes .barra-lateral /
        // .barra-lateral-aberta definidas em globals.css.
        className={`barra-lateral ${aberta ? "barra-lateral-aberta" : ""} fixed inset-y-0 left-0 z-40 flex w-[280px] flex-col bg-lateral-fundo text-lateral-texto transition-transform duration-200 md:static`}
        aria-label="Conversas"
      >
        {/* Identidade */}
        <div className="flex items-center justify-between px-4 pt-5 pb-4">
          <div className="flex items-center gap-2.5">
            <span className="text-azul">
              <IconeLogo className="h-7 w-7" />
            </span>
            <span className="text-[17px] font-semibold tracking-tight">Effective AI</span>
          </div>
          <button
            onClick={onFechar}
            className="rounded-lg p-1.5 text-lateral-texto-suave hover:bg-lateral-fundo-hover hover:text-lateral-texto md:hidden"
            aria-label="Fechar menu"
          >
            <IconeFechar />
          </button>
          <button
            onClick={onRecolher}
            className="hidden rounded-lg p-1.5 text-lateral-texto-suave hover:bg-lateral-fundo-hover hover:text-lateral-texto md:block"
            aria-label="Recolher barra lateral"
            title="Recolher barra lateral"
          >
            <IconeRecolher />
          </button>
        </div>

        {/* Novo chat */}
        <div className="px-3">
          <button
            onClick={onNovoChat}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-azul px-4 py-3 text-[15px] font-medium text-white transition-colors hover:bg-azul-hover"
          >
            <IconeMais />
            Novo chat
          </button>
        </div>

        {/* Busca */}
        <div className="px-3 pt-3">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-lateral-texto-suave">
              <IconeBusca />
            </span>
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar conversas"
              aria-label="Buscar conversas"
              className="w-full rounded-xl border border-lateral-borda bg-transparent py-2.5 pl-9 pr-3 text-sm text-lateral-texto placeholder:text-lateral-texto-suave focus:border-azul focus:outline-none"
            />
          </div>
        </div>

        {/* Histórico */}
        <nav className="rolagem-escura mt-4 flex-1 overflow-y-auto px-3 pb-4">
          {carregando && <EsqueletoHistorico />}

          {!carregando && !historico.disponivel && (
            <AvisoHistorico motivo={historico.motivo} detalhe={historico.detalhe} />
          )}

          {!carregando && historico.disponivel && filtradas.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-lateral-texto-suave">
              {busca.trim()
                ? "Nenhuma conversa encontrada."
                : "Nenhuma conversa ainda. Comece uma nova."}
            </p>
          )}

          {!carregando &&
            grupos.map((grupo) => (
              <div key={grupo.rotulo} className="mb-4">
                <h2 className="px-2 pb-1.5 text-xs font-medium text-lateral-texto-suave">
                  {grupo.rotulo}
                </h2>
                <ul className="space-y-0.5">
                  {grupo.itens.map((conversa) => {
                    const ativa = conversa.id === conversaAtivaId;
                    const emEdicao = renomeando === conversa.id;

                    return (
                      <li key={conversa.id} className="relative">
                        {emEdicao ? (
                          <input
                            autoFocus
                            value={rascunhoTitulo}
                            onChange={(e) => setRascunhoTitulo(e.target.value)}
                            onBlur={() => {
                              if (rascunhoTitulo.trim()) {
                                onRenomear(conversa.id, rascunhoTitulo.trim());
                              }
                              setRenomeando(null);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") e.currentTarget.blur();
                              if (e.key === "Escape") setRenomeando(null);
                            }}
                            aria-label="Novo título da conversa"
                            className="w-full rounded-lg border border-azul bg-lateral-fundo-ativo px-3 py-2.5 text-sm text-lateral-texto focus:outline-none"
                          />
                        ) : (
                          <div
                            className={`group flex items-center gap-2.5 rounded-lg px-3 py-2.5 transition-colors ${
                              ativa
                                ? "bg-lateral-fundo-ativo"
                                : "hover:bg-lateral-fundo-hover"
                            }`}
                          >
                            <button
                              onClick={() => onSelecionar(conversa.id)}
                              className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                              aria-current={ativa ? "page" : undefined}
                            >
                              <span className="text-lateral-texto-suave">
                                <IconeConversa />
                              </span>
                              <span className="truncate text-sm">{conversa.titulo}</span>
                            </button>

                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setMenuAberto(menuAberto === conversa.id ? null : conversa.id);
                              }}
                              className={`rounded p-1 text-lateral-texto-suave hover:text-lateral-texto ${
                                ativa || menuAberto === conversa.id
                                  ? "opacity-100"
                                  : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                              }`}
                              aria-label={`Ações da conversa ${conversa.titulo}`}
                              aria-haspopup="menu"
                              aria-expanded={menuAberto === conversa.id}
                            >
                              <IconeMenu />
                            </button>
                          </div>
                        )}

                        {menuAberto === conversa.id && (
                          <div
                            role="menu"
                            onClick={(e) => e.stopPropagation()}
                            className="absolute right-2 top-full z-10 mt-1 w-44 overflow-hidden rounded-xl border border-lateral-borda bg-lateral-fundo-ativo py-1 shadow-lg"
                          >
                            <button
                              role="menuitem"
                              onClick={() => {
                                setRascunhoTitulo(conversa.titulo);
                                setRenomeando(conversa.id);
                                setMenuAberto(null);
                              }}
                              className="w-full px-3 py-2 text-left text-sm hover:bg-lateral-fundo-hover"
                            >
                              Renomear
                            </button>
                            <button
                              role="menuitem"
                              onClick={() => {
                                onArquivar(conversa.id);
                                setMenuAberto(null);
                              }}
                              className="w-full px-3 py-2 text-left text-sm hover:bg-lateral-fundo-hover"
                            >
                              Arquivar
                            </button>
                            <button
                              role="menuitem"
                              onClick={() => setMenuAberto(null)}
                              className="w-full px-3 py-2 text-left text-sm text-lateral-texto-suave hover:bg-lateral-fundo-hover"
                            >
                              Cancelar
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
        </nav>

        {/* Usuário */}
        <RodapeUsuario sessao={sessao} />
      </aside>
    </>
  );
}

function EsqueletoHistorico() {
  return (
    <div className="space-y-2 px-1" aria-hidden>
      {[70, 55, 62, 48].map((largura, i) => (
        <div key={i} className="flex items-center gap-2.5 px-2 py-2.5">
          <div className="h-4 w-4 animate-pulse rounded bg-lateral-fundo-hover" />
          <div
            className="h-3 animate-pulse rounded bg-lateral-fundo-hover"
            style={{ width: `${largura}%` }}
          />
        </div>
      ))}
      <span className="sr-only">Carregando conversas…</span>
    </div>
  );
}

/**
 * Mostra o motivo REAL de o histórico não estar disponível, em vez de uma
 * lista vazia que pareceria "ainda não há conversas".
 */
function AvisoHistorico({ motivo, detalhe }: { motivo: string; detalhe: string }) {
  const titulo =
    motivo === "banco_nao_migrado"
      ? "Histórico indisponível"
      : motivo === "sem_autenticacao"
        ? "Sem sessão ativa"
        : "Erro ao carregar";

  return (
    <div className="mx-1 rounded-xl border border-lateral-borda bg-lateral-fundo-hover/50 px-3 py-3">
      <p className="text-sm font-medium text-lateral-texto">{titulo}</p>
      <p className="mt-1 text-xs leading-relaxed text-lateral-texto-suave">{detalhe}</p>
      <p className="mt-2 text-xs leading-relaxed text-lateral-texto-suave">
        As conversas desta sessão continuam funcionando, mas não são salvas.
      </p>
    </div>
  );
}

function RodapeUsuario({ sessao }: { sessao: UsuarioSessao | null }) {
  const [aberto, setAberto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!aberto) return;
    const aoClicar = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false);
    };
    document.addEventListener("mousedown", aoClicar);
    return () => document.removeEventListener("mousedown", aoClicar);
  }, [aberto]);

  if (!sessao) {
    return (
      <div className="border-t border-lateral-borda px-4 py-4">
        <div className="h-9 w-full animate-pulse rounded-lg bg-lateral-fundo-hover" aria-hidden />
      </div>
    );
  }

  if (!sessao.autenticado) {
    return (
      <div className="border-t border-lateral-borda px-4 py-4">
        <p className="text-sm font-medium text-lateral-texto">Não autenticado</p>
        <p className="mt-1 text-xs leading-relaxed text-lateral-texto-suave">{sessao.detalhe}</p>
      </div>
    );
  }

  const { usuario } = sessao;
  const nome = usuario.nome ?? usuario.email ?? "Usuário";
  const iniciais = nome
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div ref={ref} className="relative border-t border-lateral-borda px-3 py-3">
      <button
        onClick={() => setAberto(!aberto)}
        className="flex w-full items-center gap-3 rounded-lg px-1.5 py-1.5 text-left hover:bg-lateral-fundo-hover"
        aria-haspopup="menu"
        aria-expanded={aberto}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-azul text-sm font-semibold text-white">
          {iniciais || "?"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{nome}</span>
          <span className="block truncate text-xs text-lateral-texto-suave">
            {usuario.email ?? usuario.papel ?? ""}
          </span>
        </span>
        <span className={`text-lateral-texto-suave transition-transform ${aberto ? "rotate-180" : ""}`}>
          <IconeChevron />
        </span>
      </button>

      {aberto && (
        <div
          role="menu"
          className="absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-xl border border-lateral-borda bg-lateral-fundo-ativo py-1 shadow-lg"
        >
          <div className="px-3 py-2 text-xs text-lateral-texto-suave">
            Papel: {usuario.papel ?? "sem perfil interno"}
          </div>
        </div>
      )}
    </div>
  );
}
