"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Painel de arquivamento em lote.
 *
 * A tela é uma revisão, não um formulário. O trabalho pesado — ler o
 * documento, identificar a empresa, escolher a regra, montar o destino — já
 * aconteceu no servidor quando os arquivos subiram. Aqui o humano confere e
 * corrige o que a máquina não teve como saber.
 *
 * A decisão de desenho que manda em tudo: NADA é arquivado sem alguém marcar.
 * Uma linha só fica selecionável quando tem destino calculado. O botão diz
 * quantos arquivos vai mexer. Não existe "arquivar tudo" que passe por cima
 * de um item ambíguo.
 */

type Campo = { valor: string | null; confianca: string; rotulo?: string | null };

type Item = {
  anexoId: string;
  nomeOriginal: string;
  status: "analisado" | "bloqueado" | "incompleto";
  bloqueio: { motivo: string } | null;
  empresa: Campo & { empresaId: string | null };
  competencia: Campo;
  regra: Campo & { nome: string | null };
  tipoDocumento: Campo;
  instituicao: Campo;
  camposFaltantes: string[];
  conflitos: { campo: string; motivo: string }[];
  nomeSugerido: string | null;
  caminhoSugerido: string | null;
  possivelDuplicata: { nome: string; motivo: string } | null;
};

type Proposta = {
  propostaId: string;
  expiraEm: string;
  itens: Item[];
  resumo: { total: number; prontos: number; incompletos: number; bloqueados: number };
};

type Empresa = {
  id: string;
  codigo: string | null;
  razao_social: string | null;
  nome_fantasia: string | null;
  pasta: string | null;
};

type Regra = { codigo: string; nome: string; escopo: string };

type Correcao = {
  empresaId?: string | null;
  competencia?: string | null;
  tipoDocumento?: string | null;
  instituicao?: string | null;
  regraCodigo?: string | null;
};

type Envio = { nome: string; estado: "enviando" | "enviado" | "erro"; erro?: string };

const ROTULO_CONFIANCA: Record<string, { texto: string; classe: string }> = {
  confirmado: { texto: "confirmado", classe: "bg-verde-suave text-verde" },
  provavel: { texto: "provável", classe: "bg-ambar-suave text-ambar" },
  ausente: { texto: "não encontrado", classe: "bg-fundo-sutil text-texto-suave" },
  conflitante: { texto: "conflito", classe: "bg-vermelho-suave text-vermelho" },
};

function Selo({ confianca }: { confianca: string }) {
  const s = ROTULO_CONFIANCA[confianca] ?? ROTULO_CONFIANCA.ausente;
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${s.classe}`}>{s.texto}</span>
  );
}

export function PainelArquivamento() {
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [regras, setRegras] = useState<Regra[]>([]);
  const [mapa, setMapa] = useState<{ pastasConhecidas: number; conferidoEm: string | null } | null>(null);
  const [envios, setEnvios] = useState<Envio[]>([]);
  const [anexoIds, setAnexoIds] = useState<string[]>([]);
  const [conversaId, setConversaId] = useState<string | null>(null);
  const [proposta, setProposta] = useState<Proposta | null>(null);
  const [correcoes, setCorrecoes] = useState<Record<string, Correcao>>({});
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [analisando, setAnalisando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [enfileirados, setEnfileirados] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/painel/opcoes", { cache: "no-store" });
        if (!r.ok) return;
        const d = await r.json();
        setEmpresas(d.empresas ?? []);
        setRegras(d.regras ?? []);
        setMapa(d.mapa ?? null);
      } catch {
        /* o painel funciona sem a lista; a correção fica limitada */
      }
    })();
  }, []);

  const enviarArquivos = useCallback(async (arquivos: FileList | File[]) => {
    const lista = Array.from(arquivos);
    if (!lista.length) return;
    setAviso(null);
    setEnvios((a) => [...a, ...lista.map((f) => ({ nome: f.name, estado: "enviando" as const }))]);

    // Um por vez: a rota de upload recebe um arquivo por requisição, e enviar
    // em série mantém a ordem e evita estourar limite de corpo na Vercel.
    for (const arquivo of lista) {
      const form = new FormData();
      form.append("arquivo", arquivo);
      try {
        const r = await fetch("/api/upload", { method: "POST", body: form });
        const d = await r.json();
        if (!r.ok) throw new Error(d.erro ?? "Falha no envio.");
        setAnexoIds((a) => [...a, d.anexoId]);
        setEnvios((a) =>
          a.map((e) => (e.nome === arquivo.name && e.estado === "enviando" ? { ...e, estado: "enviado" } : e))
        );
      } catch (e) {
        setEnvios((a) =>
          a.map((x) =>
            x.nome === arquivo.name && x.estado === "enviando"
              ? { ...x, estado: "erro", erro: e instanceof Error ? e.message : "Falha no envio." }
              : x
          )
        );
      }
    }
  }, []);

  const analisar = useCallback(async () => {
    if (!anexoIds.length) return;
    setAnalisando(true);
    setAviso(null);
    try {
      const r = await fetch("/api/painel/analisar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anexoIds, correcoes, conversaId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.erro ?? "Falha na análise.");
      setConversaId(d.conversaId);
      setProposta(d.proposta);
      // Pré-marca só o que está pronto. Item incompleto exige uma ação
      // deliberada depois de corrigido.
      setMarcados(
        new Set(
          (d.proposta.itens as Item[])
            .filter((i) => i.status === "analisado" && i.caminhoSugerido)
            .map((i) => i.anexoId)
        )
      );
    } catch (e) {
      setAviso(e instanceof Error ? e.message : "Falha na análise.");
    } finally {
      setAnalisando(false);
    }
  }, [anexoIds, correcoes, conversaId]);

  const confirmar = useCallback(async () => {
    if (!proposta || !marcados.size) return;
    setConfirmando(true);
    setAviso(null);
    try {
      const r = await fetch("/api/painel/confirmar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propostaId: proposta.propostaId,
          anexoIds: [...marcados],
          conversaId,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.erro ?? "Falha ao confirmar.");
      setEnfileirados((d.itens ?? []).map((i: { nome_original: string }) => i.nome_original));
      setProposta(null);
      setAnexoIds([]);
      setEnvios([]);
      setMarcados(new Set());
      setCorrecoes({});
    } catch (e) {
      setAviso(e instanceof Error ? e.message : "Falha ao confirmar.");
    } finally {
      setConfirmando(false);
    }
  }, [proposta, marcados, conversaId]);

  function corrigir(anexoId: string, campo: keyof Correcao, valor: string) {
    setCorrecoes((c) => ({ ...c, [anexoId]: { ...c[anexoId], [campo]: valor || null } }));
  }

  const prontos = proposta?.itens.filter((i) => i.caminhoSugerido) ?? [];
  const pendentes = proposta?.itens.filter((i) => !i.caminhoSugerido) ?? [];

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <header className="mb-6">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-xl font-semibold text-texto">Arquivamento em lote</h1>
          <Link href="/" className="text-sm text-azul hover:underline">
            voltar ao chat
          </Link>
        </div>
        <p className="mt-1 text-sm text-texto-suave">
          Solte os documentos, confira o destino de cada um e arquive. O arquivo original
          não é movido — é copiado para a pasta do cliente.
        </p>
      </header>

      {mapa && mapa.pastasConhecidas === 0 && (
        <p className="mb-4 rounded-[--raio] bg-ambar-suave px-4 py-3 text-sm text-ambar">
          Nenhuma pasta de cliente mapeada ainda. O computador responsável precisa estar
          ligado com o worker aberto — ele confere as pastas sozinho a cada 15 minutos.
          Até lá, os documentos não terão destino calculado.
        </p>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 1. Envio                                                          */}
      {/* ---------------------------------------------------------------- */}
      <section
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void enviarArquivos(e.dataTransfer.files);
        }}
        className="rounded-[--raio] border-2 border-dashed border-borda-forte bg-fundo-cartao p-8 text-center"
      >
        <p className="text-sm text-texto-suave">
          Arraste os arquivos aqui, ou{" "}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="font-medium text-azul hover:underline"
          >
            escolha do computador
          </button>
          .
        </p>
        <p className="mt-1 text-xs text-texto-fraco">PDF, XLSX, XLS, CSV, TXT e OFX.</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void enviarArquivos(e.target.files);
            e.target.value = "";
          }}
        />
      </section>

      {envios.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {envios.map((e, i) => (
            <li key={`${e.nome}-${i}`} className="flex items-center gap-2">
              <span
                className={
                  e.estado === "enviado"
                    ? "text-verde"
                    : e.estado === "erro"
                      ? "text-vermelho"
                      : "text-texto-fraco"
                }
              >
                {e.estado === "enviado" ? "✓" : e.estado === "erro" ? "✗" : "…"}
              </span>
              <span className="text-texto">{e.nome}</span>
              {e.erro && <span className="text-texto-suave">— {e.erro}</span>}
            </li>
          ))}
        </ul>
      )}

      {anexoIds.length > 0 && !proposta && (
        <button
          type="button"
          onClick={() => void analisar()}
          disabled={analisando}
          className="mt-4 rounded-[--raio] bg-azul px-4 py-2 text-sm font-medium text-white hover:bg-azul-hover disabled:opacity-50"
        >
          {analisando
            ? "Lendo os documentos…"
            : `Analisar ${anexoIds.length} arquivo${anexoIds.length > 1 ? "s" : ""}`}
        </button>
      )}

      {aviso && (
        <p className="mt-4 rounded-[--raio] bg-vermelho-suave px-4 py-3 text-sm text-vermelho">
          {aviso}
        </p>
      )}

      {enfileirados.length > 0 && (
        <div className="mt-4 rounded-[--raio] bg-verde-suave px-4 py-3 text-sm text-verde">
          <p className="font-medium">
            {enfileirados.length} arquivo{enfileirados.length > 1 ? "s" : ""} na fila do
            computador responsável.
          </p>
          <p className="mt-1">
            A confirmação aqui significa pedido registrado. O arquivo aparece na pasta
            quando o worker o processa, e a sincronização com a nuvem fica com o OneDrive.
          </p>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* 2. Revisão                                                        */}
      {/* ---------------------------------------------------------------- */}
      {proposta && (
        <section className="mt-8">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-base font-semibold text-texto">
              Revisão — {proposta.resumo.total} arquivo
              {proposta.resumo.total > 1 ? "s" : ""}
            </h2>
            <span className="text-sm text-texto-suave">
              {prontos.length} com destino · {pendentes.length} precisam de você
            </span>
          </div>

          <div className="overflow-x-auto rounded-[--raio] border border-borda">
            <table className="w-full min-w-[64rem] border-collapse text-sm">
              <thead className="bg-fundo-sutil text-left text-xs uppercase tracking-wide text-texto-suave">
                <tr>
                  <th className="w-10 px-3 py-2"></th>
                  <th className="px-3 py-2">Arquivo</th>
                  <th className="px-3 py-2">Empresa</th>
                  <th className="px-3 py-2">Competência</th>
                  <th className="px-3 py-2">Tipo</th>
                  <th className="px-3 py-2">Instituição</th>
                  <th className="px-3 py-2">Destino</th>
                </tr>
              </thead>
              <tbody>
                {proposta.itens.map((item) => {
                  const pronto = Boolean(item.caminhoSugerido);
                  const c = correcoes[item.anexoId] ?? {};
                  return (
                    <tr
                      key={item.anexoId}
                      className={`border-t border-borda align-top ${pronto ? "" : "bg-ambar-suave/30"}`}
                    >
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={marcados.has(item.anexoId)}
                          disabled={!pronto}
                          onChange={(e) => {
                            setMarcados((m) => {
                              const novo = new Set(m);
                              if (e.target.checked) novo.add(item.anexoId);
                              else novo.delete(item.anexoId);
                              return novo;
                            });
                          }}
                          aria-label={`Arquivar ${item.nomeOriginal}`}
                        />
                      </td>

                      <td className="max-w-[16rem] px-3 py-3">
                        <p className="break-words font-medium text-texto">{item.nomeOriginal}</p>
                        {item.bloqueio && (
                          <p className="mt-1 text-xs text-vermelho">{item.bloqueio.motivo}</p>
                        )}
                        {item.conflitos.map((cf, i) => (
                          <p key={i} className="mt-1 text-xs text-ambar">
                            {cf.motivo}
                          </p>
                        ))}
                        {item.possivelDuplicata && (
                          <p className="mt-1 text-xs text-texto-suave">
                            Já existe algo parecido: {item.possivelDuplicata.nome}
                          </p>
                        )}
                      </td>

                      <td className="px-3 py-3">
                        <div className="flex flex-col gap-1">
                          <Selo confianca={item.empresa.confianca} />
                          <select
                            value={c.empresaId ?? item.empresa.empresaId ?? ""}
                            onChange={(e) => corrigir(item.anexoId, "empresaId", e.target.value)}
                            className="w-44 rounded border border-borda bg-fundo-cartao px-1.5 py-1 text-xs"
                          >
                            <option value="">— escolher —</option>
                            {empresas.map((e) => (
                              <option key={e.id} value={e.id}>
                                {e.codigo} · {e.nome_fantasia ?? e.razao_social}
                                {e.pasta ? "" : " (sem pasta)"}
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>

                      <td className="px-3 py-3">
                        <div className="flex flex-col gap-1">
                          <Selo confianca={item.competencia.confianca} />
                          <input
                            type="month"
                            value={c.competencia ?? item.competencia.valor ?? ""}
                            onChange={(e) => corrigir(item.anexoId, "competencia", e.target.value)}
                            className="w-32 rounded border border-borda bg-fundo-cartao px-1.5 py-1 text-xs"
                          />
                        </div>
                      </td>

                      <td className="px-3 py-3">
                        <div className="flex flex-col gap-1">
                          <Selo confianca={item.tipoDocumento.confianca} />
                          <input
                            value={c.tipoDocumento ?? item.tipoDocumento.valor ?? ""}
                            onChange={(e) => corrigir(item.anexoId, "tipoDocumento", e.target.value)}
                            placeholder="EXTRATO"
                            className="w-32 rounded border border-borda bg-fundo-cartao px-1.5 py-1 text-xs"
                          />
                        </div>
                      </td>

                      <td className="px-3 py-3">
                        <div className="flex flex-col gap-1">
                          <Selo confianca={item.instituicao.confianca} />
                          <input
                            value={c.instituicao ?? item.instituicao.valor ?? ""}
                            onChange={(e) => corrigir(item.anexoId, "instituicao", e.target.value)}
                            placeholder="SICOOB"
                            className="w-28 rounded border border-borda bg-fundo-cartao px-1.5 py-1 text-xs"
                          />
                        </div>
                      </td>

                      <td className="px-3 py-3">
                        {item.caminhoSugerido ? (
                          <code className="block max-w-sm break-all text-xs text-texto-suave">
                            {item.caminhoSugerido}
                          </code>
                        ) : (
                          <span className="text-xs text-ambar">
                            falta: {item.camposFaltantes.join(", ") || "revisar"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void analisar()}
              disabled={analisando}
              className="rounded-[--raio] border border-borda-forte px-4 py-2 text-sm font-medium text-texto hover:bg-fundo-sutil disabled:opacity-50"
            >
              {analisando ? "Recalculando…" : "Recalcular com as correções"}
            </button>

            <button
              type="button"
              onClick={() => void confirmar()}
              disabled={confirmando || marcados.size === 0}
              className="rounded-[--raio] bg-azul px-4 py-2 text-sm font-medium text-white hover:bg-azul-hover disabled:opacity-50"
            >
              {confirmando
                ? "Enviando…"
                : `Arquivar ${marcados.size} arquivo${marcados.size === 1 ? "" : "s"}`}
            </button>

            {pendentes.length > 0 && (
              <span className="text-sm text-texto-suave">
                {pendentes.length} arquivo{pendentes.length > 1 ? "s" : ""} sem destino
                {pendentes.length > 1 ? " ficam" : " fica"} de fora até você completar.
              </span>
            )}
          </div>

          <p className="mt-2 text-xs text-texto-fraco">
            Corrigiu algo? Use “Recalcular” antes de arquivar — o destino é recalculado
            com o que você informou. Regras disponíveis: {regras.length}.
          </p>
        </section>
      )}
    </main>
  );
}
