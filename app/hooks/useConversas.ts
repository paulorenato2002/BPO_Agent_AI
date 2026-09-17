"use client";

import { useCallback, useEffect, useState } from "react";
import type { Conversa, UsuarioSessao } from "../componentes/tipos";

export type EstadoHistorico =
  | { carregando: true }
  | { carregando: false; ok: true; conversas: Conversa[]; ativas: number; limite: number }
  | { carregando: false; ok: false; motivo: "sem_sessao" | "erro"; detalhe: string };

/**
 * Histórico de conversas do usuário autenticado.
 *
 * Toda conversa aqui existe no banco: o "Novo chat" só entra na lista depois de
 * o servidor confirmar a criação e devolver o id real. Nada de id temporário.
 */
export function useConversas() {
  const [estado, setEstado] = useState<EstadoHistorico>({ carregando: true });
  const [sessao, setSessao] = useState<UsuarioSessao | null>(null);
  const [conversaAtivaId, setConversaAtivaId] = useState<string | null>(null);
  const [erroAcao, setErroAcao] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const resposta = await fetch("/api/conversas", { cache: "no-store" });
      if (resposta.status === 401) {
        setEstado({
          carregando: false,
          ok: false,
          motivo: "sem_sessao",
          detalhe: "Sessão expirada. Entre novamente.",
        });
        return;
      }
      const dados = await resposta.json();
      if (!dados.ok) {
        setEstado({
          carregando: false,
          ok: false,
          motivo: "erro",
          detalhe: dados.mensagem ?? "Não foi possível carregar o histórico.",
        });
        return;
      }
      setEstado({
        carregando: false,
        ok: true,
        conversas: dados.dados,
        ativas: dados.ativas,
        limite: dados.limite,
      });
    } catch {
      setEstado({
        carregando: false,
        ok: false,
        motivo: "erro",
        detalhe: "Falha de rede ao carregar o histórico.",
      });
    }
  }, []);

  useEffect(() => {
    let ativo = true;
    (async () => {
      const [hist, ses] = await Promise.allSettled([
        fetch("/api/conversas", { cache: "no-store" }).then((r) =>
          r.status === 401 ? { ok: false, codigo: "sem_sessao" } : r.json()
        ),
        fetch("/api/usuario", { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (!ativo) return;

      if (hist.status === "fulfilled" && hist.value?.ok) {
        setEstado({
          carregando: false,
          ok: true,
          conversas: hist.value.dados,
          ativas: hist.value.ativas,
          limite: hist.value.limite,
        });
      } else {
        setEstado({
          carregando: false,
          ok: false,
          motivo: "erro",
          detalhe: "Não foi possível carregar o histórico.",
        });
      }

      if (ses.status === "fulfilled") setSessao(ses.value as UsuarioSessao);
      else setSessao({ autenticado: false, detalhe: "Sessão não verificada." });
    })();
    return () => {
      ativo = false;
    };
  }, []);

  /** Cria (ou reutiliza um chat vazio) e devolve o id REAL. */
  const criarConversa = useCallback(async (): Promise<string | null> => {
    setErroAcao(null);
    try {
      const resposta = await fetch("/api/conversas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const dados = await resposta.json();

      if (!dados.ok) {
        // 409 = limite de 10 atingido. Não criamos nada nem apagamos nada.
        setErroAcao(dados.mensagem ?? "Não foi possível criar a conversa.");
        return null;
      }

      await carregar();
      setConversaAtivaId(dados.dados.id);
      return dados.dados.id as string;
    } catch {
      setErroAcao("Falha de rede ao criar a conversa.");
      return null;
    }
  }, [carregar]);

  const renomear = useCallback(
    async (id: string, titulo: string) => {
      setEstado((atual) =>
        atual.carregando === false && atual.ok
          ? {
              ...atual,
              conversas: atual.conversas.map((c) => (c.id === id ? { ...c, titulo } : c)),
            }
          : atual
      );
      await fetch(`/api/conversas/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ titulo }),
      }).catch(() => {});
      await carregar();
    },
    [carregar]
  );

  const encerrar = useCallback(
    async (id: string, modo: "arquivar" | "excluir") => {
      const endereco = `/api/conversas/${id}${modo === "excluir" ? "?modo=excluir" : ""}`;
      try {
        const resposta = await fetch(endereco, { method: "DELETE" });
        const dados = await resposta.json().catch(() => ({ ok: resposta.ok }));
        if (!dados.ok) {
          setErroAcao(dados.mensagem ?? "Não foi possível concluir. Tente de novo.");
          return false;
        }
      } catch {
        setErroAcao("Falha de rede. A conversa continua na lista.");
        return false;
      }
      setConversaAtivaId((atual) => (atual === id ? null : atual));
      setErroAcao(null);
      await carregar();
      return true;
    },
    [carregar]
  );

  const arquivar = useCallback((id: string) => encerrar(id, "arquivar"), [encerrar]);
  const excluir = useCallback((id: string) => encerrar(id, "excluir"), [encerrar]);

  /** Atualiza o título localmente quando o servidor o gera na 1ª mensagem. */
  const aplicarTitulo = useCallback((id: string, titulo: string) => {
    setEstado((atual) =>
      atual.carregando === false && atual.ok
        ? {
            ...atual,
            conversas: atual.conversas.map((c) => (c.id === id ? { ...c, titulo } : c)),
          }
        : atual
    );
  }, []);

  return {
    estado,
    sessao,
    conversaAtivaId,
    setConversaAtivaId,
    erroAcao,
    limparErroAcao: () => setErroAcao(null),
    carregar,
    criarConversa,
    renomear,
    arquivar,
    excluir,
    aplicarTitulo,
  };
}
