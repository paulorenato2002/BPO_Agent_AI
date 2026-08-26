"use client";

import { useCallback, useEffect, useState } from "react";
import type { EstadoHistorico, UsuarioSessao } from "../componentes/tipos";

/**
 * Histórico de conversas e sessão do usuário.
 *
 * Quando a persistência não está disponível (banco não migrado ou sem sessão),
 * o hook devolve o motivo real — a interface avisa em vez de fingir uma lista
 * vazia. O chat continua funcionando em memória.
 */
export function useConversas() {
  const [historico, setHistorico] = useState<EstadoHistorico>({
    disponivel: true,
    dados: [],
  });
  const [sessao, setSessao] = useState<UsuarioSessao | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [conversaAtivaId, setConversaAtivaId] = useState<string | null>(null);

  const carregarHistorico = useCallback(async () => {
    try {
      const resposta = await fetch("/api/conversas", { cache: "no-store" });
      setHistorico((await resposta.json()) as EstadoHistorico);
    } catch (e) {
      setHistorico({
        disponivel: false,
        motivo: "erro",
        detalhe: e instanceof Error ? e.message : "Falha de rede.",
      });
    } finally {
      setCarregando(false);
    }
  }, []);

  // Carga inicial. A guarda de desmontagem evita atualizar estado depois que o
  // componente saiu — e mantém o efeito sem setState síncrono.
  useEffect(() => {
    let ativo = true;

    async function carregarTudo() {
      const [respostaHistorico, respostaSessao] = await Promise.allSettled([
        fetch("/api/conversas", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/usuario", { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (!ativo) return;

      if (respostaHistorico.status === "fulfilled") {
        setHistorico(respostaHistorico.value as EstadoHistorico);
      } else {
        setHistorico({
          disponivel: false,
          motivo: "erro",
          detalhe: "Falha de rede ao carregar o histórico.",
        });
      }

      if (respostaSessao.status === "fulfilled") {
        setSessao(respostaSessao.value as UsuarioSessao);
      } else {
        setSessao({ autenticado: false, detalhe: "Não foi possível verificar a sessão." });
      }

      setCarregando(false);
    }

    carregarTudo();
    return () => {
      ativo = false;
    };
  }, []);

  const renomear = useCallback(
    async (id: string, titulo: string) => {
      // Otimista: o título muda na hora; se falhar, o reload corrige.
      setHistorico((atual) =>
        atual.disponivel
          ? { ...atual, dados: atual.dados.map((c) => (c.id === id ? { ...c, titulo } : c)) }
          : atual
      );
      await fetch(`/api/conversas/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ titulo }),
      }).catch(() => {});
      carregarHistorico();
    },
    [carregarHistorico]
  );

  const arquivar = useCallback(
    async (id: string) => {
      setHistorico((atual) =>
        atual.disponivel
          ? { ...atual, dados: atual.dados.filter((c) => c.id !== id) }
          : atual
      );
      if (conversaAtivaId === id) setConversaAtivaId(null);
      await fetch(`/api/conversas/${id}`, { method: "DELETE" }).catch(() => {});
      carregarHistorico();
    },
    [carregarHistorico, conversaAtivaId]
  );

  return {
    historico,
    sessao,
    carregando,
    conversaAtivaId,
    setConversaAtivaId,
    carregarHistorico,
    renomear,
    arquivar,
  };
}
