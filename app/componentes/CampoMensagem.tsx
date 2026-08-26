"use client";

import { useEffect, useRef, useState } from "react";
import { IconeClipe, IconeEnviar, IconeParar, IconeFechar, IconeArquivo } from "./icones";
import { formatarTamanho, type Anexo } from "./tipos";

const EXTENSOES_ACEITAS = ".csv,.xlsx,.xls,.pdf,.txt";
const MAX_LINHAS = 8;

export type AnexoPendente = Anexo & { blocoParaModelo: string };

type Props = {
  valor: string;
  onMudarValor: (v: string) => void;
  anexos: AnexoPendente[];
  enviandoArquivo: boolean;
  erroArquivo: string | null;
  streamando: boolean;
  onEnviar: () => void;
  onParar: () => void;
  onAnexar: (arquivos: File[]) => void;
  onRemoverAnexo: (nome: string) => void;
};

export function CampoMensagem({
  valor,
  onMudarValor,
  anexos,
  enviandoArquivo,
  erroArquivo,
  streamando,
  onEnviar,
  onParar,
  onAnexar,
  onRemoverAnexo,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputArquivoRef = useRef<HTMLInputElement>(null);
  const [arrastando, setArrastando] = useState(false);

  // Auto-resize: cresce até MAX_LINHAS e depois rola internamente.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const estilo = getComputedStyle(el);
    const alturaLinha = parseFloat(estilo.lineHeight) || 24;
    const paddings = parseFloat(estilo.paddingTop) + parseFloat(estilo.paddingBottom);
    const alturaMaxima = alturaLinha * MAX_LINHAS + paddings;
    el.style.height = `${Math.min(el.scrollHeight, alturaMaxima)}px`;
    el.style.overflowY = el.scrollHeight > alturaMaxima ? "auto" : "hidden";
  }, [valor]);

  const podeEnviar = (valor.trim().length > 0 || anexos.length > 0) && !streamando && !enviandoArquivo;

  function aoTeclar(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter envia; Shift+Enter quebra linha.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (podeEnviar) onEnviar();
    }
  }

  function aoSoltar(e: React.DragEvent) {
    e.preventDefault();
    setArrastando(false);
    if (streamando) return;
    const arquivos = Array.from(e.dataTransfer.files);
    if (arquivos.length > 0) onAnexar(arquivos);
  }

  return (
    <div className="border-t border-borda bg-fundo-app px-4 pb-4 pt-3 md:px-8 md:pb-6">
      <div className="mx-auto w-full max-w-4xl">
        {(anexos.length > 0 || enviandoArquivo || erroArquivo) && (
          <div className="mb-2 space-y-1.5">
            {anexos.map((anexo) => (
              <ChipAnexo key={anexo.nome} anexo={anexo} onRemover={() => onRemoverAnexo(anexo.nome)} />
            ))}
            {enviandoArquivo && (
              <div className="flex items-center gap-2.5 rounded-xl border border-borda px-3 py-2.5 text-sm text-texto-suave">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-texto-fraco border-t-transparent" />
                Processando arquivo…
              </div>
            )}
            {erroArquivo && (
              <div
                role="alert"
                className="rounded-xl border border-vermelho/25 bg-vermelho-suave px-3 py-2.5 text-sm text-vermelho"
              >
                {erroArquivo}
              </div>
            )}
          </div>
        )}

        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!streamando) setArrastando(true);
          }}
          onDragLeave={() => setArrastando(false)}
          onDrop={aoSoltar}
          className={`flex items-end gap-2 rounded-2xl border bg-fundo-cartao px-3 py-2.5 transition-colors ${
            arrastando ? "border-azul bg-azul-suave" : "border-borda"
          }`}
        >
          <input
            ref={inputArquivoRef}
            type="file"
            multiple
            accept={EXTENSOES_ACEITAS}
            className="hidden"
            onChange={(e) => {
              const arquivos = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (arquivos.length > 0) onAnexar(arquivos);
            }}
          />

          <button
            onClick={() => inputArquivoRef.current?.click()}
            disabled={streamando || enviandoArquivo}
            className="rounded-lg p-2 text-texto-suave transition-colors hover:bg-fundo-sutil hover:text-texto disabled:opacity-40"
            aria-label="Anexar planilha, PDF ou texto"
            title="Anexar planilha, PDF ou texto"
          >
            <IconeClipe />
          </button>

          <textarea
            ref={textareaRef}
            rows={1}
            value={valor}
            onChange={(e) => onMudarValor(e.target.value)}
            onKeyDown={aoTeclar}
            placeholder={
              arrastando ? "Solte o arquivo aqui…" : "Digite sua mensagem..."
            }
            aria-label="Mensagem"
            className="flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 text-texto placeholder:text-texto-fraco focus:outline-none"
          />

          {streamando ? (
            <button
              onClick={onParar}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-borda text-texto-suave transition-colors hover:bg-fundo-sutil"
              aria-label="Parar resposta"
              title="Parar resposta"
            >
              <IconeParar />
            </button>
          ) : (
            <button
              onClick={onEnviar}
              disabled={!podeEnviar}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-azul text-white transition-colors hover:bg-azul-hover disabled:cursor-not-allowed disabled:opacity-35"
              aria-label="Enviar mensagem"
            >
              <IconeEnviar />
            </button>
          )}
        </div>

        <p className="mt-2 text-center text-xs text-texto-fraco">
          Enter envia · Shift+Enter quebra linha
        </p>
      </div>
    </div>
  );
}

function ChipAnexo({ anexo, onRemover }: { anexo: AnexoPendente; onRemover: () => void }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-borda bg-fundo-cartao px-3 py-2.5">
      <IconeArquivo extensao={anexo.extensao} className="h-7 w-7" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-texto">{anexo.nome}</p>
        <p className="truncate text-xs text-texto-suave">
          {formatarTamanho(anexo.tamanhoBytes)} · {anexo.resumo}
        </p>
      </div>
      <button
        onClick={onRemover}
        className="rounded-lg p-1.5 text-texto-suave transition-colors hover:bg-fundo-sutil hover:text-texto"
        aria-label={`Remover ${anexo.nome}`}
      >
        <IconeFechar />
      </button>
    </div>
  );
}
