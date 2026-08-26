"use client";

import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { CartaoArquivo } from "./CartaoArquivo";
import { IconeLogo, IconeCopiar, IconeCheck, IconeAlerta, IconeArquivo } from "./icones";
import { formatarHora, formatarTamanho, type Mensagem } from "./tipos";

type Props = {
  mensagens: Mensagem[];
  textoStreaming: string;
  status: string | null;
  erro: string | null;
  onTentarNovamente: () => void;
};

export function Mensagens({
  mensagens,
  textoStreaming,
  status,
  erro,
  onTentarNovamente,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fimRef = useRef<HTMLDivElement>(null);
  // Enquanto o usuário estiver lendo mensagens antigas, não puxamos o scroll.
  const [seguirFim, setSeguirFim] = useState(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const aoRolar = () => {
      const distanciaDoFim = el.scrollHeight - el.scrollTop - el.clientHeight;
      setSeguirFim(distanciaDoFim < 80);
    };
    el.addEventListener("scroll", aoRolar, { passive: true });
    return () => el.removeEventListener("scroll", aoRolar);
  }, []);

  useEffect(() => {
    if (seguirFim) fimRef.current?.scrollIntoView({ block: "end" });
  }, [mensagens, textoStreaming, status, seguirFim]);

  const vazio = mensagens.length === 0 && !textoStreaming && !status;

  return (
    <div
      ref={containerRef}
      className="rolagem-suave flex-1 overflow-y-auto bg-fundo-conversa px-4 py-6 md:px-8"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        {vazio && <EstadoVazio />}

        {mensagens.map((m, i) => (
          <BlocoMensagem key={m.id ?? i} mensagem={m} onTentarNovamente={onTentarNovamente} />
        ))}

        {textoStreaming && (
          <BlocoMensagem
            mensagem={{ papel: "agente", conteudo: textoStreaming }}
            onTentarNovamente={onTentarNovamente}
            streaming
          />
        )}

        {status && <IndicadorStatus texto={status} />}

        {erro && <BlocoErro texto={erro} onTentarNovamente={onTentarNovamente} />}

        <div ref={fimRef} />
      </div>
    </div>
  );
}

function EstadoVazio() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <span className="mb-4 text-azul">
        <IconeLogo className="h-12 w-12" />
      </span>
      <h2 className="text-lg font-semibold text-texto">Agente Operacional da Effective</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-texto-suave">
        Consulte dados das empresas, envie planilhas, PDFs ou extratos para
        organizar e armazenar, e acompanhe o que foi registrado.
      </p>
    </div>
  );
}

function IndicadorStatus({ texto }: { texto: string }) {
  return (
    <div className="flex items-center gap-3" role="status" aria-live="polite">
      <Avatar />
      <span className="flex items-center gap-2 text-sm text-texto-suave">
        <span className="flex gap-1" aria-hidden>
          {[0, 150, 300].map((atraso) => (
            <span
              key={atraso}
              className="h-1.5 w-1.5 animate-bounce rounded-full bg-texto-fraco"
              style={{ animationDelay: `${atraso}ms` }}
            />
          ))}
        </span>
        {texto}
      </span>
    </div>
  );
}

function BlocoErro({
  texto,
  onTentarNovamente,
}: {
  texto: string;
  onTentarNovamente: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-vermelho/25 bg-vermelho-suave px-4 py-3"
    >
      <span className="mt-0.5 text-vermelho">
        <IconeAlerta />
      </span>
      <div className="flex-1">
        <p className="text-sm font-medium text-vermelho">Não foi possível concluir</p>
        <p className="mt-0.5 text-sm text-texto-suave">{texto}</p>
      </div>
      <button
        onClick={onTentarNovamente}
        className="shrink-0 rounded-lg border border-vermelho/30 px-3 py-1.5 text-sm font-medium text-vermelho transition-colors hover:bg-vermelho/10"
      >
        Tentar de novo
      </button>
    </div>
  );
}

function Avatar() {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-lateral-fundo text-azul">
      <IconeLogo className="h-5 w-5" />
    </span>
  );
}

function BlocoMensagem({
  mensagem,
  onTentarNovamente,
  streaming = false,
}: {
  mensagem: Mensagem;
  onTentarNovamente: () => void;
  streaming?: boolean;
}) {
  const ehUsuario = mensagem.papel === "usuario";
  const texto = ehUsuario ? (mensagem.textoExibido ?? mensagem.conteudo) : mensagem.conteudo;

  if (ehUsuario) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {mensagem.anexos?.map((anexo) => (
          <ChipAnexoEnviado key={anexo.nome} nome={anexo.nome} extensao={anexo.extensao} tamanho={anexo.tamanhoBytes} />
        ))}
        {texto && (
          <div className="max-w-[85%] rounded-2xl bg-azul-suave px-4 py-3 md:max-w-[75%]">
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-texto">{texto}</p>
            <p className="mt-1 text-right text-xs text-texto-fraco">
              {formatarHora(mensagem.criadaEm)}
            </p>
          </div>
        )}
        {mensagem.falhou && (
          <button
            onClick={onTentarNovamente}
            className="text-xs font-medium text-vermelho hover:underline"
          >
            Falhou ao enviar — tentar de novo
          </button>
        )}
      </div>
    );
  }

  if (!texto && !mensagem.cartoes?.length) return null;

  return (
    <div className="flex items-start gap-3">
      <Avatar />
      <div className="min-w-0 flex-1">
        <div className="rounded-2xl border border-borda bg-fundo-cartao px-4 py-3.5">
          {texto && <Markdown>{texto}</Markdown>}

          {mensagem.cartoes?.map((cartao, i) => (
            <div key={i} className="mt-3">
              <CartaoArquivo dados={cartao} />
            </div>
          ))}

          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-xs text-texto-fraco">{formatarHora(mensagem.criadaEm)}</span>
            {!streaming && texto && <BotaoCopiar texto={texto} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChipAnexoEnviado({
  nome,
  extensao,
  tamanho,
}: {
  nome: string;
  extensao: string;
  tamanho: number;
}) {
  return (
    <div className="flex max-w-[85%] items-center gap-2.5 rounded-xl border border-borda bg-fundo-cartao px-3 py-2">
      <IconeArquivo extensao={extensao} className="h-6 w-6" />
      <div className="min-w-0">
        <p className="truncate text-sm text-texto">{nome}</p>
        <p className="text-xs text-texto-suave">{formatarTamanho(tamanho)}</p>
      </div>
    </div>
  );
}

function BotaoCopiar({ texto }: { texto: string }) {
  const [copiado, setCopiado] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    } catch {
      // Clipboard indisponível (contexto não seguro) — silencioso de propósito.
    }
  }

  return (
    <button
      onClick={copiar}
      className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-texto-suave transition-colors hover:bg-fundo-sutil hover:text-texto"
      aria-label="Copiar resposta"
    >
      {copiado ? <IconeCheck className="h-3.5 w-3.5" /> : <IconeCopiar className="h-3.5 w-3.5" />}
      {copiado ? "Copiado" : "Copiar"}
    </button>
  );
}
