"use client";

import { useEffect, useState } from "react";
import type { ItemSaude } from "../componentes/tipos";

const INTERVALO_MS = 60_000;

/**
 * Health check das integrações, revalidado periodicamente.
 *
 * Se a checagem falhar, marcamos como indisponível em vez de manter o último
 * "conectado" na tela — um status verde velho é pior que nenhum.
 */
export function useSaude() {
  const [itens, setItens] = useState<ItemSaude[] | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    // Guarda de desmontagem: evita atualizar estado de um componente que já saiu.
    let ativo = true;

    async function verificar() {
      // Aba escondida não precisa de status; ao voltar, confere na hora.
      if (document.visibilityState === "hidden") return;
      try {
        const resposta = await fetch("/api/saude", { cache: "no-store" });
        if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
        const dados = (await resposta.json()) as { itens: ItemSaude[] };
        if (ativo) setItens(dados.itens);
      } catch (e) {
        if (ativo) {
          setItens([
            {
              chave: "banco",
              nome: "Supabase",
              estado: "indisponivel",
              detalhe: e instanceof Error ? e.message : "Falha ao verificar.",
            },
          ]);
        }
      } finally {
        if (ativo) setCarregando(false);
      }
    }

    verificar();
    const id = setInterval(verificar, INTERVALO_MS);
    const aoVoltar = () => {
      if (document.visibilityState === "visible") verificar();
    };
    document.addEventListener("visibilitychange", aoVoltar);

    return () => {
      ativo = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", aoVoltar);
    };
  }, []);

  return { itens, carregando };
}
