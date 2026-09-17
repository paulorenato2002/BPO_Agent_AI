"use client";

import { useRef, useState } from "react";
import { BarraLateral } from "./componentes/BarraLateral";
import { CabecalhoChat } from "./componentes/CabecalhoChat";
import { Mensagens } from "./componentes/Mensagens";
import { CampoMensagem, type AnexoPendente } from "./componentes/CampoMensagem";
import { IconeMenu } from "./componentes/icones";
import { useSaude } from "./hooks/useSaude";
import { useConversas } from "./hooks/useConversas";
import { useChat } from "./hooks/useChat";
import { Arquivamentos } from "./componentes/Arquivamentos";

export default function Pagina() {
  const [barraAberta, setBarraAberta] = useState(false);
  const [barraRecolhida, setBarraRecolhida] = useState(false);
  const [entrada, setEntrada] = useState("");

  const [anexos, setAnexos] = useState<AnexoPendente[]>([]);
  const [enviandoArquivo, setEnviandoArquivo] = useState(false);
  const [erroArquivo, setErroArquivo] = useState<string | null>(null);
  // Entre o clique e o início da resposta há chamadas ao servidor (criar a
  // conversa). Sem esta trava, Enter duas vezes enviava a mesma mensagem duas vezes.
  const [preparando, setPreparando] = useState(false);
  const ocupadoRef = useRef(false);

  const { itens: saude, carregando: carregandoSaude } = useSaude();
  const conversas = useConversas();
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

  /**
   * Toda mensagem precisa de uma conversa REAL para ser persistida. Se ainda
   * não há uma ativa, cria antes de enviar — e aborta se o limite estiver cheio,
   * em vez de mandar a mensagem para o vazio.
   */
  async function enviar() {
    if (ocupadoRef.current || chat.streamando) return;
    const texto = entrada;
    const paraEnviar = anexos;
    if (!texto.trim() && paraEnviar.length === 0) return;

    ocupadoRef.current = true;
    setPreparando(true);
    try {
      let id = conversas.conversaAtivaId;
      if (!id) {
        id = await conversas.criarConversa();
        if (!id) return; // limite atingido: o erro já está na barra lateral
      }
      chat.definirConversa(id, (titulo) => conversas.aplicarTitulo(id!, titulo));

      setEntrada("");
      setAnexos([]);
      setErroArquivo(null);

      const envio = chat.enviar(texto, paraEnviar);
      // Na tela, quem trava o campo agora é o streaming (com o botão de parar);
      // a trava interna só sai quando a resposta termina.
      setPreparando(false);
      await envio;
      await conversas.carregar();
    } finally {
      ocupadoRef.current = false;
      setPreparando(false);
    }
  }

  async function novoChat() {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setBarraAberta(false);
    try {
      const id = await conversas.criarConversa();
      if (!id) return; // limite atingido
      setEntrada("");
      setAnexos([]);
      setErroArquivo(null);
      chat.limpar();
      chat.definirConversa(id, (titulo) => conversas.aplicarTitulo(id, titulo));
    } finally {
      ocupadoRef.current = false;
    }
  }

  async function selecionarConversa(id: string) {
    setBarraAberta(false);
    if (id === conversas.conversaAtivaId && !chat.streamando) return;
    conversas.setConversaAtivaId(id);
    setAnexos([]);
    setErroArquivo(null);
    chat.definirConversa(id, (titulo) => conversas.aplicarTitulo(id, titulo));
    await chat.carregarConversa(id);
  }

  const tituloAtual =
    (conversas.estado.carregando === false &&
      conversas.estado.ok &&
      conversas.estado.conversas.find((c) => c.id === conversas.conversaAtivaId)?.titulo) ||
    "Agente Operacional";

  return (
    <div className="flex h-dvh overflow-hidden">
      {!barraRecolhida && (
        <BarraLateral
          estado={conversas.estado}
          conversaAtivaId={conversas.conversaAtivaId}
          sessao={conversas.sessao}
          erroAcao={conversas.erroAcao}
          aberta={barraAberta}
          onFechar={() => setBarraAberta(false)}
          onRecolher={() => setBarraRecolhida(true)}
          onNovoChat={novoChat}
          onSelecionar={selecionarConversa}
          onRenomear={conversas.renomear}
          onArquivar={conversas.arquivar}
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
          carregando={chat.carregandoConversa}
          mensagens={chat.mensagens}
          textoStreaming={chat.textoStreaming}
          status={chat.status}
          erro={chat.erro}
          onTentarNovamente={chat.tentarNovamente}
        />

        {conversas.conversaAtivaId && (
          <Arquivamentos
            key={conversas.conversaAtivaId}
            conversaId={conversas.conversaAtivaId}
            sinal={chat.streamando ? -1 : chat.mensagens.length}
          />
        )}

        <CampoMensagem
          valor={entrada}
          onMudarValor={setEntrada}
          anexos={anexos}
          enviandoArquivo={enviandoArquivo}
          erroArquivo={erroArquivo}
          streamando={chat.streamando || preparando}
          onEnviar={enviar}
          onParar={chat.parar}
          onAnexar={anexarArquivos}
          onRemoverAnexo={(nome) => setAnexos((prev) => prev.filter((a) => a.nome !== nome))}
        />
      </main>
    </div>
  );
}
