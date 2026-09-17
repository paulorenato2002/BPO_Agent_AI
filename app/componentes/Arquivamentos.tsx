"use client";

import { useEffect, useState } from "react";

type Item = {
  id: string; nome_original: string;
  status: "pendente" | "processando" | "concluido" | "erro";
  erro: string | null; iniciado_em: string | null;
  resultado: { caminho_relativo?: string; nome_final?: string } | null;
};

// Com arquivo na fila, o status muda em segundos; parado, quase nunca.
const INTERVALO_ATIVO_MS = 2_000;
const INTERVALO_PARADO_MS = 30_000;
const INTERVALO_ERRO_MS = 15_000;

/**
 * Status operacional sem chamar um modelo a cada consulta.
 *
 * `sinal` muda quando o agente termina uma resposta: é quando um arquivamento
 * novo pode ter entrado na fila, então a consulta é feita na hora. Com a aba
 * escondida não há consulta.
 */
export function Arquivamentos({ conversaId, sinal }: { conversaId: string; sinal?: number }) {
  const [itens, setItens] = useState<Item[]>([]);
  const [erro, setErro] = useState(false);
  useEffect(() => {
    let encerrado = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();

    function agendar(ms: number) {
      clearTimeout(timer);
      if (!encerrado) timer = setTimeout(atualizar, ms);
    }

    async function atualizar() {
      if (document.visibilityState === "hidden") return; // retoma ao voltar para a aba
      let intervalo = INTERVALO_PARADO_MS;
      try {
        const resposta = await fetch(`/api/arquivamentos?conversaId=${encodeURIComponent(conversaId)}`, {
          signal: abort.signal, cache: "no-store",
        });
        if (!resposta.ok) throw new Error("Falha ao consultar");
        const dados = await resposta.json() as { itens: Item[] };
        if (!encerrado) { setItens(dados.itens); setErro(false); }
        if (dados.itens.some(i => i.status === "pendente" || i.status === "processando")) intervalo = INTERVALO_ATIVO_MS;
      } catch {
        if (encerrado) return;
        setErro(true);
        intervalo = INTERVALO_ERRO_MS;
      }
      agendar(intervalo);
    }

    const aoVoltar = () => { if (document.visibilityState === "visible") void atualizar(); };
    document.addEventListener("visibilitychange", aoVoltar);
    void atualizar();
    return () => {
      encerrado = true;
      clearTimeout(timer);
      abort.abort();
      document.removeEventListener("visibilitychange", aoVoltar);
    };
  }, [conversaId, sinal]);

  if (!itens.length && !erro) return null;
  return (
    <section aria-label="Arquivamentos" className="mx-auto w-full max-w-3xl px-4 pb-2 text-sm">
      <details open={itens.some(i => i.status === "pendente" || i.status === "processando" || i.status === "erro")}>
        <summary className="cursor-pointer text-texto-suave">Arquivamentos ({itens.length})</summary>
        <div className="max-h-40 overflow-y-auto" aria-live="polite">
          {erro && <p>Não foi possível atualizar o status. Tentando novamente…</p>}
          {itens.map(item => <p key={item.id} className="py-1 break-words">
            <strong>{item.nome_original}</strong>: {item.status === "pendente"
              ? "Aguardando o computador responsável. O pedido continua salvo se ele estiver desligado."
              : item.status === "processando"
                ? "Processando no computador responsável. Arquivos grandes podem demorar um pouco mais."
                : item.status === "erro"
                  ? `Não foi concluído: ${item.erro ?? "confira o worker"}`
                  : `Salvo na pasta: ${item.resultado?.caminho_relativo}/${item.resultado?.nome_final}. A sincronização depende do OneDrive.`}
          </p>)}
        </div>
      </details>
    </section>
  );
}
