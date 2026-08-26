"use client";

import { useState } from "react";
import { BarraLateral } from "./componentes/BarraLateral";
import { CabecalhoChat } from "./componentes/CabecalhoChat";
import { Mensagens } from "./componentes/Mensagens";
import { CampoMensagem, type AnexoPendente } from "./componentes/CampoMensagem";
import { IconeMenu } from "./componentes/icones";
import { useSaude } from "./hooks/useSaude";
import { useConversas } from "./hooks/useConversas";
import { useChat } from "./hooks/useChat";

export default function Pagina() {
  const [barraAberta, setBarraAberta] = useState(false);
  const [barraRecolhida, setBarraRecolhida] = useState(false);
  const [entrada, setEntrada] = useState("");

  const [anexos, setAnexos] = useState<AnexoPendente[]>([]);
  const [enviandoArquivo, setEnviandoArquivo] = useState(false);
  const [erroArquivo, setErroArquivo] = useState<string | null>(null);

  const { itens: saude, carregando: carregandoSaude } = useSaude();
  const {
    historico,
    sessao,
    carregando: carregandoHistorico,
    conversaAtivaId,
    setConversaAtivaId,
    renomear,
    arquivar,
  } = useConversas();
  const chat = useChat();

  async function anexarArquivos(arquivos: File[]) {
    setErroArquivo(null);
    setEnviandoArquivo(true);
    try {
      const resultados = await Promise.all(
        arquivos.map(async (arquivo) => {
          try {
            const form = new FormData();
            form.append("arquivo", arquivo);
            const resposta = await fetch("/api/upload", { method: "POST", body: form });
            const dados = await resposta.json();
            if (!resposta.ok) {
              return { erro: `${arquivo.name}: ${dados?.erro ?? "erro ao processar"}` };
            }
            return {
              nome: dados.nome as string,
              resumo: dados.resumo as string,
              blocoParaModelo: dados.blocoParaModelo as string,
              extensao: arquivo.name.split(".").pop()?.toLowerCase() ?? "",
              tamanhoBytes: arquivo.size,
            } satisfies AnexoPendente;
          } catch {
            return { erro: `${arquivo.name}: falha de rede` };
          }
        })
      );

      const novos = resultados.filter((r): r is AnexoPendente => !("erro" in r));
      const erros = resultados.filter((r): r is { erro: string } => "erro" in r);

      if (novos.length) setAnexos((prev) => [...prev, ...novos]);
      if (erros.length) setErroArquivo(erros.map((e) => e.erro).join(" · "));
    } finally {
      setEnviandoArquivo(false);
    }
  }

  async function enviar() {
    const texto = entrada;
    const paraEnviar = anexos;
    setEntrada("");
    setAnexos([]);
    setErroArquivo(null);
    await chat.enviar(texto, paraEnviar);
  }

  function novoChat() {
    chat.limpar();
    setEntrada("");
    setAnexos([]);
    setErroArquivo(null);
    setConversaAtivaId(null);
    setBarraAberta(false);
  }

  function selecionarConversa(id: string) {
    setConversaAtivaId(id);
    setBarraAberta(false);
    // O carregamento das mensagens depende das tabelas migradas; enquanto isso
    // a seleção apenas destaca a conversa.
  }

  const tituloAtual =
    (historico.disponivel && historico.dados.find((c) => c.id === conversaAtivaId)?.titulo) ||
    "Agente Operacional";

  return (
    <div className="flex h-dvh overflow-hidden">
      {!barraRecolhida && (
        <BarraLateral
          historico={historico}
          carregando={carregandoHistorico}
          conversaAtivaId={conversaAtivaId}
          sessao={sessao}
          aberta={barraAberta}
          onFechar={() => setBarraAberta(false)}
          onRecolher={() => setBarraRecolhida(true)}
          onNovoChat={novoChat}
          onSelecionar={selecionarConversa}
          onRenomear={renomear}
          onArquivar={arquivar}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        {barraRecolhida && (
          <button
            onClick={() => setBarraRecolhida(false)}
            className="absolute left-3 top-3 z-10 hidden rounded-lg border border-borda bg-fundo-app p-2 text-texto-suave hover:bg-fundo-sutil md:block"
            aria-label="Mostrar barra lateral"
          >
            <IconeMenu className="h-4 w-4 rotate-90" />
          </button>
        )}

        <CabecalhoChat
          titulo={tituloAtual}
          saude={saude}
          carregandoSaude={carregandoSaude}
          onAbrirMenu={() => setBarraAberta(true)}
        />

        <Mensagens
          mensagens={chat.mensagens}
          textoStreaming={chat.textoStreaming}
          status={chat.status}
          erro={chat.erro}
          onTentarNovamente={chat.tentarNovamente}
        />

        <CampoMensagem
          valor={entrada}
          onMudarValor={setEntrada}
          anexos={anexos}
          enviandoArquivo={enviandoArquivo}
          erroArquivo={erroArquivo}
          streamando={chat.streamando}
          onEnviar={enviar}
          onParar={chat.parar}
          onAnexar={anexarArquivos}
          onRemoverAnexo={(nome) => setAnexos((prev) => prev.filter((a) => a.nome !== nome))}
        />
      </main>
    </div>
  );
}
