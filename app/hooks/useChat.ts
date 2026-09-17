"use client";

import { useCallback, useRef, useState } from "react";
import type { Mensagem } from "../componentes/tipos";
import type { AnexoPendente } from "../componentes/CampoMensagem";
import { TEXTO_PADRAO_ANEXOS } from "../componentes/anexos-mensagem";

type EventoStream =
  | { type: "titulo"; titulo: string }
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "done"; messages: Mensagem[] }
  | { type: "error"; message: string };

/** Tradução entre a nomenclatura da UI e a da OpenAI, nos dois sentidos. */
const ROLE_POR_PAPEL: Record<Mensagem["papel"], string> = {
  usuario: "user",
  agente: "assistant",
  sistema: "system",
  ferramenta: "tool",
};

/**
 * Conversa com o agente: streaming, anexos e tratamento de erro.
 *
 * O que vai para o MODELO (`conteudo`) e o que aparece na TELA (`textoExibido`,
 * `anexos`) são campos distintos de propósito — o bloco de dados do arquivo
 * nunca é exibido ao usuário.
 */
export function useChat() {
  const [mensagens, setMensagens] = useState<Mensagem[]>([]);
  const [textoStreaming, setTextoStreaming] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [streamando, setStreamando] = useState(false);
  const [carregandoConversa, setCarregandoConversa] = useState(false);

  // Conversa em que as mensagens serão persistidas. Guardado em ref para o
  // stream em andamento não usar um valor defasado.
  const conversaIdRef = useRef<string | null>(null);
  const aoTituloRef = useRef<((titulo: string) => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Guarda a última tentativa para o botão "tentar de novo".
  const ultimoEnvioRef = useRef<Mensagem[] | null>(null);
  // Cada geração tem um número. Trocar de conversa ou limpar invalida a geração
  // em andamento: o que ela ainda receber não cai na conversa nova.
  const geracaoRef = useRef(0);
  // O texto chega em pedaços; a tela é atualizada no máximo uma vez por quadro.
  const textoRef = useRef("");
  const quadroRef = useRef<number | null>(null);

  const cancelarQuadro = () => {
    if (quadroRef.current !== null) cancelAnimationFrame(quadroRef.current);
    quadroRef.current = null;
  };

  const parar = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreamando(false);
    setStatus(null);
  }, []);

  /** Parar e esquecer: nada da geração atual aparece depois disto. */
  const descartar = useCallback(() => {
    geracaoRef.current += 1;
    cancelarQuadro();
    textoRef.current = "";
    parar();
    setTextoStreaming("");
  }, [parar]);

  const limpar = useCallback(() => {
    descartar();
    setCarregandoConversa(false);
    setMensagens([]);
    setErro(null);
    ultimoEnvioRef.current = null;
  }, [descartar]);

  const executar = useCallback(async (historia: Mensagem[]) => {
    // Uma geração por vez: a anterior (se houver) é descartada.
    abortRef.current?.abort();
    const geracao = ++geracaoRef.current;
    const atual = () => geracao === geracaoRef.current;

    ultimoEnvioRef.current = historia;
    cancelarQuadro();
    textoRef.current = "";
    setMensagens(historia);
    setErro(null);
    setTextoStreaming("");
    setStatus("Pensando...");
    setStreamando(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const mostrarTexto = () => {
      quadroRef.current = null;
      if (atual()) setTextoStreaming(textoRef.current);
    };

    try {
      // Só os campos que o backend/OpenAI entendem; o resto é exibição local.
      const paraEnviar = historia.map(({ papel, conteudo, tool_calls, tool_call_id }) => ({
        role: ROLE_POR_PAPEL[papel] ?? "user",
        content: conteudo,
        tool_calls,
        tool_call_id,
      }));

      const resposta = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: paraEnviar, conversaId: conversaIdRef.current }),
        signal: controller.signal,
      });

      if (!resposta.ok || !resposta.body) {
        throw new Error(`O agente respondeu com erro (HTTP ${resposta.status}).`);
      }

      const leitor = resposta.body.getReader();
      const decodificador = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await leitor.read();
        if (done) break;
        if (!atual()) break;
        buffer += decodificador.decode(value, { stream: true });

        const linhas = buffer.split("\n");
        buffer = linhas.pop() ?? "";

        for (const linha of linhas) {
          if (!linha.trim()) continue;
          let evento: EventoStream;
          try {
            evento = JSON.parse(linha) as EventoStream;
          } catch {
            continue; // linha corrompida não derruba a resposta inteira
          }

          if (evento.type === "titulo") {
            aoTituloRef.current?.(evento.titulo);
          } else if (evento.type === "status") {
            setStatus(evento.text);
          } else if (evento.type === "delta") {
            if (textoRef.current === "") setStatus(null);
            textoRef.current += evento.text;
            quadroRef.current ??= requestAnimationFrame(mostrarTexto);
          } else if (evento.type === "done") {
            cancelarQuadro();
            textoRef.current = "";
            setMensagens((atual) => mesclar(atual, evento.messages));
            setTextoStreaming("");
            setStatus(null);
          } else if (evento.type === "error") {
            setErro(evento.message);
            setStatus(null);
          }
        }
      }
    } catch (e) {
      if (!atual()) return;
      // Abortar é ação do usuário, não erro: o que já chegou fica na conversa.
      if (e instanceof DOMException && e.name === "AbortError") {
        const parcial = textoRef.current;
        if (parcial) {
          setMensagens((anteriores) => [
            ...anteriores,
            { papel: "agente", conteudo: parcial + "\n\n_(interrompido)_" },
          ]);
        }
      } else {
        setErro(
          e instanceof Error ? e.message : "Falha de rede ao falar com o agente."
        );
      }
    } finally {
      if (atual()) {
        cancelarQuadro();
        textoRef.current = "";
        setTextoStreaming("");
        setStreamando(false);
        setStatus(null);
        abortRef.current = null;
      }
    }
  }, []);

  const enviar = useCallback(
    async (texto: string, anexos: AnexoPendente[]) => {
      const limpo = texto.trim();
      if (!limpo && anexos.length === 0) return;

      const conteudoModelo =
        anexos.length > 0
          ? `${anexos.map((a) => a.blocoParaModelo).join("\n\n")}\n\n${
              limpo || TEXTO_PADRAO_ANEXOS
            }`
          : limpo;

      const nova: Mensagem = {
        papel: "usuario",
        conteudo: conteudoModelo,
        textoExibido: limpo || undefined,
        anexos: anexos.length
          ? anexos.map(({ nome, resumo, extensao, tamanhoBytes }) => ({
              nome,
              resumo,
              extensao,
              tamanhoBytes,
            }))
          : undefined,
        criadaEm: new Date().toISOString(),
      };

      await executar([...mensagens, nova]);
    },
    [mensagens, executar]
  );

  const tentarNovamente = useCallback(() => {
    const historia = ultimoEnvioRef.current;
    if (historia) executar(historia);
  }, [executar]);

  /** Define a conversa ativa (persistência) e quem recebe o título gerado. */
  const definirConversa = useCallback(
    (id: string | null, aoTitulo?: (titulo: string) => void) => {
      conversaIdRef.current = id;
      aoTituloRef.current = aoTitulo ?? null;
    },
    []
  );

  /** Carrega o histórico de uma conversa existente. */
  const carregarConversa = useCallback(async (id: string) => {
    descartar();
    const geracao = geracaoRef.current;
    setErro(null);
    setMensagens([]);
    setCarregandoConversa(true);
    try {
      const resposta = await fetch(`/api/conversas/${id}/mensagens`, { cache: "no-store" });
      const dados = await resposta.json();
      // Cliques rápidos em conversas diferentes: só a última resposta vale.
      if (geracao !== geracaoRef.current) return;
      if (!dados.ok) {
        setErro(dados.mensagem ?? "Não foi possível abrir a conversa.");
        setMensagens([]);
        return;
      }
      setMensagens(
        (dados.dados as Array<Record<string, unknown>>)
          .flatMap<Mensagem>((m) => {
            const historico = (m.metadados as { historicoModelo?: MensagemBackend[] } | undefined)?.historicoModelo;
            if (m.papel === "agente" && historico?.length) {
              return historico.map(h => ({ papel: PAPEL_POR_ROLE[h.role ?? "assistant"] ?? "agente",
                conteudo: h.content ?? null, tool_calls: h.tool_calls, tool_call_id: h.tool_call_id,
                criadaEm: m.criadaEm as string }));
            }
            return [{
            id: m.id as string,
            papel: m.papel as Mensagem["papel"],
            conteudo: m.conteudo as string | null,
            criadaEm: m.criadaEm as string,
          }]; })
      );
    } catch {
      if (geracao === geracaoRef.current) setErro("Falha de rede ao abrir a conversa.");
    } finally {
      if (geracao === geracaoRef.current) setCarregandoConversa(false);
    }
  }, [descartar]);

  return {
    mensagens,
    setMensagens,
    definirConversa,
    carregarConversa,
    textoStreaming,
    carregandoConversa,
    status,
    erro,
    streamando,
    enviar,
    parar,
    limpar,
    tentarNovamente,
  };
}

/**
 * O servidor devolve o histórico oficial (com tool_calls/tool). Reaplica por
 * cima os campos que só existem na tela, casando pela ordem das mensagens de
 * usuário.
 */
/** Formato que o backend devolve: nomenclatura da OpenAI. */
type MensagemBackend = {
  role?: string;
  content?: string | null;
  tool_calls?: Mensagem["tool_calls"];
  tool_call_id?: string;
};

const PAPEL_POR_ROLE: Record<string, Mensagem["papel"]> = {
  user: "usuario",
  assistant: "agente",
  system: "sistema",
  tool: "ferramenta",
};

function mesclar(atual: Mensagem[], oficial: Mensagem[]): Mensagem[] {
  const exibicao = atual
    .filter((m) => m.papel === "usuario")
    .map((m) => ({ textoExibido: m.textoExibido, anexos: m.anexos, criadaEm: m.criadaEm }));

  let cursor = 0;
  return oficial
    .map((m) => {
      // O backend fala `role`/`content`; a UI fala `papel`/`conteudo`. Traduzir
      // os DOIS campos — traduzir só o papel faz a mensagem do agente sumir no
      // filtro abaixo, porque `conteudo` fica indefinido.
      const bruta = m as unknown as MensagemBackend;
      const papel = bruta.role ? (PAPEL_POR_ROLE[bruta.role] ?? m.papel) : m.papel;
      const conteudo = bruta.content !== undefined ? bruta.content : m.conteudo;

      const normalizada: Mensagem = { ...m, papel, conteudo };

      if (papel !== "usuario") return normalizada;
      const extra = exibicao[cursor];
      cursor += 1;
      return extra ? { ...normalizada, ...extra } : normalizada;
    })
    .filter((m) => m.papel !== "sistema");
}
